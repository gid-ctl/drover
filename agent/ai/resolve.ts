import type { StrategyOptions } from "../types.ts";
import {
  DEFAULT_BOUNDS,
  type ProposalBounds,
  type ResolvedStrategy,
  type StrategyProposal,
} from "./types.ts";

const clamp = (v: bigint, lo: bigint, hi: bigint): bigint =>
  v < lo ? lo : v > hi ? hi : v;

const isSafeInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && Number.isSafeInteger(v);

/**
 * Turn a model proposal into strategy parameters the engine will actually run.
 *
 * This is the containment layer between an LLM and money, so it is written to
 * be boring: pure, total, offline, and hostile to its input. Every failure mode
 * of a language model - malformed JSON, missing fields, absurd numbers, an
 * empty response, an outright refusal - resolves to the owner's baseline
 * parameters rather than to an exception or an undefined value.
 *
 * A proposal inside the owner's bounds is accepted. A proposal outside them is
 * clamped, not rejected: the model expressing "go all-in on Bitcoin" against a
 * 70% ceiling should produce 70%, with the clamp recorded in the notes for the
 * activity feed. Only structurally invalid proposals are discarded entirely.
 *
 * Note what is *not* adjustable here. The model can move the target and the
 * band - portfolio shape. It can never touch `maxImpactBps`, the venue caps,
 * the slippage floor, or anything else that bounds a loss: those come from the
 * owner and, ultimately, from the lease the chain enforces.
 */
export function resolveProposal(
  proposal: StrategyProposal | null,
  base: StrategyOptions,
  bounds: ProposalBounds = DEFAULT_BOUNDS
): ResolvedStrategy {
  if (proposal === null) {
    return {
      options: base,
      outcome: "rejected",
      notes: ["no proposal available; using the owner's baseline parameters"],
    };
  }

  if (!isSafeInt(proposal.targetBps) || !isSafeInt(proposal.bandBps)) {
    return {
      options: base,
      outcome: "rejected",
      notes: [
        "proposal was not a pair of whole numbers; using the owner's baseline parameters",
      ],
    };
  }

  const notes: string[] = [];
  const rawTarget = BigInt(proposal.targetBps);
  const rawBand = BigInt(proposal.bandBps);

  const targetBps = clamp(rawTarget, bounds.minTargetBps, bounds.maxTargetBps);
  const bandBps = clamp(rawBand, bounds.minBandBps, bounds.maxBandBps);

  if (targetBps !== rawTarget) {
    notes.push(`target ${rawTarget} bps clamped to ${targetBps} bps by your limits`);
  }
  if (bandBps !== rawBand) {
    notes.push(`band ${rawBand} bps clamped to ${bandBps} bps by your limits`);
  }

  const rationale =
    typeof proposal.rationale === "string" && proposal.rationale.trim().length > 0
      ? proposal.rationale.trim().slice(0, 280)
      : "(no rationale given)";
  notes.push(rationale);

  return {
    // maxImpactBps and the dust guards are deliberately not model-adjustable:
    // they bound losses, and only the owner moves them.
    options: { ...base, targetBps, bandBps },
    outcome: notes.some((n) => n.includes("clamped")) ? "clamped" : "accepted",
    notes,
  };
}
