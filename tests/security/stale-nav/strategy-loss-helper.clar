;; Local-only harness contract. Production hBTC contracts are unchanged.
;; It represents assets already moved into an external strategy and a realized
;; external loss such as a strategy loss or external-protocol loss event.

(define-constant sbtc-token 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

(define-public (pull-from-reserve (amount uint))
  (contract-call? .reserve transfer sbtc-token amount current-contract)
)

(define-public (realize-loss (amount uint) (sink principal))
  (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "*" amount))
    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer amount current-contract sink none))
  )
)

;; Physical strategy liquidity can later be returned to Reserve without changing
;; hBTC accounting total-assets. This is used only to let every holder perform an
;; actual final redemption in A/B controls instead of relying on mark-to-market.
(define-public (return-to-reserve (amount uint))
  (as-contract? ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "*" amount))
    (try! (contract-call? sbtc-token transfer amount current-contract .reserve none))
  )
)
