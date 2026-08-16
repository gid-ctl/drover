import { STACKS_TESTNET } from "@stacks/network";
import {
  Cl,
  PostConditionMode,
  broadcastTransaction,
  fetchCallReadOnlyFunction,
  getAddressFromPrivateKey,
  makeContractCall,
} from "@stacks/transactions";
import type { Driver, TradePlan, TradeReceipt, VaultState } from "../types.ts";

/**
 * Drives Drover against Stacks testnet (or mainnet, by swapping the network).
 *
 * The agent key used here is a hot key by necessity - it signs trades on a
 * cadence. That is precisely the risk Leash is built to absorb: this key has
 * no withdrawal authority, cannot exceed the owner's windowed cap, cannot
 * reach a venue or pair the owner did not pin, and stops working the moment
 * the owner revokes. Compromising it costs the owner at most one window's
 * notional at the owner's own slippage floor.
 */
export interface TestnetDriverConfig {
  /** Hex private key for the leased agent principal. */
  agentKey: string;
  /** Vault owner being managed. */
  owner: string;
  /** Deployer address holding the Leash contracts. */
  deployer: string;
  vaultName?: string;
  poolName?: string;
  /** Fully-qualified token principals. */
  sbtc: string;
  musd: string;
  apiUrl?: string;
  network?: typeof STACKS_TESTNET;
}

export class TestnetDriver implements Driver {
  private readonly network: typeof STACKS_TESTNET;
  private readonly vaultName: string;
  private readonly poolName: string;
  private readonly agentAddress: string;

  constructor(private readonly cfg: TestnetDriverConfig) {
    this.network = cfg.network ?? STACKS_TESTNET;
    this.vaultName = cfg.vaultName ?? "leash-vault";
    this.poolName = cfg.poolName ?? "leash-pool";
    this.agentAddress = getAddressFromPrivateKey(cfg.agentKey, this.network);
  }

  private async readOnly(contractName: string, fn: string, args: any[]): Promise<any> {
    return fetchCallReadOnlyFunction({
      contractAddress: this.cfg.deployer,
      contractName,
      functionName: fn,
      functionArgs: args,
      senderAddress: this.agentAddress,
      network: this.network,
      client: this.cfg.apiUrl ? { baseUrl: this.cfg.apiUrl } : undefined,
    });
  }

  async readState(): Promise<VaultState> {
    const { owner, sbtc, musd } = this.cfg;
    const uintOf = (cv: any): bigint => (cv.value ?? 0n) as bigint;

    const [sbtcBal, musdBal, allowA, allowB, reservesCv] = await Promise.all([
      this.readOnly(this.vaultName, "get-balance-of", [Cl.principal(owner), Cl.principal(sbtc)]),
      this.readOnly(this.vaultName, "get-balance-of", [Cl.principal(owner), Cl.principal(musd)]),
      this.readOnly(this.vaultName, "remaining-allowance", [
        Cl.principal(owner),
        Cl.principal(sbtc),
      ]),
      this.readOnly(this.vaultName, "remaining-allowance", [
        Cl.principal(owner),
        Cl.principal(musd),
      ]),
      this.readOnly(this.poolName, "get-reserves", []),
    ]);

    const t = (reservesCv as any).value ?? (reservesCv as any).data;
    return {
      sbtc: uintOf(sbtcBal),
      musd: uintOf(musdBal),
      reserveA: uintOf(t["reserve-a"]),
      reserveB: uintOf(t["reserve-b"]),
      allowanceSbtc: uintOf(allowA),
      allowanceMusd: uintOf(allowB),
    };
  }

  async submit(plan: TradePlan): Promise<TradeReceipt> {
    const { owner, deployer, sbtc, musd, agentKey } = this.cfg;
    const sellToken = plan.sell === "sbtc" ? sbtc : musd;
    const buyToken = plan.sell === "sbtc" ? musd : sbtc;

    const tx = await makeContractCall({
      contractAddress: deployer,
      contractName: this.vaultName,
      functionName: "trade",
      functionArgs: [
        Cl.principal(owner),
        Cl.principal(`${deployer}.${this.poolName}`),
        Cl.principal(sellToken),
        Cl.principal(buyToken),
        Cl.uint(plan.amountIn),
      ],
      senderKey: agentKey,
      network: this.network,
      // The moving assets belong to the vault contract, not to this signer, and
      // the vault enforces its own floor and caps on-chain before releasing
      // anything. Wallet-side post-conditions would add nothing here.
      postConditionMode: PostConditionMode.Allow,
      client: this.cfg.apiUrl ? { baseUrl: this.cfg.apiUrl } : undefined,
    });

    const res = await broadcastTransaction({
      transaction: tx,
      network: this.network,
      client: this.cfg.apiUrl ? { baseUrl: this.cfg.apiUrl } : undefined,
    });

    const rejected = (res as any).error !== undefined;
    return {
      ok: !rejected,
      detail: rejected
        ? `${(res as any).error}: ${(res as any).reason ?? ""}`
        : `txid ${(res as any).txid}`,
    };
  }
}
