# hBTC stale-NAV finding — de-duplication, causal control, and production-limit evidence

This appendix is intended to accompany `tests/security/STALE_NAV_M03_BYPASS_REPORT.md`.

It focuses on the two questions most likely to decide triage:

1. Is the reported exploit merely the already-known M-03 / PR #119 / PR #137 stale-price issue?
2. Is the observed value transfer actually caused by stale funding-time NAV, rather than being the normal allocation of a strategy loss?

The answer to both questions is demonstrated executablely below.

---

## 1. One-line distinction

The reported issue is **post-log economic staleness**, not **old-timestamp staleness** and not **request-time price locking**.

The vulnerable sequence is:

```text
fresh log-reward at T0
    -> external strategy realizes loss after T0
    -> hBTC accounting cannot record the loss because of max-reward/update-window
    -> last-log-ts is still fresh
    -> later user deposits principal at pre-loss NAV
    -> mature old claim is funded at the same pre-loss NAV
    -> claimant exits above fair post-loss value
    -> later depositor absorbs the escaped loss when NAV is finally reconciled
```

This is materially different from the previously discussed cases.

---

## 2. De-duplication matrix

| Item | Trigger / source | Vulnerable pricing point | Proposed / merged fix | Does that fix this report? |
|---|---|---|---|---|
| Clarity Alliance M-03 / PR #89 | Share price may be stale when user **requests** redemption | Claim assets were fixed at `request-redeem()` time | Store shares, defer asset calculation until `fund-claim()` | **No.** This report uses the remediated flow. No asset amount is fixed at request time. The funding-time share price itself becomes economically stale after a later realized loss. |
| PR #119 | `log-reward` has not been called for a configured amount of time | `deposit()` / `fund-claim()` use an old timestamped share price | Block operations if `current_time > last-log-ts + 86400` | **No.** The exploit starts immediately after a fresh log, so this predicate is false. |
| PR #137 | Same timestamp-age model, with emergency semantics | `deposit()` / `fund-claim()` when `last-log-ts` is at least one day old | `is-sp-stale := current_time >= last-log-ts + 86400` | **No.** The exact PR #137 predicate remains false after the strategy loss and during the exploit. This is proven in CI. |
| This report | **Real external loss occurs after a fresh log**, while negative accounting is rate/time limited | `fund-claim()` reads pre-loss `state.get-share-price()` even though the economic NAV changed after the last log | Requires adverse-event-aware reconciliation/pause or immediate loss accounting, not merely an age-of-last-log guard | N/A |

The common high-level word "stale" is not sufficient to make these the same vulnerability. The state predicate that becomes false, the triggering event, the exploit ordering, and the necessary remediation are different.

---

## 3. M-03 is an incomplete remediation, not the same exploit

PR #89 changed the redemption model so that a claim stores shares and the asset amount is calculated only when the claim is funded.

That removes the original request-time lock-in:

```text
OLD M-03
request-redeem at stale price
    -> fixed asset amount
    -> later loss update
    -> old fixed amount remains payable
```

The current report does not use that behavior:

```text
CURRENT REMEDIATED FLOW
request-redeem
    -> stores shares only
    -> claim may wait for days
    -> fresh log-reward occurs
    -> strategy loss happens AFTER the fresh log
    -> funding-time price is now economically stale
    -> fund-claim calculates the excessive amount only now
```

Therefore the exploit is not preserved by an old claim amount. It is created at the **new funding-time snapshot introduced by the remediation**.

The security assumption made by the remediation is effectively:

```text
"current accounting share price at fund-claim time" == "current economic NAV"
```

The executable tests falsify that assumption.

---

## 4. Exact executable counterfactual against PR #137

PR #137 proposed a timestamp-only share-price guard equivalent to:

```clarity
(define-read-only (is-sp-stale)
  (>= current-time (+ last-log-ts u86400))
)
```

The validation branch includes a test-only exact shadow of that predicate:

```text
tests/security/stale-nav/pr137-shadow.clar
```

The production hBTC contracts remain unchanged.

The primary exploit runner records a fresh `log-reward()`, then realizes the external loss immediately afterwards and evaluates the exact PR #137 predicate before the victim deposit and before claim funding.

Observed CI output:

```text
fresh last-log-ts: 1786627268
current ts after fresh log: 1786627268

external strategy realizes 0.10 sBTC loss: (ok true)
immediate negative NAV update is blocked: (err u102011)

PR137 shadow: seconds since fresh log after realized loss = 20
PR137 shadow: is-sp-stale after realized loss = false

victim deposits 0.40 after loss: (ok u40000000)
permissionless fund matured claim: (ok u40000000)
```

The runner asserts that the PR #137 predicate is `false`:

