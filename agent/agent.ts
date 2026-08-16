import { adviseOnState } from "./ai/policy.ts";
import { DEFAULT_BOUNDS, type ModelClient, type ProposalBounds } from "./ai/types.ts";
import { decide } from "./strategy.ts";
import { DEFAULT_STRATEGY, type Driver, type StrategyOptions, type Tick } from "./types.ts";

/** Optional AI advisory, off unless a model client is supplied. */
export interface AdvisorConfig {
  model: ModelClient;
  bounds?: ProposalBounds;
}

/**
 * One pass: read chain state, decide, submit if there is something to do.
 *
 * The agent never inspects or asserts its own permissions - it simply tries,
 * and the vault is the authority on what is allowed. That is the point of the
 * design: a buggy or hostile strategy produces a reverted transaction, not a
 * loss beyond the owner's configured window cap.
 *
 * With an advisor configured, the model may adjust the target and band inside
 * the owner's bounds before the deterministic engine runs. The order matters:
 * the model proposes, `resolveProposal` clamps, `decide` sizes, and the chain
 * enforces. No layer trusts the one above it.
 */
export async function tick(
  driver: Driver,
  opts: StrategyOptions = DEFAULT_STRATEGY,
  advisor?: AdvisorConfig
): Promise<Tick> {
  const state = await driver.readState();

  let effective = opts;
  let advice: Tick["advice"] = null;
  if (advisor) {
    const resolved = await adviseOnState(
      advisor.model,
      state,
      opts,
      advisor.bounds ?? DEFAULT_BOUNDS
    );
    effective = resolved.options;
    advice = resolved;
  }

  const decision = decide(state, effective);
  if (decision.plan === null) {
    return { state, decision, receipt: null, advice };
  }
  const receipt = await driver.submit(decision.plan);
  return { state, decision, receipt, advice };
}

export function formatTick(t: Tick): string {
  const d = t.decision.diagnosis;
  const ai = t.advice ? ` | ai:${t.advice.outcome} ${t.advice.notes.at(-1) ?? ""}` : "";
  const head = `drift ${d.driftBps} bps | value ${d.totalValue} uUSD | ${d.reason}${ai}`;
  if (t.decision.plan === null) return `HOLD  ${head}`;
  const p = t.decision.plan;
  const status = t.receipt?.ok ? "ok" : `rejected: ${t.receipt?.detail}`;
  return `TRADE sell ${p.amountIn} ${p.sell} (limited by ${p.limitedBy}) -> ${status} | ${head}`;
}

/**
 * Run the agent on a fixed cadence. Intended for the reference bot process;
 * tests drive `tick` directly so they stay deterministic.
 */
export async function run(
  driver: Driver,
  {
    iterations = Infinity,
    intervalMs = 60_000,
    opts = DEFAULT_STRATEGY,
    advisor,
    log = console.log,
  }: {
    iterations?: number;
    intervalMs?: number;
    opts?: StrategyOptions;
    advisor?: AdvisorConfig;
    log?: (line: string) => void;
  } = {}
): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    try {
      log(formatTick(await tick(driver, opts, advisor)));
    } catch (err) {
      log(`ERROR ${(err as Error).message}`);
    }
    if (i + 1 < iterations) await new Promise((r) => setTimeout(r, intervalMs));
  }
}
