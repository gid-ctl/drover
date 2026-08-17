import { Cl } from "@stacks/transactions";
import type { Driver, TradePlan, TradeReceipt, VaultState } from "../types.ts";

/**
 * Drives Drover against a Clarinet simnet. Used by the test suite so the exact
 * strategy code that runs on testnet is the code under test - there is no
 * separate "test bot".
 */
export interface SimnetDriverConfig {
  /** The `simnet` global injected by vitest-environment-clarinet. */
  simnet: any;
  /** Vault owner whose portfolio is being managed. */
  owner: string;
  /** Principal the lease names as the agent; submits the trades. */
  agent: string;
  vault: string; // contract name, e.g. "leash-vault"
  pool: string; // adapter contract name
  sbtc: string; // fully-qualified sBTC principal
  musd: string; // fully-qualified mock-USD principal
}

export class SimnetDriver implements Driver {
  constructor(private readonly cfg: SimnetDriverConfig) {}

  private get adapterId(): string {
    return `${this.cfg.simnet.deployer}.${this.cfg.pool}`;
  }

  private uintOf(cv: any): bigint {
    return (cv.value ?? cv) as bigint;
  }

  async readState(): Promise<VaultState> {
    const { simnet, vault, pool, owner, sbtc, musd } = this.cfg;
    const reader = simnet.deployer;

    const ledger = (token: string): bigint =>
      this.uintOf(
        simnet.callReadOnlyFn(
          vault,
          "get-balance-of",
          [Cl.principal(owner), Cl.principal(token)],
          reader
        ).result
      );

    const allowance = (token: string): bigint =>
      this.uintOf(
        simnet.callReadOnlyFn(
          vault,
          "remaining-allowance",
          [Cl.principal(owner), Cl.principal(token)],
          reader
        ).result
      );

    const res = simnet.callReadOnlyFn(pool, "get-reserves", [], reader).result;
    const t = res.data ?? res.value;

    return {
      sbtc: ledger(sbtc),
      musd: ledger(musd),
      reserveA: t["reserve-a"].value as bigint,
      reserveB: t["reserve-b"].value as bigint,
      allowanceSbtc: allowance(sbtc),
      allowanceMusd: allowance(musd),
    };
  }

  async submit(plan: TradePlan): Promise<TradeReceipt> {
    const { simnet, vault, owner, agent, sbtc, musd } = this.cfg;
    const sellToken = plan.sell === "sbtc" ? sbtc : musd;
    const buyToken = plan.sell === "sbtc" ? musd : sbtc;

    const { result } = simnet.callPublicFn(
      vault,
      "trade",
      [
        Cl.principal(owner),
        Cl.principal(this.adapterId),
        Cl.principal(sellToken),
        Cl.principal(buyToken),
        Cl.uint(plan.amountIn),
        Cl.uint(plan.minOut),
      ],
      agent
    );

    const ok = result.type === "ok" || result.type === 7;
    return {
      ok,
      detail: ok ? `net ${result.value?.value ?? "?"}` : JSON.stringify(result.value ?? result),
    };
  }
}
