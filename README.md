# Drover on a Leash

**An automated Bitcoin portfolio bot you can hire without giving it your keys.**

Two pieces:

- **Drover** (`agent/`) — an autonomous portfolio-management bot. It keeps a
  Bitcoin-denominated portfolio on target by trading on a Stacks DEX.
- **Leash** (`contracts/`) — the vault Drover runs inside, and the reason a
  stranger can safely run it on their own money.

An owner deposits SIP-010 assets (sBTC first among them) and grants the bot a
narrow, instantly revocable **trading lease**: one venue, one token pair, a
notional cap per rolling block window in each direction, a slippage ceiling,
an optional hard limit price, and an expiry. Inside the leash the agent can
trade. It can never withdraw, never exceed a cap, never route to a venue or
pair the owner did not pin, and it stops the block the owner revokes. The
chain enforces all of it — not a server, not a promise.

This answers the Stacks Endowment RFP *"Trading Bots powered by AI"* together
with the question that kills every other version of it: why would anyone let a
bot near their money?

## How it works

```text
owner                         agent                        venue (adapter)
  │ deposit sBTC / mUSD         │                             │
  │ grant-lease ───────────────▶│                             │
  │   {agent, venue, pair,      │  trade(owner, ...) ────────▶│
  │    caps/window, slippage,   │    1. policy checks         │
  │    min-price, expiry}       │    2. quote → floor         │
  │                             │    3. push exact amount ───▶│
  │                             │    4. adapter.swap ────────▶│
  │                             │    5. measure proceeds ◀────│
  │ withdraw / revoke any block │    6. floor not met? REVERT │
```

A trade only ever means: *sell exactly `amount-in` on the pinned venue,
receive at least the floor*. The floor is the greater of

- the venue's own spot quote minus the owner's slippage tolerance, and
- the owner's hard `min-price` (buy-units per sell-unit, scaled 1e8).

Proceeds are **measured**, not trusted: the vault reads its own balance
before and after the swap. A venue that under-delivers or lies produces a
reverted transaction, unwinding the pushed funds.

## The security design

The vault **never delegates its authority**. There is no `as-contract` frame
around venue code. The vault pushes tokens to the adapter with a plain
transfer it authors itself, and everything the venue does happens with the
venue's own authority only. Consequences, each proven in the test suite:

| Property | Enforced by |
|---|---|
| Agent cannot withdraw | `withdraw` only pays `tx-sender` from `tx-sender`'s own ledger |
| Agent cannot overtrade | per-direction notional cap on a rolling block window |
| Agent cannot re-route | venue adapter and token pair pinned in the lease |
| Venue cannot steal the vault | it only ever receives exactly `amount-in`, nothing more |
| Venue cannot under-fill | measured-proceeds floor; breach reverts the whole transaction |
| Rogue venue worst case | bounded to one windowed cap per window (test-proven), and only if the owner disables both price guards |
| Owner exit | `withdraw` and `revoke-lease` work at any block, no notice, no agent veto |
| Protocol admin | fee switch only, hard-capped at 1%; no admin path touches user funds |

Trust boundary, stated plainly: Leash cannot make an agent smart. Losses
from bad strategy on an honest venue are what delegation means. What Leash
removes is custody risk — theft by the agent, and (with `min-price` set)
under-priced fills by the venue.

## Contracts

| Contract | Purpose |
|---|---|
| `leash-vault` | Ledger, leases, policy engine, the `trade` path, fee switch |
| `leash-adapter-trait` | Two-function venue interface: `quote`, `swap` (push-based) |
| `leash-pool` | Self-contained constant-product sBTC/mUSD demo venue |
| `leash-asset` | Mock USD (SIP-010, 6 decimals) so the repo needs no third-party token |
| `leash-rogue-adapter` | Deliberately malicious venue used to prove the safety properties |

Canonical dependencies only: the official
`SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` and the standard
SIP-010 trait are pulled in as Clarinet requirements (auto-remapped to the
testnet addresses on deploy), never copied. Tests mint sBTC through the real
signer-gated deposit path, not a mock.

All contracts are Clarity 4 and pass `clarinet check` with zero warnings.

## The bot

Drover is a **constant-mix rebalancer**: it values both legs at venue spot
and, when the sBTC share of the portfolio drifts outside a no-trade band,
sells the overweight leg by exactly the drift. Deliberately boring — it is a
strategy you can read in one sitting and check against the tests.

| File | Purpose |
|---|---|
| `agent/strategy.ts` | The decision. Pure: no I/O, no clock, no randomness |
| `agent/agent.ts` | The loop: read state, decide, submit, log |
| `agent/drivers/simnet.ts` | Runs the strategy against Clarinet simnet (the tests) |
| `agent/drivers/testnet.ts` | Runs the same strategy against a live network |
| `agent/run.ts` | CLI entry point |

