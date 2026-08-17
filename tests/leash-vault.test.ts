import { Cl } from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ASSET,
  BPS,
  CAP_A,
  DEPOSIT,
  ERR_BPS_RANGE,
  ERR_CAP_EXCEEDED,
  ERR_EXPIRY_IN_PAST,
  ERR_FEE_TOO_HIGH,
  ERR_INSUFFICIENT_BALANCE,
  ERR_LEASE_EXPIRED,
  ERR_NO_LEASE,
  ERR_NOT_AGENT,
  ERR_NOT_AUTHORIZED,
  ERR_SAME_TOKEN,
  ERR_SLIPPAGE,
  ERR_WRONG_ADAPTER,
  ERR_WRONG_PAIR,
  ERR_ZERO_AMOUNT,
  ERR_ZERO_WINDOW,
  FEE_BPS,
  POOL_ERR_SLIPPAGE,
  ROGUE,
  SBTC,
  TRADE,
  VAULT,
  WINDOW,
  contractId,
  cpOut,
  fundAndDeposit,
  fundAndDepositMusd,
  grantLease,
  ledger,
  musdBalance,
  remainingAllowance,
  reserves,
  sbtcBalance,
  seedPool,
  trade,
} from "./helpers.ts";

declare const simnet: any;

// The simnet is re-initialised before every test, so each test builds its own
// world: seed the pool (beforeEach), fund a vault, grant a lease, act.
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const OWNER = accounts.get("wallet_1")!;
const AGENT = accounts.get("wallet_2")!;
const STRANGER = accounts.get("wallet_3")!;

const VAULT_P = () => contractId(VAULT);
const ASSET_P = () => contractId(ASSET);
const ROGUE_P = () => contractId(ROGUE);

beforeEach(() => {
  seedPool();
});

describe("deposits and withdrawals", () => {
  it("rejects a zero deposit", () => {
    expect(
      simnet.callPublicFn(VAULT, "deposit", [Cl.principal(SBTC), Cl.uint(0n)], OWNER).result
    ).toBeErr(Cl.uint(ERR_ZERO_AMOUNT));
  });

  it("credits the ledger and escrows sBTC on deposit", () => {
    const vaultBefore = sbtcBalance(VAULT_P());
    expect(fundAndDeposit(OWNER).result).toBeOk(Cl.bool(true));
    expect(sbtcBalance(VAULT_P())).toBe(vaultBefore + DEPOSIT);
    expect(ledger(OWNER, SBTC)).toBe(DEPOSIT);
  });

  it("returns funds on withdraw and rejects over-withdrawal", () => {
    fundAndDeposit(OWNER);
    const half = DEPOSIT / 2n;
    const walletBefore = sbtcBalance(OWNER);
    expect(
      simnet.callPublicFn(VAULT, "withdraw", [Cl.principal(SBTC), Cl.uint(half)], OWNER).result
    ).toBeOk(Cl.bool(true));
    expect(sbtcBalance(OWNER)).toBe(walletBefore + half);
    expect(ledger(OWNER, SBTC)).toBe(DEPOSIT - half);
    expect(
      simnet.callPublicFn(VAULT, "withdraw", [Cl.principal(SBTC), Cl.uint(DEPOSIT)], OWNER)
        .result
    ).toBeErr(Cl.uint(ERR_INSUFFICIENT_BALANCE));
  });

  it("keeps ledgers strictly per-owner: a stranger has nothing to withdraw", () => {
    fundAndDeposit(OWNER);
    expect(
      simnet.callPublicFn(VAULT, "withdraw", [Cl.principal(SBTC), Cl.uint(1n)], STRANGER).result
    ).toBeErr(Cl.uint(ERR_INSUFFICIENT_BALANCE));
  });
});

describe("lease admin", () => {
  it("validates lease parameters", () => {
    expect(grantLease(OWNER, AGENT, { tokenB: SBTC }).result).toBeErr(Cl.uint(ERR_SAME_TOKEN));
    expect(grantLease(OWNER, AGENT, { window: 0n }).result).toBeErr(Cl.uint(ERR_ZERO_WINDOW));
    expect(grantLease(OWNER, AGENT, { slippageBps: BPS + 1n }).result).toBeErr(
      Cl.uint(ERR_BPS_RANGE)
    );
    expect(grantLease(OWNER, AGENT, { expiry: BigInt(simnet.blockHeight) }).result).toBeErr(
      Cl.uint(ERR_EXPIRY_IN_PAST)
    );
  });

  it("cannot revoke a lease that does not exist", () => {
    expect(simnet.callPublicFn(VAULT, "revoke-lease", [], OWNER).result).toBeErr(
      Cl.uint(ERR_NO_LEASE)
    );
  });
});

