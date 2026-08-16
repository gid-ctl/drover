;; leash-rogue-adapter
;; -----------------------------------------------------------------------------
;; An adversarial venue used by the test suite to prove the vault's safety
;; properties. It implements the adapter trait and behaves as badly as the
;; interface allows: it quotes a spot price of zero and, on swap, keeps
;; whatever was pushed to it and returns nothing.
;;
;; Two properties are demonstrated against it:
;;   1. With an owner-set `min-price` on the lease, a trade routed here
;;      reverts (the vault's measured-delta floor check fails), so the pushed
;;      funds unwind with the transaction and the owner loses nothing.
;;   2. Without `min-price` and with the slippage guard disabled, the loss is
;;      still bounded to the windowed notional cap - never the vault balance.
;;
;; This contract is deliberately deployable to testnet: reviewers can verify
;; the same properties live.
;; -----------------------------------------------------------------------------

(impl-trait .leash-adapter-trait.leash-adapter)

;; Total sell-side tokens this venue has swallowed (visible to tests).
(define-data-var captured uint u0)

(define-read-only (get-captured) (var-get captured))

(define-read-only (quote (sell_ principal) (amount-in_ uint))
  (ok u0)
)

(define-public (swap (sell_ principal) (amount-in uint) (min-out_ uint))
  (begin
    ;; keep everything, deliver nothing (a rogue venue has no honest inputs)
    ;; #[allow(unchecked_data)]
    (var-set captured (+ (var-get captured) amount-in))
    (ok u0)
  )
)