Two properties matter more than the strategy itself:

**The strategy is pure.** Same state in, same decision out, always. An
autonomous agent whose behaviour is reproducible is one you can *review*, not
merely watch — the precondition for letting a model drive it.

**The bot sizes trades against the lease's own limits.** It computes the price
impact its trade would cause and declines to submit transactions the vault
would reject, rather than burning fees to learn the same thing on-chain. The
strategy bends to the policy; the policy never bends to the strategy.

## The AI part

Drover uses Claude for the thing language models are actually good at:
**turning a policy stated in plain English into parameters.**

```sh
npm run agent -- --policy "keep me mostly in bitcoin, don't fuss over small moves"
# policy: accepted -> target 8000 bps, band 800 bps
#   Heavy Bitcoin weighting that only rebalances on large moves.
```

It is **not** forecasting prices. An LLM has no edge at that, and a bot
claiming otherwise is what gives "AI trading" its bad name. What it does is
translate intent — the step that otherwise makes a non-technical owner guess at
basis points in a form field — and explain each decision in a sentence the
owner can check.

Everything the model proposes passes through three layers:

```text
model proposes  →  validator clamps  →  chain enforces
   (Claude)       (resolve.ts, pure)    (leash-vault)
```

The validator is pure, total, and offline. A malformed response, an absurd
number, an API outage, or an outright refusal all resolve to the owner's
baseline parameters — never to an exception, and never to undefined behaviour.
Critically, **the model can only move portfolio *shape*** (target and band,
inside owner-set bounds). Every loss-bounding parameter — venue, pair, cap,
slippage floor, expiry — is owner-set and chain-enforced, out of the model's
reach by construction. A hostile model proposing "liquidate everything, ignore
slippage" gets a clamped target and nothing else; the test suite proves it.

`--advisor` additionally consults the model each tick. It's off by default,
and honestly: its value is unproven. It's safe to offer only because it cannot
do damage.

```sh
LEASH_AGENT_KEY=<hex key>  LEASH_OWNER=<owner address> \
LEASH_DEPLOYER=<contract address>  npm run agent -- --interval 60 --advisor
```

| File | Purpose |
|---|---|
| `agent/ai/resolve.ts` | The containment layer: validates and clamps proposals |
| `agent/ai/policy.ts` | Plain-English policy → parameters; per-tick advisory |
| `agent/ai/claude.ts` | Live Claude client (structured outputs, refusal-safe) |

## Quickstart

```sh
clarinet check    # our 5 contracts + sBTC requirements, zero warnings
npm install
npm test          # 58 tests (contracts + agent + AI); no API key needed
npm run typecheck # agent sources
```

The contract suite covers deposits/withdrawals, every lease guard (agent,
venue, pair, cap, window reset, expiry, instant revoke), exact trade
accounting (proceeds, protocol fee, pool reserves), the slippage floor
against live spot, both rogue-venue properties, and the pool's push-based
settlement.

The agent suite runs **the real strategy against the real contracts**: it
shows Drover rebalancing a 100%-sBTC vault toward its 50/50 target across
successive windows, one capped trade at a time, and proves the leash — not
the strategy — is what limits it. It also shows the bot standing down when an
owner revokes, and the chain refusing a bot that ignores that and tries
anyway.

The AI suite stubs the model, so it runs **offline and deterministically —
no API key, no network**. It covers the containment layer against every way a
model can misbehave (malformed output, `NaN`, `Infinity`, fractional bps,
missing fields, absurd values, silence) and then proves the property that
matters end-to-end: an AI-set target genuinely changes what the bot does
on-chain, while a hostile proposal trying to widen its own leash moves the
target and *nothing else*.

## Key entry points

```clarity
;; owner
(deposit token amount)
(withdraw token amount)
(grant-lease agent adapter token-a token-b cap-a cap-b
             min-price-a min-price-b window-blocks max-slippage-bps expiry-height)
(revoke-lease)

;; agent (wallet or contract - both tx-sender and contract-caller are honoured)
(trade owner adapter sell-token buy-token amount-in)

;; anyone
(get-balance-of owner token) (get-lease owner) (remaining-allowance owner token)
```

Protocol revenue: a fee (default 0.2%, hard-capped at 1%) on trade proceeds,
from the first trade.

## Error codes

`u100`-`u115` vault (zero amount, insufficient balance, no lease, not agent,
expired, wrong adapter/pair, cap exceeded, slippage, parameter validation,
admin), `u200`s mock asset, `u300`s pool (wrong token, no liquidity,
slippage, deposit missing, owner only).

## Roadmap

- Adapters for production venues (Bitflow, Velar) behind the same trait.
- One-page UI: deposit, set the leash, live trade feed, revoke.
- Alternative strategies on the same rail (DCA, signal- or LLM-driven).
- Performance fees for agents and a strategy marketplace on top.

## License

MIT