describe("trading inside the leash", () => {
  it("executes a leased trade with exact accounting: proceeds, fee, reserves", () => {
    fundAndDeposit(OWNER);
    expect(grantLease(OWNER, AGENT).result).toBeOk(Cl.bool(true));

    const { ra, rb } = reserves();
    const received = cpOut(TRADE, ra, rb);
    const fee = (received * FEE_BPS) / BPS;
    const net = received - fee;
    const feeRecipientBefore = musdBalance(deployer);

    expect(trade(AGENT, OWNER, TRADE).result).toBeOk(Cl.uint(net));
    expect(ledger(OWNER, SBTC)).toBe(DEPOSIT - TRADE);
    expect(ledger(OWNER, ASSET_P())).toBe(net);
    expect(musdBalance(deployer)).toBe(feeRecipientBefore + fee);
    const after = reserves();
    expect(after.ra).toBe(ra + TRADE);
    expect(after.rb).toBe(rb - received);
  });

  it("rejects a caller who is not the leased agent", () => {
    fundAndDeposit(OWNER);
    grantLease(OWNER, AGENT);
    expect(trade(STRANGER, OWNER, TRADE).result).toBeErr(Cl.uint(ERR_NOT_AGENT));
  });

  it("rejects a venue the owner did not pin", () => {
    fundAndDeposit(OWNER);
    grantLease(OWNER, AGENT);
    expect(trade(AGENT, OWNER, TRADE, { adapter: ROGUE_P() }).result).toBeErr(
      Cl.uint(ERR_WRONG_ADAPTER)
    );
  });

  it("rejects a pair the owner did not pin", () => {
    fundAndDeposit(OWNER);
    grantLease(OWNER, AGENT);
    expect(trade(AGENT, OWNER, TRADE, { buy: SBTC }).result).toBeErr(Cl.uint(ERR_WRONG_PAIR));
  });

  it("rejects a zero trade", () => {
    fundAndDeposit(OWNER);
    grantLease(OWNER, AGENT);
    expect(trade(AGENT, OWNER, 0n).result).toBeErr(Cl.uint(ERR_ZERO_AMOUNT));
  });

  it("cannot trade more than the owner's vault balance", () => {
    grantLease(OWNER, AGENT, { capA: DEPOSIT * 100n });
    expect(trade(AGENT, OWNER, TRADE).result).toBeErr(Cl.uint(ERR_INSUFFICIENT_BALANCE));
  });

  it("enforces the notional cap per rolling window, then resets", () => {
    fundAndDeposit(OWNER);
    grantLease(OWNER, AGENT);
    const chunk = 6_000_000n; // two of these exceed CAP_A = 10M
    expect(trade(AGENT, OWNER, chunk).result.type).toBe("ok");
    expect(remainingAllowance(OWNER, SBTC)).toBe(CAP_A - chunk);
    expect(trade(AGENT, OWNER, chunk).result).toBeErr(Cl.uint(ERR_CAP_EXCEEDED));
    simnet.mineEmptyBlocks(Number(WINDOW));
    expect(remainingAllowance(OWNER, SBTC)).toBe(CAP_A);
    expect(trade(AGENT, OWNER, chunk).result.type).toBe("ok");
  });

  it("refuses to trade after the lease expires", () => {
    fundAndDeposit(OWNER);
    grantLease(OWNER, AGENT, { expiry: BigInt(simnet.blockHeight) + 2n });
    simnet.mineEmptyBlocks(3);
    expect(trade(AGENT, OWNER, TRADE).result).toBeErr(Cl.uint(ERR_LEASE_EXPIRED));
  });

  it("revocation is instant", () => {
    fundAndDeposit(OWNER);
    grantLease(OWNER, AGENT);
    expect(trade(AGENT, OWNER, TRADE).result.type).toBe("ok");
    expect(simnet.callPublicFn(VAULT, "revoke-lease", [], OWNER).result).toBeOk(Cl.bool(true));
    expect(trade(AGENT, OWNER, TRADE).result).toBeErr(Cl.uint(ERR_NO_LEASE));
  });

  it("aborts a fill that breaches the slippage floor against live spot", () => {
    fundAndDeposit(OWNER);
    grantLease(OWNER, AGENT, { capA: 10n * DEPOSIT, slippageBps: 10n }); // 0.1% tolerance
    // 1 sBTC into a 10 sBTC pool is ~9% price impact: far outside 0.1%
    expect(trade(AGENT, OWNER, DEPOSIT).result).toBeErr(Cl.uint(POOL_ERR_SLIPPAGE));
    expect(ledger(OWNER, SBTC)).toBe(DEPOSIT); // the whole transaction unwound
  });

  it("lets the agent raise the floor above the owner's policy", () => {
    fundAndDeposit(OWNER);
    grantLease(OWNER, AGENT);
    const { ra, rb } = reserves();
    const received = cpOut(TRADE, ra, rb);
    // Asking for one unit more than the venue can possibly deliver must fail,
    // even though the owner's own slippage policy would have allowed the fill.
    expect(trade(AGENT, OWNER, TRADE, { minOut: received + 1n }).result).toBeErr(
      Cl.uint(POOL_ERR_SLIPPAGE)
    );
    expect(ledger(OWNER, SBTC)).toBe(DEPOSIT); // unwound, nothing spent
  });

  it("never lets the agent lower the owner's floor", () => {
    fundAndDeposit(OWNER);
    // A tight owner policy: 0.1% tolerance against a ~9% impact trade.
    grantLease(OWNER, AGENT, { capA: 10n * DEPOSIT, slippageBps: 10n });
    // The agent asks for a floor of zero — i.e. "fill at any price". The
    // owner's floor still governs, so the trade is still refused.
    expect(trade(AGENT, OWNER, DEPOSIT, { minOut: 0n }).result).toBeErr(
      Cl.uint(POOL_ERR_SLIPPAGE)
    );
    expect(ledger(OWNER, SBTC)).toBe(DEPOSIT);
  });

  it("trades the reverse direction under its own cap", () => {
    const amount = 100_000_000n; // 100 mUSD
    fundAndDepositMusd(OWNER, amount);
    grantLease(OWNER, AGENT);
    const { ra, rb } = reserves();
    const received = cpOut(amount, rb, ra); // selling mUSD into the b-side
    const fee = (received * FEE_BPS) / BPS;
    const net = received - fee;
    expect(trade(AGENT, OWNER, amount, { sell: ASSET_P(), buy: SBTC }).result).toBeOk(
      Cl.uint(net)
    );
    expect(ledger(OWNER, ASSET_P())).toBe(0n);
    expect(ledger(OWNER, SBTC)).toBe(net);
  });
});

