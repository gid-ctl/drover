import type { Decision, SizeLimit, StrategyOptions, VaultState } from "./types.ts";

const BPS = 10_000n;
/** Stands in for "no bound"; larger than any position this vault could hold. */
const UNLIMITED = 2n ** 127n;

const abs = (v: bigint): bigint => (v < 0n ? -v : v);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * Largest trade whose shortfall against spot stays inside `maxImpactBps` on a
 * constant-product venue.
 *
 * For reserves (rIn, rOut) and fee multiplier f = (10000 - venueFeeBps)/10000,
 * the realised output is  amountIn*f*rOut / (rIn + amountIn*f)  while spot
 * implies  amountIn*rOut/rIn. Their ratio is  f*rIn / (rIn + amountIn*f),
 * which must stay at or above (10000 - maxImpactBps)/10000. Solving for
 * amountIn gives the bound below.
 *
 * This is the same floor the vault enforces on-chain, computed ahead of time:
 * the agent declines to submit a trade the chain would reject, instead of
 * burning a transaction fee to learn the same thing.
 */
export function maxSizeForImpact(reserveIn: bigint, opts: StrategyOptions): bigint {
  const feeNum = BPS - opts.venueFeeBps;
  const tolerance = BPS - opts.maxImpactBps;
  // A tolerance of 100% disables the floor on-chain, so it disables sizing here.
  if (tolerance <= 0n) return UNLIMITED;
  const numerator = BPS * feeNum - tolerance * BPS;
  if (numerator <= 0n) return 0n; // tolerance tighter than the venue's own fee
  const bound = (reserveIn * numerator) / (tolerance * feeNum);
  // Headroom so integer rounding on-chain cannot tip a trade over the floor.
  return (bound * 99n) / 100n;
}

/**
 * Constant-mix rebalancing.
 *
 * Values both legs at the venue's spot price, compares the sBTC leg's share of
 * total value against the target, and - if the drift is outside the no-trade
 * band - sells the overweight leg by exactly the drift. That single trade lands
 * the portfolio on target, ignoring fees and price impact.
 *
 * The strategy is pure and total: no I/O, no clock, no randomness. Given the
 * same state it always returns the same decision, which is what makes the
 * agent's behaviour reviewable rather than merely observable.
 *
 * Four limits apply before a plan is returned - the rebalance target, the
 * owner's vault balance, the leash's remaining windowed allowance, and the
 * venue impact the lease will tolerate - and the plan reports which one bound
 * it. When the leash is the binding constraint the agent simply trades again
 * next window. The bot bends to the policy, never the other way round.
 */
export function decide(state: VaultState, opts: StrategyOptions): Decision {
  const { sbtc, musd, reserveA, reserveB } = state;

  if (reserveA === 0n || reserveB === 0n) {
    return {
      plan: null,
      diagnosis: {
        totalValue: 0n,
        sbtcValue: 0n,
        driftBps: 0n,
        reason: "venue has no liquidity",
      },
    };
  }

  // Value the sBTC leg in mUSD at venue spot (no impact, no fee).
  const sbtcValue = (sbtc * reserveB) / reserveA;
  const totalValue = sbtcValue + musd;

  if (totalValue === 0n) {
    return {
      plan: null,
      diagnosis: { totalValue: 0n, sbtcValue: 0n, driftBps: 0n, reason: "empty vault" },
    };
  }

  const targetValue = (totalValue * opts.targetBps) / BPS;
  const drift = sbtcValue - targetValue; // >0 means overweight sBTC
  const driftBps = (drift * BPS) / totalValue;

  if (abs(driftBps) <= opts.bandBps) {
    return {
      plan: null,
      diagnosis: {
        totalValue,
        sbtcValue,
        driftBps,
        reason: `within band (|${driftBps}| <= ${opts.bandBps} bps)`,
      },
    };
  }

  const overweight = drift > 0n;
  // Size that would land exactly on target, in sell-side units.
  const wanted = overweight ? (drift * reserveA) / reserveB : -drift;
  const balance = overweight ? sbtc : musd;
  const allowance = overweight ? state.allowanceSbtc : state.allowanceMusd;
  const impactCap = maxSizeForImpact(overweight ? reserveA : reserveB, opts);
  const dust = overweight ? opts.minTradeSbtc : opts.minTradeMusd;

  const limits: [SizeLimit, bigint][] = [
    ["target", wanted],
    ["balance", balance],
    ["leash", allowance],
    ["impact", impactCap],
  ];
  const amountIn = limits.reduce((acc, [, v]) => min(acc, v), wanted);
  // Report the tightest limit; ties resolve to the earlier, more informative one.
  const limitedBy = limits.find(([, v]) => v === amountIn)![0];

  if (amountIn < dust) {
    const reason =
      allowance === 0n
        ? `${overweight ? "overweight" : "underweight"} sBTC but no allowance left this window`
        : balance === 0n
          ? "nothing left to sell on the overweight leg"
          : "trade below dust threshold";
    return { plan: null, diagnosis: { totalValue, sbtcValue, driftBps, reason } };
  }

  return {
    plan: { sell: overweight ? "sbtc" : "musd", amountIn, limitedBy },
    diagnosis: {
      totalValue,
      sbtcValue,
      driftBps,
      reason: `${overweight ? "sell" : "buy"} sBTC to restore ${opts.targetBps} bps target`,
    },
  };
}
