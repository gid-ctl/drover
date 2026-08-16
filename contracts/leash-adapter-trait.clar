;; leash-adapter-trait
;; -----------------------------------------------------------------------------
;; The venue interface Leash trades through. An adapter wraps one trading venue
;; (a DEX pool, a router) behind two functions:
;;
;;   quote (sell-token amount-in) -> (ok spot-out)
;;     The spot-implied output of selling `amount-in` of `sell-token` at the
;;     venue's current reserves, with NO price impact and NO fee. The vault
;;     derives its slippage floor from this number.
;;
;;   swap (sell-token amount-in min-out) -> (ok amount-out)
;;     Execute the sale. Push-based: the caller has already transferred exactly
;;     `amount-in` of `sell-token` to the adapter in this same transaction.
;;     The adapter must send the proceeds to `contract-caller` and abort if the
;;     output is below `min-out`.
;;
;; Adapters never receive any authority over the vault. They are handed an
;; exact amount of tokens and judged on what they send back: the vault measures
;; its own balance delta and reverts the whole transaction if the venue
;; under-delivers. Tokens are identified by principal; each adapter statically
;; knows the pair(s) it serves, so no trait-in-trait plumbing is needed.
;; -----------------------------------------------------------------------------

(define-trait leash-adapter
  (
    (quote (principal uint) (response uint uint))
    (swap (principal uint uint) (response uint uint))
  )
)
