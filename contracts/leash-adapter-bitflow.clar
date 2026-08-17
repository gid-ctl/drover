;; leash-adapter-bitflow
;; -----------------------------------------------------------------------------
;; Venue adapter for Bitflow's DLMM sBTC/USDCx pool - the only active
;; sBTC/dollar market on Stacks (~3 sBTC of depth, ~27k transactions).
;;
;; The adapter is pinned to one pool on purpose. Clarity cannot build a trait
;; reference from a runtime principal, so the pool and both token traits must be
;; static - which suits the leash model exactly: an owner pins an adapter, and an
;; adapter *is* one specific market. Adding a venue means deploying another
;; adapter, never widening this one.
;;
;; Settlement. Bitflow's core pulls the sell amount from `tx-sender`, so the
;; swap is wrapped in `as-contract`: tx-sender becomes this adapter, and the core
;; takes the tokens the vault pushed here moments earlier. The vault's authority
;; is never delegated - it authored that push itself, and this contract can only
;; ever move what it was handed.
;;
;; Pricing. A DLMM is bin-based, not constant-product: spot is
;; `initial-price * (1 + bin-step/10000) ^ active-bin-id`, and that
;; exponentiation is not something to reimplement in Clarity for a number the
;; chain will not verify. So `quote` reports no on-chain spot (u0) and the
;; vault's floor falls back to the owner's `min-price`, which the lease already
;; carries. Two enforcement layers remain, and neither depends on this adapter
;; being honest:
;;   1. `min-out` is handed straight to Bitflow's router as `min-dy`, and the
;;      router reverts the swap itself if the fill misses it.
;;   2. The vault measures its own balance delta afterwards and reverts if the
;;      proceeds are short.
;; A caller that sets no `min-price` therefore trades with venue-enforced
;; slippage only - which is why the agent should size from a live quote and the
;; owner should set `min-price`. See README.
;; -----------------------------------------------------------------------------

(impl-trait .leash-adapter-trait.leash-adapter)

;; --- Pinned market -----------------------------------------------------------
(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant USDCX 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx)

;; --- Errors ------------------------------------------------------------------
(define-constant ERR-WRONG-TOKEN (err u400))
(define-constant ERR-ZERO-AMOUNT (err u401))
(define-constant ERR-PAYOUT-FAILED (err u402))

;; --- Adapter trait: quote ----------------------------------------------------
;; No on-chain spot for a bin-based pool (see header). Returning u0 makes the
;; vault's spot-derived floor vacuous and defers to the owner's `min-price`,
;; rather than inventing a number that would look like a guarantee.
(define-read-only (quote (sell principal) (amount-in_ uint))
  (if (or (is-eq sell SBTC) (is-eq sell USDCX))
    (ok u0)
    ERR-WRONG-TOKEN
  )
)

;; --- Adapter trait: swap -----------------------------------------------------
;; The vault has already pushed `amount-in` of `sell` to this contract. Route it
;; through Bitflow and hand the proceeds back to the vault that called us.
;; Every outflow is wrapped in a Clarity 4 `as-contract?` allowance, so the
;; runtime itself rejects any attempt to move more than the exact amount named -
;; the adapter cannot over-spend even if Bitflow's code asked it to.
(define-public (swap (sell principal) (amount-in uint) (min-out uint))
  (let ((vault contract-caller))
    (asserts! (> amount-in u0) ERR-ZERO-AMOUNT)
    (if (is-eq sell SBTC)
      (let (
          (result (try! (as-contract?
            ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
              "sbtc-token" amount-in))
            (try! (contract-call?
              'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-1
              swap-x-for-y-simple-multi
              'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10
              'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
              'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
              amount-in min-out)))))
          (out (get out result))
        )
        ;; #[filter(out, vault)]
        (try! (as-contract?
          ((with-ft 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
            "usdcx-token" out))
          (try! (contract-call? 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
            transfer out current-contract vault none))))
        (print {event: "swap", sell: sell, amount-in: amount-in, out: out, to: vault})
        (ok out)
      )
      (if (is-eq sell USDCX)
        (let (
            (result (try! (as-contract?
              ((with-ft 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
                "usdcx-token" amount-in))
              (try! (contract-call?
                'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-1
                swap-y-for-x-simple-multi
                'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10
                'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
                'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx
                amount-in min-out)))))
            (out (get out result))
          )
          ;; #[filter(out, vault)]
          (try! (as-contract?
            ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
              "sbtc-token" out))
            (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
              transfer out current-contract vault none))))
          (print {event: "swap", sell: sell, amount-in: amount-in, out: out, to: vault})
          (ok out)
        )
        ERR-WRONG-TOKEN
      )
    )
  )
)
