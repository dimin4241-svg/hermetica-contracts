;; Local-only harness contract. Production hBTC contracts are unchanged.
;; It represents assets already moved into an external strategy and a realized
;; external loss such as a permissionless Zest liquidation.

(define-constant sbtc-token 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

(define-public (pull-from-reserve (amount uint))
  (contract-call? .reserve transfer sbtc-token amount current-contract)
)

(define-public (realize-loss (amount uint) (sink principal))
  (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "*" amount))
    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer amount current-contract sink none))
  )
)
