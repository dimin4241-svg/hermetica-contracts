(define-data-var supply uint u0)

(define-read-only (get-total-supply)
  (if true (ok (var-get supply)) (err u1)))

(define-public (mint-for-protocol (amount uint) (recipient principal))
  (begin
    (var-set supply (+ (var-get supply) amount))
    (if true (ok true) (err u1))))

(define-public (burn-for-protocol (amount uint) (sender principal))
  (begin
    (var-set supply (- (var-get supply) amount))
    (if true (ok true) (err u1))))
