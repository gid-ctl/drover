;; leash-vault
;; -----------------------------------------------------------------------------
;; Leash - non-custodial trading authority for AI agents on Stacks.
;;
;; An owner deposits SIP-010 assets (sBTC first among them) into a personal,
;; non-pooled vault and grants an agent a narrow, instantly revocable trading
;; lease: one venue adapter, one token pair, a notional cap per rolling block
;; window in each direction, a slippage ceiling against the venue's own spot,
;; an optional hard limit price, and an expiry. Inside the leash the agent may
;; call `trade`. It can never withdraw, never exceed a cap, never route to a
;; venue or pair the owner did not pin. The owner can withdraw or revoke at
;; any block.
;;
;; The security design is that the vault NEVER delegates its authority:
;;   - There is no `as-contract` frame around venue code. The vault pushes
;;     exactly `amount-in` of the sell token to the adapter (a plain transfer
;;     it authors itself), calls `swap`, then measures its own balance of the
;;     buy token. Everything the venue does happens with the venue's own
;;     authority only.
;;   - If the measured proceeds are below the floor - max(spot minus the
;;     owner's slippage tolerance, the owner's hard limit price) - the whole
;;     transaction aborts, unwinding the pushed funds. A venue that keeps the
;;     money and lies is simply a reverted transaction.
;;   - A worst-case venue (whitelisted by the owner, quoting zero, slippage
;;     guard disabled) can capture at most one windowed cap per window: the
;;     bleed rate is bounded and the owner's revoke is instant.
;;
;; Trust boundary, stated plainly: Leash cannot make an agent smart - losses
;; from bad strategy on an honest venue are the meaning of delegation. What it
;; removes is custody risk: theft by the agent, and (with `min-price` set)
;; under-priced fills by the venue.
;;
;; sBTC is referenced through the canonical contract as a Clarinet
;; requirement; deposits and withdrawals work for any SIP-010 token whose
;; `transfer` honours contract-caller authorisation (the ecosystem
;; convention, used by sbtc-token itself).
;; -----------------------------------------------------------------------------

(use-trait ft-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)
(use-trait adapter-trait .leash-adapter-trait.leash-adapter)

;; --- Errors ------------------------------------------------------------------
(define-constant ERR-ZERO-AMOUNT (err u100))
(define-constant ERR-INSUFFICIENT-BALANCE (err u101))
(define-constant ERR-NO-LEASE (err u102))
(define-constant ERR-NOT-AGENT (err u103))
(define-constant ERR-LEASE-EXPIRED (err u104))
(define-constant ERR-WRONG-ADAPTER (err u105))
(define-constant ERR-WRONG-PAIR (err u106))
(define-constant ERR-CAP-EXCEEDED (err u107))
(define-constant ERR-SLIPPAGE (err u108))
(define-constant ERR-EXPIRY-IN-PAST (err u109))
(define-constant ERR-ZERO-WINDOW (err u110))
(define-constant ERR-NOT-AUTHORIZED (err u111))
(define-constant ERR-FEE-TOO-HIGH (err u112))
(define-constant ERR-BPS-RANGE (err u113))
(define-constant ERR-SAME-TOKEN (err u114))
(define-constant ERR-BALANCE-READ (err u115))

(define-constant BPS-DEN u10000)
;; `min-price` is buy base-units per sell base-unit, scaled by 1e8.
(define-constant PRICE-SCALE u100000000)
;; Protocol fee is capped at 1% forever; the admin key cannot rug fees.
(define-constant MAX-FEE-BPS u100)

;; --- State -------------------------------------------------------------------
(define-data-var contract-owner principal tx-sender)
(define-data-var fee-recipient principal tx-sender)
(define-data-var fee-bps uint u20) ;; 0.2% of trade proceeds

;; Per-owner, per-token internal ledger. All assets sit on this contract's
;; principal; this map is the book that says whose they are.
(define-map balances {owner: principal, token: principal} uint)

;; Sum of every owner's ledger entry, per token. Clarity cannot fold a map, so
;; the total is maintained incrementally alongside `balances`. It exists for two
;; reasons: it is the vault's TVL figure, and it makes the solvency invariant
;; -- book total never exceeds tokens actually held -- checkable on-chain and
;; fuzzable by Rendezvous.
(define-map total-ledger principal uint)

;; One active lease per owner.
(define-map leases principal {
  agent: principal,
  adapter: principal,
  token-a: principal,
  token-b: principal,
  cap-a: uint,             ;; max token-a sold per window (u0 disables a->b)
  cap-b: uint,             ;; max token-b sold per window (u0 disables b->a)
  min-price-a: uint,       ;; hard floor selling a (buy-units/sell-unit * 1e8; u0 = off)
  min-price-b: uint,       ;; hard floor selling b
  window-blocks: uint,     ;; rolling window length in Stacks blocks
  max-slippage-bps: uint,  ;; tolerated shortfall vs venue spot (u10000 = off)
  expiry-height: uint      ;; lease dies at this Stacks block
})

