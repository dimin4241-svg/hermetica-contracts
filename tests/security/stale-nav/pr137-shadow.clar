;; Test-only shadow of the exact share-price staleness predicate proposed in PR #137.
;; PR #137: is-sp-stale := current time >= last-log-ts + 86400 seconds.

(define-constant PR137-STALENESS-WINDOW u86400)

(define-read-only (get-current-ts)
  stacks-block-time
)

(define-read-only (is-sp-stale (last-log-ts uint))
  (>= stacks-block-time (+ last-log-ts PR137-STALENESS-WINDOW))
)
