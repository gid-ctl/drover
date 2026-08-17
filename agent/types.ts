// Drover - the reference trading agent that runs on a Leash.
//
// The agent is deliberately split into pure strategy (strategy.ts, no I/O) and
// a Driver that talks to a chain. Anything implementing Driver can host the
// same strategy: the simnet driver used by the test suite, the testnet driver
// used by the live demo, or a user's own bot.

/** Everything the strategy needs to make one decision. */
export interface VaultState {
  /** Owner's vault ledger, sBTC, in sats. */
  sbtc: bigint;
  /** Owner's vault ledger, mUSD, in micro-units. */
  musd: bigint;
  /** Venue reserves, used as the valuation price. */
  reserveA: bigint; // sBTC side, sats
  reserveB: bigint; // mUSD side, micro-units
  /** Notional still spendable this window, per direction (the leash). */
  allowanceSbtc: bigint;
  allowanceMusd: bigint;
}

export type SellSide = "sbtc" | "musd";

/** What ended up deciding the trade size. */
export type SizeLimit =
  /** The rebalance target itself - the trade lands exactly on target. */
  | "target"
  /** The owner's vault balance. */
  | "balance"
  /** The lease's remaining windowed allowance. */
  | "leash"
  /** Venue price impact against the lease's slippage tolerance. */
  | "impact";

/** A decision to trade. `amountIn` is already clamped to every limit. */
export interface TradePlan {
  sell: SellSide;
  amountIn: bigint;
  limitedBy: SizeLimit;
  /**
   * Floor the agent asks the vault to enforce, in buy-side units. The vault
   * takes the maximum of this and the owner's own floors, so this can only
   * tighten the trade. `0n` defers entirely to the owner's policy — correct
   * for venues the vault can price itself; venues it cannot price (bin-based
   * pools) should set it from a live quote.
   */
  minOut: bigint;
}

/** Why the strategy did what it did - surfaced for logs and for the UI feed. */
export interface Diagnosis {
  /** Portfolio value in mUSD micro-units, valued at venue spot. */
  totalValue: bigint;
  /** sBTC leg value in mUSD micro-units. */
  sbtcValue: bigint;
  /** Signed drift from target, in basis points of total value. */
  driftBps: bigint;
  /** Human-readable reason, e.g. "within band" or "sell sbtc to restore 50/50". */
  reason: string;
}

export interface Decision {
  plan: TradePlan | null;
  diagnosis: Diagnosis;
}

export interface StrategyOptions {
  /** Target share of portfolio value held in sBTC, in bps. 5000 = 50/50. */
  targetBps: bigint;
  /** No-trade band around the target, in bps of total value. */
  bandBps: bigint;
  /** Dust guard: never submit a trade smaller than this, in sell-side units. */
  minTradeSbtc: bigint;
  minTradeMusd: bigint;
  /**
   * The lease's own `max-slippage-bps`. The strategy sizes trades so the
   * venue's price impact stays inside it, rather than submitting transactions
   * the vault is guaranteed to revert.
   */
  maxImpactBps: bigint;
  /** The venue's swap fee in bps (0.3% for a constant-product pool). */
  venueFeeBps: bigint;
}

export const DEFAULT_STRATEGY: StrategyOptions = {
  targetBps: 5000n,
  bandBps: 300n, // 3%
  minTradeSbtc: 10_000n, // 0.0001 sBTC
  minTradeMusd: 1_000_000n, // 1 mUSD
  maxImpactBps: 100n, // matches the default lease tolerance
  venueFeeBps: 30n,
};

/** Result of submitting a trade; shape is driver-specific beyond `ok`. */
export interface TradeReceipt {
  ok: boolean;
  detail: string;
}

/** The only surface the agent needs from a chain. */
export interface Driver {
  readState(): Promise<VaultState>;
  submit(plan: TradePlan): Promise<TradeReceipt>;
}

/** One pass of the agent loop. */
export interface Tick {
  state: VaultState;
  decision: Decision;
  receipt: TradeReceipt | null;
  /**
   * What the AI advisor proposed this tick, and what the validator did with
   * it. `null` when no advisor is configured. Typed loosely here to keep the
   * core agent free of a dependency on the AI layer.
   */
  advice: { outcome: string; notes: string[] } | null;
}
