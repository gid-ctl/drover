import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import { SBTC, contractId } from "./helpers.ts";

declare const simnet: any;

// Bitflow's live DLMM market, pulled in as a Clarinet requirement so these run
// against the router/core/pool that are actually deployed on mainnet.
const BITFLOW = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const POOL = `${BITFLOW}.dlmm-pool-sbtc-usdcx-v-1-bps-10`;
const USDCX = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";
const ADAPTER = "leash-adapter-bitflow";

const ERR_WRONG_TOKEN = 400n;
const ERR_ZERO_AMOUNT = 401n;

const deployer = simnet.getAccounts().get("deployer")!;

// These read Bitflow's live mainnet state through Clarinet's remote-data
// forking, so they assert against the pool as it actually exists rather than a
// fixture. Network fetches are slow; hence the explicit timeouts.
const NET = 60_000;

describe("bitflow DLMM pool (live mainnet state via forking)", () => {
  const pool = () => {
    const res: any = simnet.callReadOnlyFn(POOL, "get-pool", [], deployer).result;
    return res.value?.data ?? res.value?.value ?? res.data;
  };

  it(
    "is a created, live pool",
    () => {
      const t = pool();
      expect(t["pool-created"].type).toBeDefined();
      expect(t["pool-name"].value).toBe("sBTC-USDCx-LP");
    },
    NET
  );

  it(
    "pairs canonical sBTC against USDCx",
    () => {
      const t = pool();
      expect(t["x-token"].value).toBe(SBTC);
      expect(t["y-token"].value).toBe(USDCX);
    },
    NET
  );

  it(
    "reports the bin geometry the adapter documents",
    () => {
      const t = pool();
      // bin-step 10 = 0.1% per bin; spot would be
      // initial-price * (1 + bin-step/1e4) ^ active-bin-id — the exponentiation
      // the adapter deliberately does not attempt on-chain.
      expect(t["bin-step"].value).toBe(10n);
      expect(t["active-bin-id"]).toBeDefined();
    },
    NET
  );
});

describe("leash-adapter-bitflow guards", () => {
  it("quotes only the pinned pair", () => {
    expect(
      simnet.callReadOnlyFn(ADAPTER, "quote", [Cl.principal(SBTC), Cl.uint(1000n)], deployer)
        .result
    ).toBeOk(Cl.uint(0n));
    expect(
      simnet.callReadOnlyFn(ADAPTER, "quote", [Cl.principal(USDCX), Cl.uint(1000n)], deployer)
        .result
    ).toBeOk(Cl.uint(0n));
  });

  it("rejects a token outside the pinned pair", () => {
    expect(
      simnet.callReadOnlyFn(
        ADAPTER,
        "quote",
        [Cl.principal(contractId("leash-asset")), Cl.uint(1000n)],
        deployer
      ).result
    ).toBeErr(Cl.uint(ERR_WRONG_TOKEN));
  });

  it("refuses a zero-amount swap", () => {
    expect(
      simnet.callPublicFn(
        ADAPTER,
        "swap",
        [Cl.principal(SBTC), Cl.uint(0n), Cl.uint(0n)],
        deployer
      ).result
    ).toBeErr(Cl.uint(ERR_ZERO_AMOUNT));
  });

  it("refuses to route an unpinned token", () => {
    expect(
      simnet.callPublicFn(
        ADAPTER,
        "swap",
        [Cl.principal(contractId("leash-asset")), Cl.uint(1000n), Cl.uint(0n)],
        deployer
      ).result
    ).toBeErr(Cl.uint(ERR_WRONG_TOKEN));
  });
});
