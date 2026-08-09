;; Minimal dependency mock. It does not model a vulnerability; it only lets the
;; production State/Token contracts execute their internal accounting paths.

(define-read-only (check-is-protocol-enabled) (ok true))
(define-read-only (check-is-protocol (address principal)) (ok true))
(define-read-only (check-is-owner (address principal)) (ok true))
(define-read-only (check-is-guardian (address principal)) (ok true))
(define-read-only (check-is-fee-setter (address principal)) (ok true))
(define-read-only (check-is-standard (address principal)) (ok true))
(define-read-only (check-timelock (ts uint)) (ok true))
(define-read-only (get-protocol (address principal)) true)
(define-read-only (get-timelock) u0)
