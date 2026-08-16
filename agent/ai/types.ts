// The AI layer of Drover.
//
// What the model does here is deliberately narrow. It does NOT predict prices,
// pick tops, or decide trade sizes - an LLM has no edge at any of those, and a
// bot that claims otherwise is the thing that gives "AI trading" its bad name.
//
// It does two things language models are genuinely good at:
//
//   1. Translate a policy stated in plain English ("keep me mostly in Bitcoin,
//      but take some profit if it runs up hard") into the concrete numeric
//      parameters the deterministic engine needs.
//   2. Explain, per tick, why a portfolio is where it is - and propose an
//      adjustment inside bounds the owner already approved.
//
// Everything it proposes passes through three layers of containment:
//
//   model proposes  ->  deterministic validator clamps  ->  chain enforces
//
// The validator (resolve.ts) is pure, total, and offline: a malformed, hostile,
// or absent model response degrades to the owner's baseline parameters rather
// than to undefined behaviour. The chain (leash-vault) then bounds whatever
// survives. The model is an input to the system, never an authority over it.

import type { StrategyOptions } from "../types.ts";

/** Numeric parameters the model is allowed to propose. */
export interface StrategyProposal {
  /** Target share of portfolio value in sBTC, in bps. */
  targetBps: number;
  /** No-trade band around the target, in bps. */
  bandBps: number;
  /** One sentence, in plain English, for the activity feed. */
  rationale: string;
}

/** Hard limits the owner sets once; the model can never propose outside them. */
export interface ProposalBounds {
  minTargetBps: bigint;
  maxTargetBps: bigint;
  minBandBps: bigint;
  maxBandBps: bigint;
}

/** Bounds wide enough for a policy translation, still refusing the absurd. */
export const DEFAULT_BOUNDS: ProposalBounds = {
  minTargetBps: 0n,
  maxTargetBps: 10_000n,
  minBandBps: 25n, // below this the bot churns on noise
  maxBandBps: 5_000n,
};

/** What `resolve` did with a proposal - surfaced in logs and the UI feed. */
export type ProposalOutcome =
  /** Applied as proposed. */
  | "accepted"
  /** Applied, but one or more fields were clamped to the owner's bounds. */
  | "clamped"
  /** Discarded; the owner's baseline parameters are used instead. */
  | "rejected";

export interface ResolvedStrategy {
  options: StrategyOptions;
  outcome: ProposalOutcome;
  /** Human-readable account of what happened, for the activity feed. */
  notes: string[];
}

/**
 * The model surface the AI layer needs. Narrow on purpose: one call, structured
 * output, no tools, no side effects. The live implementation talks to Claude;
 * the test suite passes a stub, so the whole AI path is exercised offline and
 * deterministically.
 */
export interface ModelClient {
  propose(prompt: string): Promise<StrategyProposal | null>;
}

/** JSON Schema for the model's structured output. */
export const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    targetBps: {
      type: "integer",
      description:
        "Target share of total portfolio value to hold in sBTC, in basis points. 5000 = 50%.",
    },
    bandBps: {
      type: "integer",
      description:
        "No-trade band around the target, in basis points of total value. The bot only trades when drift exceeds this. 300 = 3%.",
    },
    rationale: {
      type: "string",
      description:
        "One sentence explaining the choice, addressed to the vault owner. Plain English, no jargon.",
    },
  },
  required: ["targetBps", "bandBps", "rationale"],
  additionalProperties: false,
} as const;
