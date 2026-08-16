import { Cl } from "@stacks/transactions";

// `simnet` is a global injected by vitest-environment-clarinet.
declare const simnet: any;

// Official sBTC contracts (simnet uses the mainnet address; Clarinet remaps on deploy).
export const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
export const SBTC_DEPOSIT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-deposit";
// Default signer principal in simnet = the address that deployed the sBTC contracts.
export const SBTC_DEPLOYER = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";

export const VAULT = "leash-vault";
export const POOL = "leash-pool";
export const ASSET = "leash-asset";
export const ROGUE = "leash-rogue-adapter";

// Vault error codes
export const ERR_ZERO_AMOUNT = 100n;
export const ERR_INSUFFICIENT_BALANCE = 101n;
export const ERR_NO_LEASE = 102n;
export const ERR_NOT_AGENT = 103n;
export const ERR_LEASE_EXPIRED = 104n;
export const ERR_WRONG_ADAPTER = 105n;
export const ERR_WRONG_PAIR = 106n;
export const ERR_CAP_EXCEEDED = 107n;
export const ERR_SLIPPAGE = 108n;
export const ERR_EXPIRY_IN_PAST = 109n;
export const ERR_ZERO_WINDOW = 110n;
export const ERR_NOT_AUTHORIZED = 111n;
export const ERR_FEE_TOO_HIGH = 112n;
export const ERR_BPS_RANGE = 113n;
export const ERR_SAME_TOKEN = 114n;

// Pool error codes
export const POOL_ERR_WRONG_TOKEN = 300n;
export const POOL_ERR_NO_LIQUIDITY = 301n;
export const POOL_ERR_SLIPPAGE = 302n;
export const POOL_ERR_DEPOSIT_MISSING = 303n;
export const POOL_ERR_OWNER_ONLY = 304n;

// Scales
export const BPS = 10_000n;
export const PRICE_SCALE = 100_000_000n;
export const FEE_BPS = 20n; // vault default

// Standard scenario amounts.
// Pool: 10 sBTC vs 650,000 mUSD -> spot 650 micro-mUSD per sat.
export const POOL_A = 1_000_000_000n;
export const POOL_B = 650_000_000_000n;
export const DEPOSIT = 100_000_000n; // 1 sBTC
export const TRADE = 1_000_000n; // 0.01 sBTC
export const CAP_A = 10_000_000n; // 0.1 sBTC per window
export const CAP_B = 6_500_000_000n; // 6,500 mUSD per window
export const WINDOW = 144n;
export const SLIPPAGE = 100n; // 1%

// Constant-product output with the pool's 0.3% input fee.
export const cpOut = (amountIn: bigint, rIn: bigint, rOut: bigint): bigint =>
  (amountIn * 997n * rOut) / (rIn * 1000n + amountIn * 997n);

// Clarity value unwrappers (tolerant to CV shape differences).
export const uintOk = (cv: any): bigint => cv.value.value as bigint; // (ok uint)
export const uintVal = (cv: any): bigint => cv.value as bigint; // uint
const tupleData = (cv: any): any => cv.data ?? cv.value;

export const contractId = (name: string): string => `${simnet.deployer}.${name}`;

// Read-only views (sender must be a standard principal, so use the deployer)
export const sbtcBalance = (who: string): bigint =>
  uintOk(
    simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(who)], simnet.deployer).result
  );
export const musdBalance = (who: string): bigint =>
  uintOk(
    simnet.callReadOnlyFn(ASSET, "get-balance", [Cl.principal(who)], simnet.deployer).result
  );
export const ledger = (owner: string, token: string): bigint =>
  uintVal(
    simnet.callReadOnlyFn(
      VAULT,
      "get-balance-of",
      [Cl.principal(owner), Cl.principal(token)],
      simnet.deployer
    ).result
  );
export const reserves = (): { ra: bigint; rb: bigint } => {
  const t = tupleData(simnet.callReadOnlyFn(POOL, "get-reserves", [], simnet.deployer).result);
  return { ra: t["reserve-a"].value as bigint, rb: t["reserve-b"].value as bigint };
};
export const remainingAllowance = (owner: string, token: string): bigint =>
  uintVal(
    simnet.callReadOnlyFn(
      VAULT,
      "remaining-allowance",
      [Cl.principal(owner), Cl.principal(token)],
      simnet.deployer
    ).result
  );

// Mint mUSD to a wallet and deposit it into the vault.
export const fundAndDepositMusd = (owner: string, amount: bigint) => {
  mintMusd(amount, owner);
  return simnet.callPublicFn(
    VAULT,
    "deposit",
    [Cl.principal(contractId(ASSET)), Cl.uint(amount)],
    owner
  );
};

