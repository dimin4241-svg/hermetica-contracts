(define-data-var supply uint u0)

(define-read-only (get-total-supply)
  (ok (var-get supply))
)

(define-public (mint-for-protocol (amount uint) (recipient principal))
  (begin
    (var-set supply (+ (var-get supply) amount))
    (ok true)))

(define-public (burn-for-protocol (amount uint) (sender principal))
  (begin
    (var-set supply (- (var-get supply) amount))
    (ok true)))
