import { beforeEach, describe, expect, it } from "vitest";
import { tick } from "../agent/agent.ts";
import { SimnetDriver } from "../agent/drivers/simnet.ts";
import { decide, maxSizeForImpact } from "../agent/strategy.ts";
import { DEFAULT_STRATEGY, type VaultState } from "../agent/types.ts";
import {
  ASSET,
  CAP_A,
  DEPOSIT,
  POOL,
  POOL_A,
  SBTC,
  VAULT,
  WINDOW,
  contractId,
  fundAndDeposit,
  grantLease,
  ledger,
  seedPool,
} from "./helpers.ts";

declare const simnet: any;

const accounts = simnet.getAccounts();
const OWNER = accounts.get("wallet_1")!;
const AGENT = accounts.get("wallet_2")!;

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

// A balanced-at-spot portfolio: 1 sBTC valued at 650 uUSD/sat vs 65,000 mUSD.
const balanced: VaultState = {
  sbtc: 100_000_000n,
  musd: 65_000_000_000n,
  reserveA: 1_000_000_000n,
  reserveB: 650_000_000_000n,
  allowanceSbtc: 10_000_000n,
  allowanceMusd: 6_500_000_000n,
};

// Room for the strategy's own sizing to be the binding limit in unit tests.
const roomy = { ...DEFAULT_STRATEGY, maxImpactBps: 10_000n };

beforeEach(() => {
  seedPool();
});

describe("strategy (pure)", () => {
  it("holds when the portfolio is already on target", () => {
    const d = decide(balanced, DEFAULT_STRATEGY);
    expect(d.plan).toBeNull();
    expect(d.diagnosis.driftBps).toBe(0n);
    expect(d.diagnosis.reason).toContain("within band");
  });

  it("holds inside the no-trade band", () => {
    // ~1% overweight sBTC: inside the default 3% band
    const d = decide({ ...balanced, musd: 63_700_000_000n }, DEFAULT_STRATEGY);
    expect(d.plan).toBeNull();
    expect(d.diagnosis.reason).toContain("within band");
  });

  it("sells the overweight leg and sizes the trade to land on target", () => {
    // all-sBTC portfolio with every other limit lifted: must sell half its value
    const d = decide({ ...balanced, musd: 0n, allowanceSbtc: 1_000_000_000n }, roomy);
    expect(d.diagnosis.driftBps).toBe(5000n);
    expect(d.plan?.sell).toBe("sbtc");
    expect(d.plan?.amountIn).toBe(50_000_000n); // exactly half the sats
    expect(d.plan?.limitedBy).toBe("target");
  });

  it("buys the underweight leg in the other direction", () => {
    const d = decide({ ...balanced, sbtc: 0n }, roomy);
    expect(d.diagnosis.driftBps).toBe(-5000n);
    expect(d.plan?.sell).toBe("musd");
    expect(d.plan?.amountIn).toBe(6_500_000_000n); // clamped by the mUSD leash
    expect(d.plan?.limitedBy).toBe("leash");
  });

  it("clamps an oversized rebalance to the leash and says so", () => {
    const d = decide({ ...balanced, musd: 0n }, roomy);
    expect(d.plan?.amountIn).toBe(CAP_A); // wanted 50M sats, leash allows 10M
    expect(d.plan?.limitedBy).toBe("leash");
  });

  it("sizes below the venue impact the lease will tolerate", () => {
    const d = decide({ ...balanced, musd: 0n, allowanceSbtc: 1_000_000_000n }, DEFAULT_STRATEGY);
    expect(d.plan?.limitedBy).toBe("impact");
    expect(d.plan?.amountIn).toBe(maxSizeForImpact(balanced.reserveA, DEFAULT_STRATEGY));
    // ~0.7% of the pool: the 1% tolerance minus the venue's own 0.3% fee
    expect(d.plan!.amountIn * 1000n < balanced.reserveA * 8n).toBe(true);
  });

  it("refuses to trade when the tolerance is tighter than the venue fee", () => {
    const strict = { ...DEFAULT_STRATEGY, maxImpactBps: 20n }; // below the 30 bps fee
    expect(maxSizeForImpact(balanced.reserveA, strict)).toBe(0n);
    const d = decide({ ...balanced, musd: 0n }, strict);
    expect(d.plan).toBeNull();
  });

  it("holds when the window's allowance is exhausted", () => {
    const d = decide({ ...balanced, musd: 0n, allowanceSbtc: 0n }, DEFAULT_STRATEGY);
    expect(d.plan).toBeNull();
    expect(d.diagnosis.reason).toContain("no allowance");
  });

  it("holds on a dead venue instead of dividing by zero", () => {
    const d = decide({ ...balanced, reserveA: 0n, reserveB: 0n }, DEFAULT_STRATEGY);
    expect(d.plan).toBeNull();
    expect(d.diagnosis.reason).toContain("no liquidity");
  });
});

