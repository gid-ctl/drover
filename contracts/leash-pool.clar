;; leash-pool
;; -----------------------------------------------------------------------------
;; A minimal constant-product venue for the sBTC/mUSD pair, implementing the
;; Leash adapter trait. It exists so the repo is fully self-contained: tests
;; and testnet demos exercise the vault against a real AMM curve (price
;; impact, fees, slippage) without depending on third-party deployments.
;; Mainnet adapters wrap production DEXs (Bitflow, Velar) behind the same
;; two-function trait.
;;
;; Push-based settlement: the caller transfers the sell amount to this
;; contract first, then calls `swap` in the same transaction. The pool detects
;; the deposit as the excess of its actual token balance over its recorded
;; reserve (the classic UniswapV2 sync pattern), sends the output to
;; `contract-caller`, and folds the deposit into reserves. It never needs -
;; and is never given - any authority over the caller's funds.
;;
;; sBTC is referenced at its canonical address; Clarinet auto-remaps it to the
;; testnet sBTC contract when generating deployment plans.
;; -----------------------------------------------------------------------------

(impl-trait .leash-adapter-trait.leash-adapter)

;; --- Pair (pinned at deploy) -------------------------------------------------
(define-constant TOKEN-A 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant TOKEN-B .leash-asset)

;; Swap fee: 0.3% (997/1000), the constant-product convention.
(define-constant FEE-NUM u997)
(define-constant FEE-DEN u1000)

;; --- Errors ------------------------------------------------------------------
(define-constant ERR-WRONG-TOKEN (err u300))     ;; token not part of this pair
(define-constant ERR-NO-LIQUIDITY (err u301))    ;; empty reserves
(define-constant ERR-SLIPPAGE (err u302))        ;; output below min-out
(define-constant ERR-DEPOSIT-MISSING (err u303)) ;; sell amount was not pushed first
(define-constant ERR-OWNER-ONLY (err u304))
(define-constant ERR-ZERO-AMOUNT (err u305))
(define-constant ERR-BALANCE-READ (err u306))

;; The deployer seeds this demo venue; there is nothing else to administer.
(define-constant POOL-OWNER tx-sender)

;; --- State -------------------------------------------------------------------
(define-data-var reserve-a uint u0) ;; sBTC
(define-data-var reserve-b uint u0) ;; mUSD

;; --- Read-only views ---------------------------------------------------------
(define-read-only (get-contract-owner) POOL-OWNER)
(define-read-only (get-reserves) {reserve-a: (var-get reserve-a), reserve-b: (var-get reserve-b)})

(define-private (balance-a)
  (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
    get-balance current-contract)
)

(define-private (balance-b)
  (contract-call? .leash-asset get-balance current-contract)
)

;; --- Liquidity (owner-seeded demo venue; no LP shares) -----------------------
(define-public (provide (amount-a uint) (amount-b uint))
  (let ((provider tx-sender))
    (asserts! (is-eq provider POOL-OWNER) ERR-OWNER-ONLY)
    (asserts! (and (> amount-a u0) (> amount-b u0)) ERR-ZERO-AMOUNT)
    ;; #[filter(amount-a)]
    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      transfer amount-a provider current-contract none))
    ;; #[filter(amount-b)]
    (try! (contract-call? .leash-asset transfer amount-b provider current-contract none))
    (var-set reserve-a (+ (var-get reserve-a) amount-a))
    (var-set reserve-b (+ (var-get reserve-b) amount-b))
    (print {event: "provide", amount-a: amount-a, amount-b: amount-b})
    (ok true)
  )
)

;; --- Adapter trait: quote ----------------------------------------------------
;; Spot-implied output at current reserves: no price impact, no fee. The vault
;; uses this as the reference price its slippage floor is measured against.
(define-read-only (quote (sell principal) (amount-in uint))
  (let (
      (ra (var-get reserve-a))
      (rb (var-get reserve-b))
    )
    (asserts! (and (> ra u0) (> rb u0)) ERR-NO-LIQUIDITY)
    (if (is-eq sell TOKEN-A)
      (ok (/ (* amount-in rb) ra))
      (if (is-eq sell TOKEN-B)
        (ok (/ (* amount-in ra) rb))
        ERR-WRONG-TOKEN
      )
    )
  )
)

;; --- Adapter trait: swap -----------------------------------------------------
;; Requires the caller to have pushed `amount-in` of `sell` to this contract in
;; the same transaction. Output goes to `contract-caller`.
(define-public (swap (sell principal) (amount-in uint) (min-out uint))
  (let (
      (recipient contract-caller)
      (ra (var-get reserve-a))
      (rb (var-get reserve-b))
      (sell-is-a (is-eq sell TOKEN-A))
    )
    (asserts! (or sell-is-a (is-eq sell TOKEN-B)) ERR-WRONG-TOKEN)
    (asserts! (> amount-in u0) ERR-ZERO-AMOUNT)
    (asserts! (and (> ra u0) (> rb u0)) ERR-NO-LIQUIDITY)
    (let (
        (reserve-in (if sell-is-a ra rb))
        (reserve-out (if sell-is-a rb ra))
        (actual-in (unwrap! (if sell-is-a (balance-a) (balance-b)) ERR-BALANCE-READ))
        ;; constant-product output with the 0.3% fee applied to the input
        (out (/ (* amount-in FEE-NUM reserve-out)
                (+ (* reserve-in FEE-DEN) (* amount-in FEE-NUM))))
      )
      ;; the sell amount must already sit on top of our recorded reserve
      (asserts! (>= actual-in (+ reserve-in amount-in)) ERR-DEPOSIT-MISSING)
      (asserts! (>= out min-out) ERR-SLIPPAGE)
      (asserts! (< out reserve-out) ERR-NO-LIQUIDITY)
      ;; fold the deposit (and any excess donation) into reserves, pay out
      (if sell-is-a
        (begin
          (var-set reserve-a actual-in)
          (var-set reserve-b (- rb out))
          ;; #[filter(out)]
          (try! (contract-call? .leash-asset transfer out current-contract recipient none))
        )
        (begin
          (var-set reserve-b actual-in)
          (var-set reserve-a (- ra out))
          ;; #[filter(out)]
          (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
            transfer out current-contract recipient none))
        )
      )
      (print {event: "swap", sell: sell, amount-in: amount-in, out: out, recipient: recipient})
      (ok out)
    )
  )
)