1. immediately after the fresh log;
2. after the external loss has become real;
3. before the victim deposit; and
4. before stale `fund-claim()`.

Final assertion:

```text
PASS PR137 COUNTERFACTUAL: PR #137 timestamp staleness remains false after a fresh-log strategy loss, so it would allow both the victim deposit and stale fund-claim.
```

This is the strongest de-duplication evidence: **even if PR #137's proposed guard were applied exactly, it would not prevent the reported exploit.**

The reason is fundamental: timestamp freshness only proves that accounting was updated recently. It cannot prove that no adverse external event occurred after that update.

---

## 5. Causal A/B negative control

A separate runner proves that the 0.04 sBTC transfer is caused specifically by stale funding-time NAV rather than normal strategy-loss allocation:

```text
tests/security/stale-nav/run-reconciled-control.mjs
```

It uses the same:

- production hBTC contracts;
- 1.00 sBTC pre-loss vault;
- 0.40 hBTC mature attacker claim;
- 0.10 sBTC realized external loss;
- 0.40 sBTC later victim deposit.

The only material ordering difference is that the negative control waits until the realized loss is successfully reconciled **before** the later deposit and `fund-claim()`.

### Exploit ordering

```text
loss
-> accounting still stale
-> victim deposits 0.40
-> attacker fund-claim = 0.40
-> attacker redeem = 0.40
-> later NAV correction

attacker fair post-loss value = 0.36
attacker excess               = 0.04
victim final value            = 0.36
victim loss                   = 0.04
```

### Reconciled control ordering

```text
loss
-> reconcile NAV to 0.90 first
-> victim deposits 0.40
-> victim receives 0.44444444 hBTC
-> attacker fund-claim = 0.36
-> attacker redeem = 0.36
```

Observed control output:

```text
reconcile loss before victim enters: (ok true)
victim deposit after reconciliation: (ok u44444444)
fund old claim at reconciled NAV: (ok u36000000)
redeem old claim at fair value: (ok u36000000)

control attacker payout raw:        36000000
control victim deposit raw:         40000000
control victim post-funding value:  39999999
control victim rounding loss raw:   1
```

The reserve retains exactly the 0.04 sBTC that disappears into the attacker's claim in the exploit ordering (subject only to the one-satoshi integer rounding in the victim's share conversion).

Final control assertion:

```text
PASS CONTROL: with identical realized loss and claim, reconciling NAV first reduces claimant payout to 0.36 sBTC and prevents the 0.04 sBTC transfer from the later depositor.
```

This is a causal A/B test of the root cause.

---

## 6. Exact value transfer under unchanged production accounting limits

The larger 0.10 sBTC PoC deliberately raises only the loss/deviation magnitude guards so the full 10% loss can eventually be applied in a compact test.

To eliminate any argument that those test settings create the exploit, a separate runner uses the unchanged production source defaults:

```text
tests/security/stale-nav/run-live-limits-value-transfer-poc.mjs
```

It verifies:

```text
max-reward      = 5 bps
max-deviation   = 7 bps
update-window   = 86,340 seconds in the tested source
```

It then realizes only a **6 bps** external loss.

### Accounting behavior

```text
full 6 bps negative update immediately -> ERR_ABOVE_MAX
victim 0.40 sBTC deposit               -> succeeds at stale NAV
mature old claim funding               -> succeeds at stale NAV
attacker redemption                    -> succeeds

after first accounting window:
full 6 bps update                       -> still ERR_ABOVE_MAX
5 bps partial update                    -> succeeds
remaining 1 bp                          -> ERR_WINDOW_CLOSED

after second accounting window:
remaining 1 bp                          -> succeeds
```

### Exact economic invariant after full reconciliation

```text
attacker stale payout raw:       40000000
attacker fair post-loss raw:     39976000
attacker excess exit raw:           24000
victim deposit raw:              40000000
victim post-reconciliation raw:  39976000
victim loss raw:                    24000
```

Therefore:

```text
attackerExcess == victimLoss == 24,000 satoshis
```

Final runner assertion:

```text
PASS LIVE-LIMIT VALUE TRANSFER: with max-reward=5bps, max-deviation=7bps and update-window=86340s unchanged, a 6bps realized loss lets a matured claimant avoid exactly 24,000 sats of loss, and a later depositor loses exactly the same 24,000 sats after full reconciliation. PR #137 exact timestamp-only staleness logic remains false during the exploit window.
```

This proves a direct value transfer without relaxing the relevant production loss/deviation guards.

---

## 7. Why `max-reward` makes the issue stronger than ordinary keeper delay

The live deployed hBTC state observed on 2026-08-08 reports:

```text
max-reward       = 5 bps
max-deviation    = 7 bps
update-window    = 82,800 seconds (~23 hours)
deposits         = enabled
request-redeem   = enabled
reward accounting= enabled
trading          = enabled
```

For a realized loss greater than 5 bps, the full correction is rejected by magnitude before the daily-window question is even relevant.

Recognizing an allowed partial loss then updates `last-log-ts`, which re-closes the window for the residual loss.

So this is not simply:

```text
"keeper failed to call log-reward quickly enough"
```

The unchanged contract policy can itself prevent full loss reconciliation while user entry and mature-claim funding remain available.

---

## 8. Current strategy reachability and honest feasibility boundary

The report does not claim that the current block contains an unhealthy, open Hermetica Zest position.

The current recorded hBTC Zest position is closed (`mask = 0`).

However, read-only production evidence establishes that:

- hBTC migrated from Zest `v0-3-market` to `v0-4-market`;
- `v0-4-market` is currently active in the hBTC external registry;
- `v0-vault-sbtc` and `v0-vault-usdh` are currently active;
- deployed `v0-4-market.liquidate()` allows a direct standard account to liquidate an unhealthy borrower;
- the same hBTC `zest-interface-hbtc-v1` production account previously held a large leveraged Zest position after the v0-4 migration;
- that historical production state included approximately `73.81247997 sBTC` collateral, non-zero USDh debt, and `0` sBTC in hBTC reserve.

Thus the required strategy state is an intended, demonstrated production lifecycle state under the current market generation, not an invented malicious configuration.

The precise current-block feasibility caveat should be disclosed rather than hidden: an open unhealthy position is not present at the observation block, but the protocol remains configured to create and operate the same class of strategy position.

---

## 9. Prior-awareness disclosure: PR #119 / #137 should be mentioned, not hidden

PR #119 and #137 are relevant prior art because the team publicly considered blocking `deposit()` and `fund-claim()` when the share-price timestamp was old.

They were not merged into the production branch.

This submission should disclose them explicitly because a triager will likely find them.

The key response is not that they are unrelated; it is more precise:

> They address a different freshness predicate. Their guard treats a share price as safe for up to one day after `log-reward`. The reported exploit deliberately begins with a fresh `log-reward`, then creates economic staleness through a realized external loss afterwards. The exact PR #137 predicate is executable in the PoC and remains `false` while the victim deposit and stale claim funding succeed.

That makes the distinction falsifiable rather than semantic.

---

## 10. Recommended triage wording

The submission should state early:

```text
This report is an executable bypass/incomplete remediation of M-03, not the original request-time snapshot issue.

I also reviewed the closed, unmerged share-price staleness PRs #119 and #137. Those PRs define staleness only from the age of last-log-ts. The attached PoC executes the exact PR #137 predicate and proves it remains false after a realized external strategy loss that occurs immediately after a fresh log-reward. The same run then allows both the later victim deposit and the stale fund-claim.

A negative-control run with the identical loss, claim and victim deposit but with NAV reconciled first reduces the claimant payout from 0.40 sBTC to the fair 0.36 sBTC and leaves the victim whole except for one satoshi of integer rounding. This proves that the 0.04 sBTC transfer is caused by the stale funding-time NAV ordering.

Finally, a second exploit run keeps max-reward=5 bps and max-deviation=7 bps unchanged and proves an exact 24,000-satoshi claimant gain / later-depositor loss from a 6 bps realized loss. Therefore the issue does not depend on relaxed production loss limits.
```

---

## 11. Evidence checklist

- [x] Current production hBTC contracts used unchanged for vault/accounting/redemption logic.
- [x] 0.04 sBTC attacker excess equals 0.04 sBTC later-depositor loss in primary PoC.
- [x] Negative A/B control proves the transfer disappears when NAV is reconciled first.
- [x] Exact PR #137 timestamp predicate modeled and proven `false` during exploit.
- [x] Unchanged production-limit PoC proves exact 24,000-satoshi value transfer from only a 6 bps loss.
- [x] Full 6 bps reconciliation requires more than one accounting window under 5 bps max-reward.
- [x] Current live loss/accounting parameters confirmed read-only.
- [x] Current Zest v0-4 authorization and permissionless liquidation semantics confirmed read-only.
- [x] Historical production hBTC Zest position confirms the strategy state has actually existed.
- [x] Current-position-closed feasibility caveat explicitly disclosed.
- [x] M-03 / PR #119 / PR #137 prior-art relationship explicitly disclosed.

The remaining uncertainty is triage policy, especially whether the program elects to classify the broader stale-share-price concept as a known issue despite the demonstrated difference in trigger and despite PR #137's proposed guard failing the reported exploit. The technical exploit and the distinction from the prior proposed timestamp guard are both executable.