;; Rolling spend per (owner, sell-token).
(define-map windows {owner: principal, token: principal} {start: uint, spent: uint})

;; --- Read-only views ---------------------------------------------------------
(define-read-only (get-contract-owner) (var-get contract-owner))
(define-read-only (get-fee-recipient) (var-get fee-recipient))
(define-read-only (get-fee-bps) (var-get fee-bps))

(define-read-only (get-balance-of (owner principal) (token principal))
  (default-to u0 (map-get? balances {owner: owner, token: token}))
)

;; Total booked across all owners for one token (the vault's TVL in that asset).
(define-read-only (get-total-ledger (token principal))
  (default-to u0 (map-get? total-ledger token))
)

(define-private (credit-total (token principal) (amount uint))
  (begin
    ;; #[allow(unchecked_data)]
    (map-set total-ledger token (+ (get-total-ledger token) amount))
    true
  )
)

(define-private (debit-total (token principal) (amount uint))
  (begin
    ;; #[allow(unchecked_data)]
    (map-set total-ledger token (- (get-total-ledger token) amount))
    true
  )
)

(define-read-only (get-lease (owner principal))
  (map-get? leases owner)
)

(define-read-only (get-window (owner principal) (token principal))
  (default-to {start: u0, spent: u0} (map-get? windows {owner: owner, token: token}))
)

;; Notional still spendable from `owner`'s vault selling `token` right now.
(define-read-only (remaining-allowance (owner principal) (token principal))
  (match (map-get? leases owner) lease
    (let (
        (cap (if (is-eq token (get token-a lease))
          (get cap-a lease)
          (if (is-eq token (get token-b lease)) (get cap-b lease) u0)))
        (window (get-window owner token))
      )
      (if (>= stacks-block-height (+ (get start window) (get window-blocks lease)))
        cap
        (- cap (get spent window))
      )
    )
    u0
  )
)

;; --- Owner: fund and defund --------------------------------------------------
(define-public (deposit (token <ft-trait>) (amount uint))
  (let ((owner tx-sender))
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    ;; the ledger entry is keyed by the token's own principal, so a dishonest
    ;; token can only ever corrupt its own bookkeeping, never another asset's
    ;; #[allow(unchecked_data)]
    (map-set balances {owner: owner, token: (contract-of token)}
      (+ (get-balance-of owner (contract-of token)) amount))
    ;; keyed by the token's own principal, so a dishonest token can only ever
    ;; distort its own total - never another asset's
    ;; #[allow(unchecked_data)]
    (credit-total (contract-of token) amount)
    ;; #[filter(amount, token)]
    (try! (contract-call? token transfer amount owner current-contract none))
    (print {event: "deposit", owner: owner, token: (contract-of token), amount: amount})
    (ok true)
  )
)

;; Owner-only by construction: only `tx-sender`'s own ledger entry is debited,
;; and the payout goes to `tx-sender`. There is no path that pays anyone else.
(define-public (withdraw (token <ft-trait>) (amount uint))
  (let (
      (owner tx-sender)
      (balance (get-balance-of tx-sender (contract-of token)))
    )
    (asserts! (> amount u0) ERR-ZERO-AMOUNT)
    (asserts! (>= balance amount) ERR-INSUFFICIENT-BALANCE)
    (map-set balances {owner: owner, token: (contract-of token)} (- balance amount))
    (debit-total (contract-of token) amount)
    ;; the debited ledger entry and the payout use the same caller-chosen
    ;; token, and the recipient is the caller - safe by construction
    ;; #[filter(amount, token)]
    (try! (contract-call? token transfer amount current-contract owner none))
    (print {event: "withdraw", owner: owner, token: (contract-of token), amount: amount})
    (ok true)
  )
)

;; --- Owner: the leash --------------------------------------------------------
(define-public (grant-lease
    (agent principal)
    (adapter principal)
    (token-a principal)
    (token-b principal)
    (cap-a uint)
    (cap-b uint)
    (min-price-a uint)
    (min-price-b uint)
    (window-blocks uint)
    (max-slippage-bps uint)
    (expiry-height uint)
  )
  (let ((owner tx-sender))
    (asserts! (not (is-eq token-a token-b)) ERR-SAME-TOKEN)
    (asserts! (> window-blocks u0) ERR-ZERO-WINDOW)
    (asserts! (<= max-slippage-bps BPS-DEN) ERR-BPS-RANGE)
    (asserts! (> expiry-height stacks-block-height) ERR-EXPIRY-IN-PAST)
    ;; owner sets their own policy over their own funds
    ;; #[allow(unchecked_data)]
    (map-set leases owner {
      agent: agent,
      adapter: adapter,
      token-a: token-a,
      token-b: token-b,
      cap-a: cap-a,
      cap-b: cap-b,
      min-price-a: min-price-a,
      min-price-b: min-price-b,
      window-blocks: window-blocks,
      max-slippage-bps: max-slippage-bps,
      expiry-height: expiry-height
    })
    ;; a new lease starts with clean windows
    (map-delete windows {owner: owner, token: token-a})
    (map-delete windows {owner: owner, token: token-b})
    (print {event: "grant-lease", owner: owner, agent: agent, adapter: adapter,
            token-a: token-a, token-b: token-b, cap-a: cap-a, cap-b: cap-b,
            window-blocks: window-blocks, max-slippage-bps: max-slippage-bps,
            expiry-height: expiry-height})
    (ok true)
  )
)

(define-public (revoke-lease)
  (let (
      (owner tx-sender)
      (lease (unwrap! (map-get? leases owner) ERR-NO-LEASE))
    )
    (map-delete leases owner)
    (map-delete windows {owner: owner, token: (get token-a lease)})
    (map-delete windows {owner: owner, token: (get token-b lease)})
    (print {event: "revoke-lease", owner: owner, agent: (get agent lease)})
    (ok true)
  )
)

;; --- Agent: trade inside the leash -------------------------------------------
;; The agent may be a wallet (tx-sender) or an on-chain contract
;; (contract-caller), so autonomous agents can hold a lease directly.
(define-public (trade
    (owner principal)
    (adapter <adapter-trait>)
    (sell-token <ft-trait>)
    (buy-token <ft-trait>)
    (amount-in uint)
  )
  (let (
      (lease (unwrap! (map-get? leases owner) ERR-NO-LEASE))
      (sell (contract-of sell-token))
      (buy (contract-of buy-token))
      (dir-a (and (is-eq sell (get token-a lease)) (is-eq buy (get token-b lease))))
      (dir-b (and (is-eq sell (get token-b lease)) (is-eq buy (get token-a lease))))
      (sell-balance (get-balance-of owner sell))
    )
    (asserts! (or (is-eq tx-sender (get agent lease))
                  (is-eq contract-caller (get agent lease))) ERR-NOT-AGENT)
    (asserts! (< stacks-block-height (get expiry-height lease)) ERR-LEASE-EXPIRED)
    (asserts! (is-eq (contract-of adapter) (get adapter lease)) ERR-WRONG-ADAPTER)
    (asserts! (or dir-a dir-b) ERR-WRONG-PAIR)
    (asserts! (> amount-in u0) ERR-ZERO-AMOUNT)
    (asserts! (>= sell-balance amount-in) ERR-INSUFFICIENT-BALANCE)
    (let (
        (cap (if dir-a (get cap-a lease) (get cap-b lease)))
        (min-price (if dir-a (get min-price-a lease) (get min-price-b lease)))
        (window (get-window owner sell))
        (fresh (>= stacks-block-height (+ (get start window) (get window-blocks lease))))
        (new-start (if fresh stacks-block-height (get start window)))
        (new-spent (+ (if fresh u0 (get spent window)) amount-in))
        ;; the venue's own spot is the slippage reference; the owner's
        ;; min-price is a hard floor independent of anything the venue says
        (spot (try! (contract-call? adapter quote sell amount-in)))
        (floor-spot (/ (* spot (- BPS-DEN (get max-slippage-bps lease))) BPS-DEN))
        (floor-price (/ (* amount-in min-price) PRICE-SCALE))
        (floor-out (if (> floor-spot floor-price) floor-spot floor-price))
        (before (unwrap! (contract-call? buy-token get-balance current-contract) ERR-BALANCE-READ))
      )
      (asserts! (<= new-spent cap) ERR-CAP-EXCEEDED)
      ;; `sell` was asserted equal to a lease-pinned token via dir-a/dir-b
      ;; #[allow(unchecked_data)]
      (map-set windows {owner: owner, token: sell} {start: new-start, spent: new-spent})
      ;; #[allow(unchecked_data)]
      (map-set balances {owner: owner, token: sell} (- sell-balance amount-in))
      (debit-total sell amount-in)
      ;; push exactly amount-in to the venue - the vault's authority stops here
      ;; #[filter(amount-in, sell-token)]
      (try! (contract-call? sell-token transfer amount-in current-contract
        (get adapter lease) none))
      (try! (contract-call? adapter swap sell amount-in floor-out))
      (let (
          (after (unwrap! (contract-call? buy-token get-balance current-contract) ERR-BALANCE-READ))
          (received (- after before))
          (fee (/ (* received (var-get fee-bps)) BPS-DEN))
          (net (- received fee))
        )
        ;; judged on measured proceeds, not on what the venue claims
        (asserts! (>= received floor-out) ERR-SLIPPAGE)
        (map-set balances {owner: owner, token: buy}
          (+ (get-balance-of owner buy) net))
        (credit-total buy net)
        (and (> fee u0)
          ;; #[filter(fee)]
          (try! (contract-call? buy-token transfer fee current-contract
            (var-get fee-recipient) none)))
        (print {event: "trade", owner: owner, agent: tx-sender, adapter: (get adapter lease),
                sell: sell, buy: buy, amount-in: amount-in, spot: spot,
                floor: floor-out, received: received, fee: fee, net: net})
        (ok net)
      )
    )
  )
)

;; --- Protocol admin (fees only; no authority over user funds) ----------------
(define-private (assert-owner)
  (ok (asserts! (is-eq tx-sender (var-get contract-owner)) ERR-NOT-AUTHORIZED))
)

(define-public (set-contract-owner (new-owner principal))
  (begin
    (try! (assert-owner))
    ;; owner-gated above
    ;; #[allow(unchecked_data)]
    (var-set contract-owner new-owner)
    (print {event: "set-owner", owner: new-owner})
    (ok true)
  )
)

(define-public (set-fee-recipient (recipient principal))
  (begin
    (try! (assert-owner))
    ;; owner-gated above
    ;; #[allow(unchecked_data)]
    (var-set fee-recipient recipient)
    (print {event: "set-fee-recipient", recipient: recipient})
    (ok true)
  )
)

(define-public (set-fee-bps (bps uint))
  (begin
    (try! (assert-owner))
    (asserts! (<= bps MAX-FEE-BPS) ERR-FEE-TOO-HIGH)
    (var-set fee-bps bps)
    (print {event: "set-fee-bps", bps: bps})
    (ok true)
  )
)

;; --- Rendezvous invariants (simnet only) -------------------------------------
;; Everything below is stripped on deploy by the `#[env(simnet)]` annotation.
;; Run with:  npx rv . leash-vault invariant --runs 200
;;
;; Rendezvous generates random sequences of calls into this contract and checks
;; after every step that each `invariant-` function still holds. The unit tests
;; prove the paths we thought of; these prove the properties that must survive
;; orderings we did not think of.

;; Call-count bookkeeping required by the fuzzer.
;; #[env(simnet)]
(define-map context (string-ascii 100) {called: uint})

;; #[env(simnet)]
(define-private (update-context (function-name (string-ascii 100)) (called uint))
  (ok (map-set context function-name {called: called}))
)

;; Solvency: the book must never claim more sBTC than the vault actually holds.
;; If this fails, some owner cannot withdraw what the ledger says is theirs -
;; the failure that matters most in a vault. Stated as <= rather than = on
;; purpose: anyone may transfer tokens in directly without a ledger entry, so a
;; surplus is legitimate. A deficit is insolvency.
;; #[env(simnet)]
(define-read-only (invariant-sbtc-solvent)
  ;; `unwrap!` rather than `unwrap-panic`: an unreadable balance should fail the
  ;; invariant visibly, not abort the fuzz run with a panic.
  (<=
    (get-total-ledger 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
    (unwrap! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      get-balance current-contract) false)
  )
)

;; Same property for the SIP-010 side of the pair.
;; #[env(simnet)]
(define-read-only (invariant-asset-solvent)
  (<=
    (get-total-ledger .leash-asset)
    (unwrap! (contract-call? .leash-asset get-balance current-contract) false)
  )
)

;; No sequence of admin calls may push the protocol fee above its hard cap.
;; #[env(simnet)]
(define-read-only (invariant-fee-bps-capped)
  (<= (var-get fee-bps) MAX-FEE-BPS)
)

;; The agent may never be told it can spend more than the owner's window cap.
;; #[env(simnet)]
(define-read-only (invariant-allowance-within-cap)
  (match (map-get? leases tx-sender) lease
    (and
      (<= (remaining-allowance tx-sender (get token-a lease)) (get cap-a lease))
      (<= (remaining-allowance tx-sender (get token-b lease)) (get cap-b lease))
    )
    true
  )
)

;; Revocation is complete: with no lease, nothing is authorised.
;; #[env(simnet)]
(define-read-only (invariant-no-allowance-without-lease)
  (match (map-get? leases tx-sender) lease
    true
    (and
      (is-eq (remaining-allowance tx-sender
        'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token) u0)
      (is-eq (remaining-allowance tx-sender .leash-asset) u0)
    )
  )
)