describe("adversarial venue (rogue adapter)", () => {
  it("min-price makes a rogue fill revert and unwind - the owner loses nothing", () => {
    fundAndDeposit(OWNER);
    // hard floor at the true spot price: 650 micro-mUSD per sat, scaled by 1e8
    grantLease(OWNER, AGENT, { adapter: ROGUE_P(), minPriceA: 650n * 100_000_000n });
    expect(trade(AGENT, OWNER, TRADE, { adapter: ROGUE_P() }).result).toBeErr(
      Cl.uint(ERR_SLIPPAGE)
    );
    expect(ledger(OWNER, SBTC)).toBe(DEPOSIT);
    expect(sbtcBalance(ROGUE_P())).toBe(0n); // push unwound with the revert
  });

  it("with all guards off, a rogue venue captures at most one windowed cap", () => {
    fundAndDeposit(OWNER);
    // worst case the owner can configure: no min-price, slippage check disabled
    grantLease(OWNER, AGENT, {
      adapter: ROGUE_P(),
      capA: TRADE,
      minPriceA: 0n,
      slippageBps: BPS,
    });
    expect(trade(AGENT, OWNER, TRADE, { adapter: ROGUE_P() }).result).toBeOk(Cl.uint(0n));
    expect(ledger(OWNER, SBTC)).toBe(DEPOSIT - TRADE); // lost: exactly one cap
    expect(sbtcBalance(ROGUE_P())).toBe(TRADE);
    // the bleed cannot continue within the window
    expect(trade(AGENT, OWNER, 1n, { adapter: ROGUE_P() }).result).toBeErr(
      Cl.uint(ERR_CAP_EXCEEDED)
    );
  });
});

describe("agents cannot exfiltrate", () => {
  it("an agent has no path to withdraw owner funds", () => {
    fundAndDeposit(OWNER);
    grantLease(OWNER, AGENT);
    // withdraw only ever debits the caller's own ledger and pays the caller
    expect(
      simnet.callPublicFn(VAULT, "withdraw", [Cl.principal(SBTC), Cl.uint(1n)], AGENT).result
    ).toBeErr(Cl.uint(ERR_INSUFFICIENT_BALANCE));
  });
});

describe("protocol fee admin", () => {
  it("fee controls are owner-gated and hard-capped at 1%", () => {
    expect(
      simnet.callPublicFn(VAULT, "set-fee-bps", [Cl.uint(50n)], STRANGER).result
    ).toBeErr(Cl.uint(ERR_NOT_AUTHORIZED));
    expect(
      simnet.callPublicFn(VAULT, "set-fee-recipient", [Cl.principal(STRANGER)], STRANGER).result
    ).toBeErr(Cl.uint(ERR_NOT_AUTHORIZED));
    expect(
      simnet.callPublicFn(VAULT, "set-fee-bps", [Cl.uint(101n)], deployer).result
    ).toBeErr(Cl.uint(ERR_FEE_TOO_HIGH));
  });

  it("a zero fee skips the fee transfer entirely", () => {
    simnet.callPublicFn(VAULT, "set-fee-bps", [Cl.uint(0n)], deployer);
    fundAndDeposit(OWNER);
    grantLease(OWNER, AGENT);
    const feeRecipientBefore = musdBalance(deployer);
    const { ra, rb } = reserves();
    const received = cpOut(TRADE, ra, rb);
    expect(trade(AGENT, OWNER, TRADE).result).toBeOk(Cl.uint(received)); // net == received
    expect(musdBalance(deployer)).toBe(feeRecipientBefore);
  });
});
