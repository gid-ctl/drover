/**
 * Drover - runnable reference agent.
 *
 * Usage (testnet):
 *   LEASH_AGENT_KEY=<hex private key of the leased agent principal> \
 *   LEASH_OWNER=<vault owner address> \
 *   LEASH_DEPLOYER=<address holding the Leash contracts> \
 *   npx tsx agent/run.ts [--once] [--interval 60] [--target 5000] [--band 300]
 *
 * The agent key is a hot key by design. Under a leash it cannot withdraw,
 * cannot exceed the owner's per-window cap, cannot touch an unpinned venue or
 * pair, and dies on revoke - so the worst case of losing it is bounded and
 * the owner fixes it in one transaction.
 */
import { run, tick, formatTick, type AdvisorConfig } from "./agent.ts";
import { ClaudeClient } from "./ai/claude.ts";
import { translatePolicy } from "./ai/policy.ts";
import { TestnetDriver } from "./drivers/testnet.ts";
import { DEFAULT_STRATEGY, type StrategyOptions } from "./types.ts";

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required environment variable ${name}`);
    process.exit(1);
  }
  return v;
};

const main = async (): Promise<void> => {
  const deployer = required("LEASH_DEPLOYER");
  const driver = new TestnetDriver({
    agentKey: required("LEASH_AGENT_KEY"),
    owner: required("LEASH_OWNER"),
    deployer,
    sbtc: process.env.LEASH_SBTC ?? "ST1F7QA2MDF17S5D7HD7Y0FWZWYNVJ6WT3B0WFHR.sbtc-token",
    musd: process.env.LEASH_MUSD ?? `${deployer}.leash-asset`,
    apiUrl: process.env.LEASH_API_URL,
  });

  let opts: StrategyOptions = {
    ...DEFAULT_STRATEGY,
    targetBps: BigInt(arg("target", String(DEFAULT_STRATEGY.targetBps))!),
    bandBps: BigInt(arg("band", String(DEFAULT_STRATEGY.bandBps))!),
    maxImpactBps: BigInt(arg("max-impact", String(DEFAULT_STRATEGY.maxImpactBps))!),
  };

  // --policy "keep me mostly in bitcoin": Claude translates the sentence into
  // parameters once, at startup. The validator clamps whatever comes back.
  const policy = arg("policy");
  if (policy) {
    const resolved = await translatePolicy(new ClaudeClient(), policy, opts);
    opts = resolved.options;
    console.log(`policy: ${resolved.outcome} -> target ${opts.targetBps} bps, band ${opts.bandBps} bps`);
    for (const note of resolved.notes) console.log(`  ${note}`);
  }

  // --advisor: consult the model each tick as well. Off by default.
  const advisor: AdvisorConfig | undefined = process.argv.includes("--advisor")
    ? { model: new ClaudeClient() }
    : undefined;

  if (process.argv.includes("--once")) {
    console.log(formatTick(await tick(driver, opts, advisor)));
    return;
  }

  const intervalMs = Number(arg("interval", "60")) * 1000;
  console.log(`drover: ticking every ${intervalMs / 1000}s; ctrl-c to stop`);
  await run(driver, { intervalMs, opts, advisor });
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
