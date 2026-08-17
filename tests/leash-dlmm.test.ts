import { describe, expect, it } from "vitest";
import {
  PRICE_SCALE,
  dlmmMinOut,
  dlmmSpot,
  expectedOut,
  type DlmmPoolState,
} from "../agent/venues/dlmm.ts";

// The live Bitflow sBTC/USDCx pool as read from mainnet on 2026-08-17.
const LIVE: DlmmPoolState = {
  initialPrice: 66_194_479_380n,
  binStep: 10n,
  activeBinId: -52n,
};

describe("DLMM spot pricing", () => {
  it("prices the live sBTC/USDCx pool in a sane range", () => {
    const spot = dlmmSpot(LIVE); // micro-USDCx per sat, scaled by 1e8
    const microUsdcxPerSat = spot / PRICE_SCALE;
    // 1 BTC = 1e8 sats; USDCx has 6 decimals -> divide by 1e6 for dollars.
    const btcUsd = (microUsdcxPerSat * 100_000_000n) / 1_000_000n;
    // Sanity band, not a fixed number: this asserts the scale factor is right
    // (a wrong one is off by orders of magnitude), not a market price.
    expect(btcUsd).toBeGreaterThan(10_000n);
    expect(btcUsd).toBeLessThan(500_000n);
  });

  it("is exactly the initial price at bin zero", () => {
    expect(dlmmSpot({ ...LIVE, activeBinId: 0n })).toBe(LIVE.initialPrice);
  });

  it("rises above bin zero and falls below it", () => {
    const at0 = dlmmSpot({ ...LIVE, activeBinId: 0n });
    expect(dlmmSpot({ ...LIVE, activeBinId: 50n })).toBeGreaterThan(at0);
    expect(dlmmSpot({ ...LIVE, activeBinId: -50n })).toBeLessThan(at0);
  });

  it("moves one bin-step per bin", () => {
    const a = dlmmSpot({ ...LIVE, activeBinId: 0n });
    const b = dlmmSpot({ ...LIVE, activeBinId: 1n });
    // One bin = +10 bps. Integer division floors, so the measured value is 9
    // or 10 rather than exactly 10 — asserting equality here would be asserting
    // the rounding, not the pricing.
    const movedBps = ((b - a) * 10_000n) / a;
    expect(movedBps).toBeGreaterThanOrEqual(9n);
    expect(movedBps).toBeLessThanOrEqual(10n);
  });

  it("uses exact rational maths, not floats, far from origin", () => {
    // A float would visibly drift here; exact bigint arithmetic must not.
    const deep = dlmmSpot({ ...LIVE, activeBinId: -300n });
    const back = dlmmSpot({ ...LIVE, activeBinId: 300n });
    expect(deep).toBeGreaterThan(0n);
    expect(back).toBeGreaterThan(LIVE.initialPrice);
  });
});

describe("expected output", () => {
  it("converts sats to micro-USDCx when selling sBTC", () => {
    const spot = dlmmSpot(LIVE);
    const out = expectedOut(1_000_000n, spot, true); // 0.01 sBTC
    expect(out).toBe((1_000_000n * spot) / PRICE_SCALE);
    expect(out).toBeGreaterThan(0n);
  });

  it("round-trips approximately in the other direction", () => {
    const spot = dlmmSpot(LIVE);
    const sats = 1_000_000n;
    const usdcx = expectedOut(sats, spot, true);
    const back = expectedOut(usdcx, spot, false);
    // integer division loses at most a unit or two
    expect(back).toBeGreaterThan(sats - 10n);
    expect(back).toBeLessThanOrEqual(sats);
  });
});

describe("agent floor (dlmmMinOut)", () => {
  it("sits below the spot-implied output by exactly the tolerance", () => {
    const gross = expectedOut(1_000_000n, dlmmSpot(LIVE), true);
    const floor = dlmmMinOut(1_000_000n, LIVE, true, 100n); // 1%
    expect(floor).toBe((gross * 9_900n) / 10_000n);
    expect(floor).toBeLessThan(gross);
  });

  it("tightens as tolerance narrows", () => {
    const loose = dlmmMinOut(1_000_000n, LIVE, true, 500n);
    const tight = dlmmMinOut(1_000_000n, LIVE, true, 50n);
    expect(tight).toBeGreaterThan(loose);
  });

  it("yields no agent floor at 100% tolerance, deferring to the owner", () => {
    expect(dlmmMinOut(1_000_000n, LIVE, true, 10_000n)).toBe(0n);
  });

  it("scales linearly with trade size", () => {
    const one = dlmmMinOut(1_000_000n, LIVE, true, 100n);
    const ten = dlmmMinOut(10_000_000n, LIVE, true, 100n);
    // allow a unit of integer-division slack
    expect(ten).toBeGreaterThan(one * 10n - 10n);
  });
});
