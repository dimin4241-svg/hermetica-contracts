# Stale-NAV finding — known-issue / duplicate analysis

## Conclusion

The realized-loss exploit is **not the same condition addressed by upstream PR #119 or PR #137**, and the proposed checks in those PRs would not stop the exploit.

Both PRs define share-price staleness only from elapsed wall-clock time since the latest `log-reward` (`last-log-ts`). The exploit instead begins with a **fresh successful `log-reward`** and then makes the economic NAV stale immediately afterwards by realizing a strategy loss externally.

That distinction matters because a timestamp can be fresh while the economic NAV is already wrong.

## Upstream PR #119

PR #119: `feat: implement stale share price protection in vault`

Status: **closed, not merged**. The PR comment states it was replaced by #137.

The PR describes its threat model as stale pricing when `log-reward` "wasn't called recently" and keeper downtime. It proposed:

```clarity
(define-data-var staleness-window-sp uint u86400)

(define-read-only (is-sp-stale)
  (> (get-current-ts) (+ (get-last-log-ts) (get-staleness-window-sp)))
)
```

and then rejected `deposit`, `fund-claim`, and `fund-claim-many` only when `is-sp-stale` was true.

## Upstream PR #137

PR #137: `feat: add share price staleness protection with emergency bypass`

Status: **closed, not merged**.

It retained the same timestamp-only model:

```clarity
(define-data-var staleness-window-sp uint u86400)

(define-read-only (is-sp-stale)
  (>= (get-current-ts) (+ (get-last-log-ts) (get-staleness-window-sp)))
)
```

The PR explicitly describes the problem as outdated share price when rewards have not been logged recently. Its emergency handling changes policy but not the underlying freshness signal.

## Why neither PR catches the reported exploit

Use the unchanged production timing values demonstrated by the local runner:

```text
max-reward        5 bps
max-deviation     7 bps
update-window     86,340 seconds
proposed SP stale 86,400 seconds
```

Attack timeline:

```text
t0             fresh log-reward succeeds
               last-log-ts = t0
               accounting NAV is fresh

t0 + epsilon   external strategy realizes a loss
               economic NAV is now lower
               accounting total-assets/share-price remain pre-loss

immediately     rewarder tries to record negative PnL
               -> blocked by update-window, or by max-reward if loss > 5 bps

same window     normal victim deposit succeeds at stale pre-loss NAV
               matured attacker claim is funded at stale pre-loss NAV
               attacker exits using the victim's newly supplied reserve principal
```

Under PR #137 during the entire critical part of that timeline:

```text
current-ts < last-log-ts + 86,400
is-sp-stale == false
```

So **the proposed protection explicitly allows both operations while the economic share price is already stale**.

The first moment the proposed timestamp check becomes stale is about one day after `t0`. The production loss-accounting window itself lasts 86,340 seconds, so the vulnerable interval created by a post-log external loss almost completely overlaps the entire period in which an immediate corrective NAV update is forbidden.

## Root-cause distinction

### PR #119 / #137 root cause

```text
keeper does not refresh share price for too long
    -> last-log-ts becomes old
    -> block price-sensitive operations
```

### Reported root cause

```text
fresh accounting snapshot
    -> external strategy loss becomes economically final
    -> timestamp remains fresh but NAV becomes wrong immediately
    -> loss update is rate/time gated by state.update-state
    -> price-sensitive operations remain open
```

A freshness timestamp is therefore not a proof that the current external strategy value still equals the accounting NAV.

## Relationship to Clarity Alliance M-03

M-03 concerned a different stale-price source: the old redemption design fixed the claim's asset amount at request time. The remediation moved the price snapshot to `fund-claim()` so negative PnL occurring between request and funding would be reflected.

The current exploit uses that remediated design exactly as intended:

- the claim has no fixed asset amount at request time;
- the external loss happens after a fresh NAV log;
- the claim is priced at `fund-claim()` time;
- but the **funding-time accounting share price itself is stale** because contracts prevent immediate reconciliation of the already-realized loss.

So the report should be framed as an **incomplete remediation / bypass of M-03's security assumption**, not a resubmission of the original request-time snapshot bug.

## Strong triager objection and answer

**Objection:** "This is already known because PR #119/#137 attempted stale share-price protection."

**Answer:** Those PRs only detect age since the last reward log. The PoC deliberately performs a fresh reward log first, realizes the loss afterwards, and exploits the vault before the timestamp can become stale. Re-applying either PR's exact `is-sp-stale()` logic would return `false` throughout the exploit. Therefore the known PRs neither describe nor mitigate the reported post-log realized-loss state.

## Submission positioning

Primary impact should remain:

**Critical — Direct theft of user funds, other than unclaimed yield.**

The strongest production-limit proof is `run-live-limits-value-transfer-poc.mjs`: with `max-reward=5`, `max-deviation=7`, and `update-window=86340` unchanged, a 6 bps realized loss lets a matured claimant exit at stale NAV. After the loss is fully reconciled across the mandatory accounting windows, the attacker's avoided loss is exactly equal to the later depositor's incremental loss.