// --- sBTC minting -----------------------------------------------------------
// sBTC can only be minted by the protocol via a signer-authorized deposit. We
// replicate the real path: read a past burn-block header, then have the default
// signer complete a (synthetic) deposit. Each call uses a unique txid so the
// registry's replay protection is satisfied.
let depositNonce = 0;
const uniqueBuff32 = (): Uint8Array => {
  depositNonce++;
  const b = new Uint8Array(32);
  b[28] = (depositNonce >>> 24) & 0xff;
  b[29] = (depositNonce >>> 16) & 0xff;
  b[30] = (depositNonce >>> 8) & 0xff;
  b[31] = depositNonce & 0xff;
  return b;
};

const burnHeaderCV = (height: number): any | null => {
  const res = simnet.callReadOnlyFn(
    SBTC_DEPOSIT,
    "get-burn-header",
    [Cl.uint(height)],
    SBTC_DEPLOYER
  ).result as any;
  return res.value ?? null; // OptionalSome -> BufferCV, OptionalNone -> undefined
};

export const mintSbtc = (amount: bigint, recipient: string) => {
  let height = simnet.burnBlockHeight - 1;
  let header: any = null;
  while (height > 0 && header === null) {
    header = burnHeaderCV(height);
    if (header === null) height--;
  }
  if (header === null) throw new Error("no usable burn-block header for sBTC mint");
  return simnet.callPublicFn(
    SBTC_DEPOSIT,
    "complete-deposit-wrapper",
    [
      Cl.buffer(uniqueBuff32()), // txid (unique -> no replay)
      Cl.uint(0), // vout-index
      Cl.uint(amount),
      Cl.principal(recipient),
      header, // burn-hash (pass the chain value straight through)
      Cl.uint(height),
      Cl.buffer(uniqueBuff32()), // sweep-txid
    ],
    SBTC_DEPLOYER
  );
};

export const mintMusd = (amount: bigint, recipient: string) =>
  simnet.callPublicFn(
    ASSET,
    "mint",
    [Cl.uint(amount), Cl.principal(recipient)],
    simnet.deployer
  );

// Seed the demo pool with the standard reserves (deployer-owned liquidity).
export const seedPool = () => {
  mintSbtc(POOL_A, simnet.deployer);
  mintMusd(POOL_B, simnet.deployer);
  const res = simnet.callPublicFn(
    POOL,
    "provide",
    [Cl.uint(POOL_A), Cl.uint(POOL_B)],
    simnet.deployer
  );
  if (res.result.type !== "ok" && res.result.type !== 7)
    throw new Error(`pool seed failed: ${JSON.stringify(res.result)}`);
};

// Fund a wallet with sBTC and deposit it into the vault.
export const fundAndDeposit = (owner: string, amount: bigint = DEPOSIT) => {
  mintSbtc(amount, owner);
  return simnet.callPublicFn(
    VAULT,
    "deposit",
    [Cl.principal(SBTC), Cl.uint(amount)],
    owner
  );
};

// Grant a lease with sane defaults; override any field per test.
export interface LeaseOpts {
  agent?: string;
  adapter?: string;
  tokenA?: string;
  tokenB?: string;
  capA?: bigint;
  capB?: bigint;
  minPriceA?: bigint;
  minPriceB?: bigint;
  window?: bigint;
  slippageBps?: bigint;
  expiry?: bigint;
}

export const grantLease = (owner: string, agent: string, opts: LeaseOpts = {}) =>
  simnet.callPublicFn(
    VAULT,
    "grant-lease",
    [
      Cl.principal(opts.agent ?? agent),
      Cl.principal(opts.adapter ?? contractId(POOL)),
      Cl.principal(opts.tokenA ?? SBTC),
      Cl.principal(opts.tokenB ?? contractId(ASSET)),
      Cl.uint(opts.capA ?? CAP_A),
      Cl.uint(opts.capB ?? CAP_B),
      Cl.uint(opts.minPriceA ?? 0n),
      Cl.uint(opts.minPriceB ?? 0n),
      Cl.uint(opts.window ?? WINDOW),
      Cl.uint(opts.slippageBps ?? SLIPPAGE),
      Cl.uint(opts.expiry ?? BigInt(simnet.blockHeight) + 10_000n),
    ],
    owner
  );

// Agent trades on an owner's vault (defaults: sell sBTC for mUSD on the pool).
export const trade = (
  agent: string,
  owner: string,
  amount: bigint,
  opts: { adapter?: string; sell?: string; buy?: string } = {}
) =>
  simnet.callPublicFn(
    VAULT,
    "trade",
    [
      Cl.principal(owner),
      Cl.principal(opts.adapter ?? contractId(POOL)),
      Cl.principal(opts.sell ?? SBTC),
      Cl.principal(opts.buy ?? contractId(ASSET)),
      Cl.uint(amount),
    ],
    agent
  );