describe("Drover on a leash (end to end)", () => {
  it("rebalances a 100% sBTC vault toward 50/50 across windows", async () => {
    fundAndDeposit(OWNER); // 1 sBTC, no mUSD: maximally overweight
    grantLease(OWNER, AGENT);
    const d = driver();

    const first = await tick(d);
    expect(first.decision.diagnosis.driftBps).toBe(5000n);
    expect(first.decision.plan?.limitedBy).toBe("impact");
    expect(first.decision.plan?.amountIn).toBe(maxSizeForImpact(POOL_A, DEFAULT_STRATEGY));
    expect(first.receipt?.ok).toBe(true);
    expect(ledger(OWNER, SBTC)).toBe(DEPOSIT - first.decision.plan!.amountIn);
    expect(ledger(OWNER, contractId(ASSET))).toBeGreaterThan(0n);

    // Keep ticking inside the same window: the leash - not the strategy - is
    // what eventually stops it, and total spend never exceeds one cap.
    let spentThisWindow = first.decision.plan!.amountIn;
    let last = first;
    for (let i = 0; i < 10; i++) {
      last = await tick(d);
      if (last.decision.plan === null) break;
      expect(last.receipt?.ok).toBe(true);
      spentThisWindow += last.decision.plan.amountIn;
    }
    expect(last.decision.plan).toBeNull();
    expect(last.decision.diagnosis.reason).toContain("no allowance");
    expect(spentThisWindow).toBeLessThanOrEqual(CAP_A);

    // Let it work: one window at a time until it reaches the target band.
    let windows = 0;
    while (windows < 15) {
      simnet.mineEmptyBlocks(Number(WINDOW));
      last = await tick(d);
      windows++;
      if (last.decision.plan === null && last.decision.diagnosis.reason.includes("within band"))
        break;
      if (last.decision.plan !== null) expect(last.receipt?.ok).toBe(true);
    }

    expect(last.decision.plan).toBeNull();
    expect(last.decision.diagnosis.reason).toContain("within band");
    const drift = last.decision.diagnosis.driftBps;
    expect(drift <= DEFAULT_STRATEGY.bandBps && drift >= -DEFAULT_STRATEGY.bandBps).toBe(true);
    // Both legs are funded: it really did rebalance, not merely spend.
    expect(ledger(OWNER, SBTC)).toBeGreaterThan(0n);
    expect(ledger(OWNER, contractId(ASSET))).toBeGreaterThan(0n);
  });

  it("stops dead the moment the owner revokes", async () => {
    fundAndDeposit(OWNER);
    grantLease(OWNER, AGENT);
    const d = driver();
    expect((await tick(d)).receipt?.ok).toBe(true);
    const heldAfterFirstTrade = ledger(OWNER, SBTC);

    simnet.callPublicFn(VAULT, "revoke-lease", [], OWNER);
    simnet.mineEmptyBlocks(Number(WINDOW));

    // Revocation is visible to the agent immediately: its allowance reads zero,
    // so a well-behaved bot stands down without burning a transaction.
    const after = await tick(d);
    expect(after.state.allowanceSbtc).toBe(0n);
    expect(after.decision.plan).toBeNull();
    expect(after.receipt).toBeNull();

    // And a bot that ignores all of that still gets nowhere: the chain refuses.
    const forced = await d.submit({
      sell: "sbtc",
      amountIn: 1_000_000n,
      limitedBy: "target",
      minOut: 0n,
    });
    expect(forced.ok).toBe(false);
    expect(ledger(OWNER, SBTC)).toBe(heldAfterFirstTrade);
  });

  it("cannot trade once the lease expires", async () => {
    fundAndDeposit(OWNER);
    grantLease(OWNER, AGENT, { expiry: BigInt(simnet.blockHeight) + 3n });
    const d = driver();
    simnet.mineEmptyBlocks(5);
    const after = await tick(d);
    expect(after.receipt?.ok).toBe(false);
    expect(ledger(OWNER, SBTC)).toBe(DEPOSIT); // untouched
  });
});
