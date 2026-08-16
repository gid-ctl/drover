import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  POOL,
  POOL_A,
  POOL_B,
  POOL_ERR_DEPOSIT_MISSING,
  POOL_ERR_NO_LIQUIDITY,
  POOL_ERR_OWNER_ONLY,
  POOL_ERR_SLIPPAGE,
  POOL_ERR_WRONG_TOKEN,
  ROGUE,
  SBTC,
  contractId,
  cpOut,
  mintSbtc,
  musdBalance,
  reserves,
  seedPool,
} from "./helpers.ts";

declare const simnet: any;

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const stranger = accounts.get("wallet_1")!;

const quote = (sell: string, amountIn: bigint) =>
  simnet.callReadOnlyFn(POOL, "quote", [Cl.principal(sell), Cl.uint(amountIn)], deployer);
const swap = (sell: string, amountIn: bigint, minOut: bigint, sender: string) =>
  simnet.callPublicFn(
    POOL,
    "swap",
    [Cl.principal(sell), Cl.uint(amountIn), Cl.uint(minOut)],
    sender
  );

describe("leash-pool", () => {
  it("cannot quote an empty pool", () => {
    expect(quote(SBTC, 1_000n).result).toBeErr(Cl.uint(POOL_ERR_NO_LIQUIDITY));
  });

  it("only the owner can provide liquidity", () => {
    expect(
      simnet.callPublicFn(POOL, "provide", [Cl.uint(1n), Cl.uint(1n)], stranger).result
    ).toBeErr(Cl.uint(POOL_ERR_OWNER_ONLY));
  });

  it("quotes pure spot in both directions and rejects foreign tokens", () => {
    seedPool();
    // 10 sBTC vs 650k mUSD: 1 sat -> 650 micro-mUSD, 650 micro-mUSD -> 1 sat
    expect(quote(SBTC, 1_000_000n).result).toBeOk(
      Cl.uint((1_000_000n * POOL_B) / POOL_A)
    );
    expect(quote(contractId("leash-asset"), 650n).result).toBeOk(Cl.uint(1n));
    expect(quote(contractId(ROGUE), 1_000n).result).toBeErr(
      Cl.uint(POOL_ERR_WRONG_TOKEN)
    );
  });

  it("refuses to swap when the sell amount was not pushed first", () => {
    seedPool();
    expect(swap(SBTC, 1_000_000n, 0n, deployer).result).toBeErr(
      Cl.uint(POOL_ERR_DEPOSIT_MISSING)
    );
  });

  it("swaps pushed funds along the constant-product curve", () => {
    seedPool();
    const amountIn = 1_000_000n;
    const { ra, rb } = reserves();
    const expected = cpOut(amountIn, ra, rb);

    mintSbtc(amountIn, deployer);
    simnet.callPublicFn(
      SBTC,
      "transfer",
      [Cl.uint(amountIn), Cl.principal(deployer), Cl.principal(contractId(POOL)), Cl.none()],
      deployer
    );
    // an unrealistic min-out is rejected...
    expect(swap(SBTC, amountIn, expected + 1n, deployer).result).toBeErr(
      Cl.uint(POOL_ERR_SLIPPAGE)
    );
    // ...an honest one fills exactly on the curve
    const before = musdBalance(deployer);
    expect(swap(SBTC, amountIn, expected, deployer).result).toBeOk(Cl.uint(expected));
    expect(musdBalance(deployer)).toBe(before + expected);
    const after = reserves();
    expect(after.ra).toBe(ra + amountIn);
    expect(after.rb).toBe(rb - expected);
  });
});
