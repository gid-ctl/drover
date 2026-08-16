import { beforeEach, describe, expect, it } from "vitest";
import { tick } from "../agent/agent.ts";
import { SimnetDriver } from "../agent/drivers/simnet.ts";
import { adviseOnState, translatePolicy } from "../agent/ai/policy.ts";
import { resolveProposal } from "../agent/ai/resolve.ts";
import {
  DEFAULT_BOUNDS,
  type ModelClient,
  type StrategyProposal,
} from "../agent/ai/types.ts";
import { DEFAULT_STRATEGY, type VaultState } from "../agent/types.ts";
import {
  ASSET,
  DEPOSIT,
  POOL,
  SBTC,
  VAULT,
  contractId,
  fundAndDeposit,
  grantLease,
  ledger,
  seedPool,
} from "./helpers.ts";

declare const simnet: any;

// The model is stubbed throughout: the AI path is exercised offline and
// deterministically, and the suite never needs an API key or a network.
const stub = (reply: unknown, capture?: { prompt?: string }): ModelClient => ({
  async propose(prompt: string) {
    if (capture) capture.prompt = prompt;
    return reply as StrategyProposal | null;
  },
});

const throwing: ModelClient = {
  async propose() {
    throw new Error("model unavailable");
  },
};

const accounts = simnet.getAccounts();
const OWNER = accounts.get("wallet_1")!;
const AGENT = accounts.get("wallet_2")!;

const balanced: VaultState = {
  sbtc: 100_000_000n,
  musd: 65_000_000_000n,
  reserveA: 1_000_000_000n,
  reserveB: 650_000_000_000n,
  allowanceSbtc: 10_000_000n,
  allowanceMusd: 6_500_000_000n,
};

describe("proposal validator (the containment layer)", () => {
  it("accepts a well-formed proposal inside the owner's bounds", () => {
    const r = resolveProposal(
      { targetBps: 7000, bandBps: 400, rationale: "Mostly Bitcoin, as you asked." },
      DEFAULT_STRATEGY
    );
    expect(r.outcome).toBe("accepted");
    expect(r.options.targetBps).toBe(7000n);
    expect(r.options.bandBps).toBe(400n);
    expect(r.notes.at(-1)).toContain("Mostly Bitcoin");
  });

  it("clamps an out-of-bounds proposal instead of discarding it", () => {
    const bounds = { ...DEFAULT_BOUNDS, maxTargetBps: 7000n };
    const r = resolveProposal(
      { targetBps: 10_000, bandBps: 400, rationale: "All in." },
      DEFAULT_STRATEGY,
      bounds
    );
    expect(r.outcome).toBe("clamped");
    expect(r.options.targetBps).toBe(7000n);
    expect(r.notes.some((n) => n.includes("clamped"))).toBe(true);
  });

  it("clamps a band below the churn floor", () => {
    const r = resolveProposal(
      { targetBps: 5000, bandBps: 1, rationale: "Track it tightly." },
      DEFAULT_STRATEGY
    );
    expect(r.options.bandBps).toBe(DEFAULT_BOUNDS.minBandBps);
    expect(r.outcome).toBe("clamped");
  });

  it("falls back to the baseline when there is no proposal", () => {
    const r = resolveProposal(null, DEFAULT_STRATEGY);
    expect(r.outcome).toBe("rejected");
    expect(r.options).toEqual(DEFAULT_STRATEGY);
  });

  it.each([
    ["non-numeric fields", { targetBps: "lots", bandBps: 300, rationale: "x" }],
    ["fractional bps", { targetBps: 50.5, bandBps: 300, rationale: "x" }],
    ["NaN", { targetBps: NaN, bandBps: 300, rationale: "x" }],
    ["Infinity", { targetBps: Infinity, bandBps: 300, rationale: "x" }],
    ["missing fields", { rationale: "x" }],
    ["an empty object", {}],
  ])("rejects %s and keeps the baseline", (_label, payload) => {
    const r = resolveProposal(payload as any, DEFAULT_STRATEGY);
    expect(r.outcome).toBe("rejected");
    expect(r.options).toEqual(DEFAULT_STRATEGY);
  });

  it("never lets the model touch loss-bounding parameters", () => {
    const r = resolveProposal(
      {
        targetBps: 6000,
        bandBps: 300,
        rationale: "x",
        // a hostile model trying to widen its own leash
        maxImpactBps: 10_000,
        minTradeSbtc: 0,
        venueFeeBps: 0,
      } as any,
      DEFAULT_STRATEGY
    );
    expect(r.options.maxImpactBps).toBe(DEFAULT_STRATEGY.maxImpactBps);
    expect(r.options.minTradeSbtc).toBe(DEFAULT_STRATEGY.minTradeSbtc);
    expect(r.options.venueFeeBps).toBe(DEFAULT_STRATEGY.venueFeeBps);
  });

  it("truncates an overlong rationale rather than logging a wall of text", () => {
    const r = resolveProposal(
      { targetBps: 5000, bandBps: 300, rationale: "x".repeat(5000) },
      DEFAULT_STRATEGY
    );
    expect(r.notes.at(-1)!.length).toBeLessThanOrEqual(280);
  });
});

