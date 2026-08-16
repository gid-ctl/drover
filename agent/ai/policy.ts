import type { StrategyOptions, VaultState } from "../types.ts";
import { resolveProposal } from "./resolve.ts";
import {
  DEFAULT_BOUNDS,
  type ModelClient,
  type ProposalBounds,
  type ResolvedStrategy,
} from "./types.ts";

/**
 * Setup-time: turn a policy stated in plain English into strategy parameters.
 *
 * This is the AI surface that earns its place. "Keep me mostly in Bitcoin but
 * take some profit if it runs up hard" is a real thing people mean and a
 * miserable thing to express as a pair of integers - which is exactly the
 * translation a language model is good at, and exactly the step that otherwise
 * forces a non-technical owner to guess at basis points in a form field.
 */
export async function translatePolicy(
  model: ModelClient,
  policy: string,
  base: StrategyOptions,
  bounds: ProposalBounds = DEFAULT_BOUNDS
): Promise<ResolvedStrategy> {
  const prompt = [
    "The vault owner describes how they want their portfolio managed:",
    "",
    JSON.stringify(policy),
    "",
    `Their limits: target must be between ${bounds.minTargetBps} and ${bounds.maxTargetBps} bps,`,
    `band between ${bounds.minBandBps} and ${bounds.maxBandBps} bps.`,
    "Return the parameters that best express this policy.",
  ].join("\n");

  return resolveProposal(await model.propose(prompt), base, bounds);
}

/**
 * Per-tick: let the model adjust the target within owner-approved bounds, given
 * where the portfolio actually is.
 *
 * This is optional and off by default, and the honest reason is that its value
 * is unproven. What makes it safe to offer at all is that it cannot do damage:
 * the model moves portfolio *shape* inside limits the owner set, while every
 * loss-bounding parameter - venue, pair, cap, slippage floor, expiry - stays
 * where the owner and the chain put it. The worst case is a portfolio balanced
 * differently than you would have chosen, not a portfolio that leaves.
 */
export async function adviseOnState(
  model: ModelClient,
  state: VaultState,
  base: StrategyOptions,
  bounds: ProposalBounds = DEFAULT_BOUNDS
): Promise<ResolvedStrategy> {
  const spotPerSat = state.reserveA === 0n ? 0n : (state.reserveB * 1_000_000n) / state.reserveA;
  const sbtcValue = state.reserveA === 0n ? 0n : (state.sbtc * state.reserveB) / state.reserveA;
  const total = sbtcValue + state.musd;

  const prompt = [
    "Current vault state (all amounts in base units):",
    `- sBTC held: ${state.sbtc} sats, worth ${sbtcValue} micro-USD at venue spot`,
    `- stablecoin held: ${state.musd} micro-USD`,
    `- total portfolio value: ${total} micro-USD`,
    `- venue price: ${spotPerSat} micro-USD per million sats`,
    `- current target: ${base.targetBps} bps in sBTC, band ${base.bandBps} bps`,
    "",
    `Limits: target ${bounds.minTargetBps}-${bounds.maxTargetBps} bps, band ${bounds.minBandBps}-${bounds.maxBandBps} bps.`,
    "Confirm the current parameters or propose an adjustment, and say why in one sentence.",
  ].join("\n");

  return resolveProposal(await model.propose(prompt), base, bounds);
}
