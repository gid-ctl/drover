// Pricing for Bitflow's DLMM (bin-based) pools.
//
// Why this lives off-chain: a DLMM prices as
//
//   spot = initial-price * (1 + bin-step/10000) ^ active-bin-id
//
// which is fine in TypeScript and miserable in Clarity. The adapter therefore
// reports no on-chain spot, and the agent supplies a floor instead via the
// vault's `agent-min-out` - a value the vault will raise its own floor to, but
// never lower it to. Getting this wrong costs the agent a reverted transaction,
// never the owner's funds.
//
// Verified against the live sBTC/USDCx pool on 2026-08-17: initial-price
// 66194479380, bin-step 10, active-bin-id -52 gives 628.42 micro-USDCx per sat,
// i.e. ~$62,842/BTC, against ~$63,009 quoted elsewhere the same day.

/** Fixed-point scale of `initial-price`, and therefore of `spot`. */
export const PRICE_SCALE = 100_000_000n;

const BPS = 10_000n;

export interface DlmmPoolState {
  /** `initial-price` from the pool, scaled by PRICE_SCALE. */
  initialPrice: bigint;
  /** `bin-step` in basis points; each bin is this much apart in price. */
  binStep: bigint;
  /** `active-bin-id`; signed, negative below the initial price. */
  activeBinId: bigint;
}

const pow = (base: bigint, exp: number): bigint => {
  let acc = 1n;
  for (let i = 0; i < exp; i++) acc *= base;
  return acc;
};

/**
 * Spot price of the pool: y base-units per x base-unit, scaled by PRICE_SCALE.
 *
 * Computed as an exact rational rather than in floating point — the bin factor
 * is (10000 + bin-step)/10000, raised to the active bin id, and a float would
 * drift on pools whose active bin is far from origin.
 */
export function dlmmSpot({ initialPrice, binStep, activeBinId }: DlmmPoolState): bigint {
  const num = BPS + binStep;
  if (activeBinId >= 0n) {
    const n = Number(activeBinId);
    return (initialPrice * pow(num, n)) / pow(BPS, n);
  }
  const n = Number(-activeBinId);
  return (initialPrice * pow(BPS, n)) / pow(num, n);
}

/** Output the pool would give at spot, ignoring fees and price impact. */
export function expectedOut(amountIn: bigint, spot: bigint, sellIsX: boolean): bigint {
  return sellIsX ? (amountIn * spot) / PRICE_SCALE : (amountIn * PRICE_SCALE) / spot;
}

/**
 * The floor to hand the vault as `agent-min-out`.
 *
 * `toleranceBps` must cover both the venue's own swap fee and the price impact
 * the trade will cause by walking bins — set it wider than the fee alone, or
 * honest fills revert. This is the DLMM replacement for `maxSizeForImpact`:
 * on a constant-product pool the vault can verify spot itself and bound impact
 * in closed form; here the bound is carried by this floor plus the lease's
 * windowed cap, which limits how much can be traded at a bad price at all.
 */
export function dlmmMinOut(
  amountIn: bigint,
  pool: DlmmPoolState,
  sellIsX: boolean,
  toleranceBps: bigint
): bigint {
  if (toleranceBps >= BPS) return 0n; // tolerance of 100% = no agent floor
  const gross = expectedOut(amountIn, dlmmSpot(pool), sellIsX);
  return (gross * (BPS - toleranceBps)) / BPS;
}
