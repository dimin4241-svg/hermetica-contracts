;; TEST-ONLY SETUP CONTRACT.
;; It is used only to seed initial USDh balances and to reproduce the exact token-state
;; transition made by production controller-v1-1::log-reward:
;;   usdh-token::mint-for-protocol(reward, .staking-reserve)
;; The exploit itself uses only unchanged production staking contracts.

(define-constant owner tx-sender)
(define-constant ERR_NOT_OWNER (err u1))

(define-public (mint-usdh (amount uint) (recipient principal))
  (begin
    (asserts! (is-eq tx-sender owner) ERR_NOT_OWNER)
    (contract-call? .usdh-token mint-for-protocol amount recipient)
  )
)
