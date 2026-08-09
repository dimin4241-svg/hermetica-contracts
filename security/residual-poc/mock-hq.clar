;; Minimal dependency mock. It does not model a vulnerability; it only lets the
;; production State contract execute its internal accounting paths.

(define-private (ok-bool)
  (if true (ok true) (err u1)))

(define-read-only (check-is-protocol-enabled) (ok-bool))
(define-read-only (check-is-protocol (address principal)) (ok-bool))
(define-read-only (check-is-owner (address principal)) (ok-bool))
(define-read-only (check-is-guardian (address principal)) (ok-bool))
(define-read-only (check-is-fee-setter (address principal)) (ok-bool))
(define-read-only (check-is-standard (address principal)) (ok-bool))
(define-read-only (check-timelock (ts uint)) (ok-bool))
(define-read-only (get-protocol (address principal)) true)
(define-read-only (get-timelock) u0)
