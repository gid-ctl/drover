;; leash-asset
;; A minimal SIP-010 fungible token used as the stand-in quote asset for Leash
;; demos and tests (a mock USD stablecoin, 6 decimals). The vault itself is
;; asset-agnostic: any SIP-010 token whose `transfer` honours contract-caller
;; authorisation can be held and traded. This contract exists so the repo is
;; fully self-contained - testnet reviewers can mint a test asset, fund a
;; vault, lease an agent, and watch a full trade cycle without depending on a
;; third-party token. Only the owner can mint.

(impl-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

(define-fungible-token musd)

(define-constant ERR-OWNER-ONLY (err u200))
(define-constant ERR-NOT-TOKEN-OWNER (err u201))

(define-constant TOKEN-NAME "Leash Mock USD")
(define-constant TOKEN-SYMBOL "mUSD")
(define-constant TOKEN-DECIMALS u6)

(define-data-var contract-owner principal tx-sender)
(define-data-var token-uri (optional (string-utf8 256)) none)

;; --- SIP-010 ----------------------------------------------------------------
(define-read-only (get-name) (ok TOKEN-NAME))
(define-read-only (get-symbol) (ok TOKEN-SYMBOL))
(define-read-only (get-decimals) (ok TOKEN-DECIMALS))
(define-read-only (get-balance (who principal)) (ok (ft-get-balance musd who)))
(define-read-only (get-total-supply) (ok (ft-get-supply musd)))
(define-read-only (get-token-uri) (ok (var-get token-uri)))

(define-public (transfer
    (amount uint)
    (sender principal)
    (recipient principal)
    (memo (optional (buff 34)))
  )
  (begin
    ;; #[filter(amount, recipient)]
    (asserts! (or (is-eq tx-sender sender) (is-eq contract-caller sender)) ERR-NOT-TOKEN-OWNER)
    (try! (ft-transfer? musd amount sender recipient))
    (match memo to-print (print to-print) 0x)
    (ok true)
  )
)

;; --- Owner ------------------------------------------------------------------
(define-read-only (get-contract-owner) (var-get contract-owner))

(define-public (set-contract-owner (new-owner principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR-OWNER-ONLY)
    ;; owner-gated above
    ;; #[allow(unchecked_data)]
    (var-set contract-owner new-owner)
    (ok true)
  )
)

(define-public (set-token-uri (value (optional (string-utf8 256))))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR-OWNER-ONLY)
    ;; owner-gated above
    ;; #[allow(unchecked_data)]
    (var-set token-uri value)
    (ok (print {
      notification: "token-metadata-update",
      payload: { contract-id: current-contract, token-class: "ft" }
    }))
  )
)

;; Mint test mUSD. Owner-only; used to seed vaults and the demo pool.
(define-public (mint (amount uint) (recipient principal))
  (begin
    (asserts! (is-eq tx-sender (var-get contract-owner)) ERR-OWNER-ONLY)
    ;; #[filter(amount, recipient)]
    (ft-mint? musd amount recipient)
  )
)
