import Anthropic from "@anthropic-ai/sdk";
import {
  PROPOSAL_SCHEMA,
  type ModelClient,
  type StrategyProposal,
} from "./types.ts";

/**
 * The live model client: Claude, called once per proposal, with structured
 * output and no tools.
 *
 * Three deliberate choices:
 *
 *   - Structured outputs (`output_config.format`) rather than "reply with JSON"
 *     plus a parser. The schema is enforced, so the failure mode is a rejected
 *     response rather than text that looks like JSON and isn't.
 *   - Every failure path returns `null`, never throws. A model outage, a
 *     refusal, a timeout, and a malformed payload are all the same event to the
 *     caller: no proposal, fall back to the owner's baseline parameters. A
 *     trading bot must not stop trading because an API had a bad minute.
 *   - `stop_reason` is checked before the content is read, so a refusal is
 *     handled as a refusal instead of crashing on an empty content array.
 */
export interface ClaudeClientConfig {
  apiKey?: string;
  model?: string;
  /** Effort level; this is a small structured-extraction task. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

const SYSTEM = `You configure a Bitcoin portfolio-rebalancing bot on Stacks for a single vault owner.

The bot holds two assets: sBTC (Bitcoin on Stacks) and a US-dollar stablecoin. It keeps a target share of the portfolio's value in sBTC, and only trades when the actual share drifts outside a no-trade band. Your job is to turn the owner's stated policy into those two numbers.

- targetBps: the share of total value to hold in sBTC, in basis points (10000 = 100%). More Bitcoin exposure means a higher number.
- bandBps: how far the portfolio may drift from the target before the bot trades, in basis points. A tight band (100-200) trades often and tracks the target closely, paying more fees. A wide band (500-1500) trades rarely and tolerates drift.

You are not forecasting prices and you have no view on where Bitcoin is going. You are translating a stated preference into parameters. If the owner's policy is vague, choose conservative middle-ground values rather than extreme ones.

The rationale must be one plain sentence the owner can check your work against.`;

export class ClaudeClient implements ModelClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: NonNullable<ClaudeClientConfig["effort"]>;

  constructor(cfg: ClaudeClientConfig = {}) {
    this.client = new Anthropic(cfg.apiKey ? { apiKey: cfg.apiKey } : {});
    this.model = cfg.model ?? "claude-opus-5";
    this.effort = cfg.effort ?? "low";
  }

  async propose(prompt: string): Promise<StrategyProposal | null> {
    try {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 2048,
        system: SYSTEM,
        // A refusal is routed to a fallback model server-side rather than
        // returned as a dead end.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: {
          effort: this.effort,
          format: { type: "json_schema", schema: PROPOSAL_SCHEMA },
        },
        messages: [{ role: "user", content: prompt }],
      });

      // Check why generation stopped before touching content: on a refusal the
      // content array is empty or partial.
      if (response.stop_reason === "refusal") return null;

      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text.trim().length === 0) return null;

      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null) return null;
      // Shape is validated downstream by resolveProposal, which treats this
      // value as hostile input regardless of what the schema promised.
      return parsed as StrategyProposal;
    } catch {
      // Outage, timeout, bad payload - all the same to the caller: no proposal.
      return null;
    }
  }
}