describe("policy translation", () => {
  it("turns a plain-English policy into parameters and passes the policy through", async () => {
    const capture: { prompt?: string } = {};
    const r = await translatePolicy(
      stub({ targetBps: 8000, bandBps: 800, rationale: "Heavy Bitcoin, rarely trading." }, capture),
      "keep me mostly in bitcoin, don't fuss over small moves",
      DEFAULT_STRATEGY
    );
    expect(r.options.targetBps).toBe(8000n);
    expect(r.options.bandBps).toBe(800n);
    expect(capture.prompt).toContain("mostly in bitcoin");
    expect(capture.prompt).toContain(String(DEFAULT_BOUNDS.maxTargetBps));
  });

  it("survives a model that throws", async () => {
    const r = await translatePolicy(throwing, "anything", DEFAULT_STRATEGY).catch(
      () => null
    );
    // translatePolicy does not swallow transport errors itself - the live
    // client does. A throwing stub therefore surfaces, which is the honest
    // behaviour for a caller that supplied its own client.
    expect(r).toBeNull();
  });

  it("describes real portfolio state to the advisor", async () => {
    const capture: { prompt?: string } = {};
    await adviseOnState(
      stub({ targetBps: 5000, bandBps: 300, rationale: "On target." }, capture),
      balanced,
      DEFAULT_STRATEGY
    );
    expect(capture.prompt).toContain("total portfolio value");
    expect(capture.prompt).toContain(String(balanced.sbtc));
  });
});

describe("AI-driven agent, end to end", () => {
  beforeEach(() => {
    seedPool();
  });

  const driver = () =>
    new SimnetDriver({
      simnet,
      owner: OWNER,
      agent: AGENT,
      vault: VAULT,
      pool: POOL,
      sbtc: SBTC,
      musd: contractId(ASSET),
    });

  it("an AI-set target changes what the bot actually does on-chain", async () => {
    fundAndDeposit(OWNER); // 100% sBTC
    grantLease(OWNER, AGENT);

    // The model says "stay all in Bitcoin" - so a 100% sBTC vault is on target
    // and the correct action is to do nothing.
    const holdTick = await tick(driver(), DEFAULT_STRATEGY, {
      model: stub({ targetBps: 10_000, bandBps: 300, rationale: "Stay all in." }),
    });
    expect(holdTick.advice?.outcome).toBe("accepted");
    expect(holdTick.decision.plan).toBeNull();
    expect(holdTick.receipt).toBeNull();
    expect(ledger(OWNER, SBTC)).toBe(DEPOSIT);

    // Same vault, same code, different AI-set target: now it rebalances.
    const tradeTick = await tick(driver(), DEFAULT_STRATEGY, {
      model: stub({ targetBps: 5000, bandBps: 300, rationale: "Take half off." }),
    });
    expect(tradeTick.decision.plan?.sell).toBe("sbtc");
    expect(tradeTick.receipt?.ok).toBe(true);
    expect(ledger(OWNER, SBTC)).toBeLessThan(DEPOSIT);
  });

  it("a hostile proposal cannot widen the leash - the chain still bounds it", async () => {
    fundAndDeposit(OWNER);
    grantLease(OWNER, AGENT);

    // A model doing its worst: sell everything, ignore slippage, trade on noise.
    const t = await tick(driver(), DEFAULT_STRATEGY, {
      model: stub({
        targetBps: 0,
        bandBps: 0,
        rationale: "Liquidate.",
        maxImpactBps: 10_000,
        capA: 999_999_999,
      } as any),
    });

    // The target moves (that is the owner's own bound), but sizing does not:
    // the trade is still limited by venue impact, and the vault still holds
    // the overwhelming majority of its Bitcoin after one tick.
    expect(t.decision.plan?.limitedBy).toBe("impact");
    expect(t.receipt?.ok).toBe(true);
    const sold = DEPOSIT - ledger(OWNER, SBTC);
    expect(sold * 10n).toBeLessThan(DEPOSIT); // under 10% of the position
  });

  it("a dead model degrades to the owner's baseline rather than stopping the bot", async () => {
    fundAndDeposit(OWNER);
    grantLease(OWNER, AGENT);

    const t = await tick(driver(), DEFAULT_STRATEGY, { model: stub(null) });
    expect(t.advice?.outcome).toBe("rejected");
    // Baseline is 50/50, so a 100%-sBTC vault still rebalances: the bot keeps
    // working without the model.
    expect(t.decision.plan?.sell).toBe("sbtc");
    expect(t.receipt?.ok).toBe(true);
  });

  it("runs unchanged with no advisor configured", async () => {
    fundAndDeposit(OWNER);
    grantLease(OWNER, AGENT);
    const t = await tick(driver(), DEFAULT_STRATEGY);
    expect(t.advice).toBeNull();
    expect(t.receipt?.ok).toBe(true);
  });
});
