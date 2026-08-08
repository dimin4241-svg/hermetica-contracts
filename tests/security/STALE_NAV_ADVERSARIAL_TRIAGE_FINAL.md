# hBTC stale-NAV — final hostile triage after trying to reject the finding

This addendum records the final result after deliberately trying to invalidate the finding as a skeptical bounty triager.

It should be read together with:

- `STALE_NAV_ADVERSARIAL_TRIAGE.md`
- `STALE_NAV_IMMUNEFI_SUBMISSION_READY.md`
- `STALE_NAV_DEDUP_AND_CONTROL_EVIDENCE.md`

## Final conclusion

I could not technically falsify the loss-shift vulnerability.

The strongest remaining rejection is now a **policy/current-state argument**, not a false-positive argument:

```text
The broader stale-share-price / negative-PnL escape class was already known,
and there is no open Hermetica Zest position at the current observation block.
```

That argument is still real and should be disclosed. The arguments below were tested and no longer survive technically.

---

## 1. “This is exactly old M-03” — disproven executablely

The hostile control intentionally creates a redemption request while NAV is already stale.

Current claim storage immediately after request shows:

```text
assets      = none
share-price = none
shares      = 40,000,000
```

The loss is then reconciled before funding.

The current remediated code funds and redeems exactly at the corrected value:

```text
share price = 99,988,000
fund-claim  = 39,995,200 sat
redeem      = 39,995,200 sat
```

So the original M-03 request-time amount lock is not what makes the new exploit work.

In the positive half of the same runner:

```text
mature claim
-> fresh log-reward
-> NEW 1.2 bp external loss
-> immediate accounting blocked by update-window
-> PR #137 timestamp predicate remains false
-> fund at stale funding-time NAV
```

Exact result, with no rounding discrepancy:

```text
attacker avoided loss       4,800 sat
victim incremental loss     4,800 sat
```

Runner:

```text
tests/security/stale-nav/run-triager-m03-separation-and-timing-poc.mjs
```

---

## 2. “Attacker must predict liquidation days in advance” — disproven

The same runner proves:

```text
request claim #1
-> wait until mature
-> cancel-redeem(#1)
-> all shares returned
-> request claim #2
-> wait until mature
-> fresh log
-> adverse event occurs afterwards
-> use claim #2
```

A mature unfunded standard claim is therefore a cancellable/re-armable option.

The attacker does incur opportunity cost because hBTC is escrowed while a claim is armed. That is a real feasibility cost, but not a prediction requirement.

---

## 3. “Small PoCs are unprofitable because redemption fee exceeds the escaped loss” — disproven against current live state

Current read-only mainnet probe:

```text
LIVE_HBTC_GLOBAL_EXIT_FEE                 = 0 bps
LIVE_HBTC_STANDARD_EXIT_FEE_FOR_SAMPLE_USER = 0 bps
LIVE_HBTC_EXPRESS_EXIT_FEE                = 50 bps
```

The exploit uses a **standard** redemption, not express redemption.

Therefore the 1 bp / 1.2 bp / 6 bp structural loss-shift examples are not erased by the current protocol exit fee.

Probe:

```text
tests/security/standalone/read-live-hbtc-fees.mjs
```

Isolated evidence run:

```text
run 31269219323
job 93132257314
conclusion SUCCESS
```

---

## 4. “The local helper invents a loss that real Zest liquidation cannot create” — disproven from deployed source

The isolated workflow fetches the deployed source of:

```text
SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market
```

The deployed liquidation calculation includes:

```clarity
(define-private (calc-liq-collateral-repay
  (debt-repay uint)
  (liq-penalty uint))
  (mul-bps-down debt-repay (+ BPS liq-penalty)))
```

The collateral side uses the result to calculate collateral seizure, then `liquidate()`:

- repays borrower debt;
- removes scaled debt from the borrower;
- removes `coll-final` collateral from the borrower;
- transfers the seized collateral to the liquidator / requested receiver.

Economically, debt repayment cancels the debt principal while collateral equal to principal **plus liquidation penalty** is removed. The penalty portion is therefore a genuine borrower equity loss.

The deployed `liquidate()` also requires only:

```clarity
(asserts! (is-eq contract-caller tx-sender) ERR-AUTHORIZATION)
```

for the liquidator after its health/liquidation checks. It does not contain a synchronous callback to:

```text
state-hbtc
controller-hbtc
log-reward
update-state
```

The evidence workflow asserts:

```text
synchronous_hbtc_nav_callback = false
```

and passes.

Relevant files:

```text
tests/security/standalone/read-zest-v04-liquidation-source.mjs
tests/security/evidence/zest-v04-liquidation-source.txt
```

---

## 5. “Zest liquidation penalty is too small to matter” — current deployed values strongly contradict this

The hostile probe resolves the exact deployed e-group configuration through the current `v0-egroup.resolve()` contract.

Current asset IDs:

```text
sBTC  = 2
zsBTC = 3
USDH  = 8
```

Both hBTC-relevant configurations resolve successfully:

```text
sBTC + USDH
zsBTC + USDH
```

For both, deployed values are:

```text
LIQ-PENALTY-MIN  = 750 bps  = 7.5%
LIQ-PENALTY-MAX  = 1000 bps = 10%
LTV-LIQ-PARTIAL  = 7000 bps
LTV-LIQ-FULL     = 7500 bps
```

So the actual current liquidation penalty is orders of magnitude larger than hBTC's 5 bps accounting update ceiling.

This does **not** mean every liquidation causes >5 bps loss at the hBTC-vault level; vault-level loss depends on the position size relative to total hBTC assets. But the underlying Zest penalty itself is not a negligible friction.

Evidence:

```text
tests/security/standalone/read-zest-v04-egroup-values.mjs
tests/security/evidence/zest-v04-egroup-values.txt
```

---

## 6. “Hermetica never used economically meaningful v0-4 borrowing” — disproven by production transaction history

Read-only transaction reconstruction for:

```text
SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D.trading-hbtc-v1
```

found successful production `zest-open()` calls against the currently authorized `v0-4-market`.

At the exact previously identified `last-borrow-block`:

```text
block:       8,179,328
UTC:         2026-06-04T03:08:27Z
tx:          0x55853b39100c6d8a16bef522c3c82b32b1c6ab29dc347ae27d5941bd66e6f95a
function:    zest-open
market:      v0-4-market
borrow-token: USDh
borrow:      47,703.44361488 USDh
result:      success
```

A preceding call at block 8,178,883 borrowed:

```text
49,059.30443835 USDh
```

The recovered production history also includes larger successful `zest-open` calls, including approximately:

```text
188,174.67361762 USDh
389,034.98638745 USDh
```

These historical calls prove that the current v0-4 strategy was used with economically meaningful debt sizes. They do not, by themselves, prove the exact outstanding debt or liquidatable loss at every historical block, so the report should not combine amounts from different blocks as if they were one snapshot.

Evidence:

```text
tests/security/standalone/read-historical-hbtc-zest-opens.mjs
tests/security/evidence/hbtc-historical-zest-opens.json
```

---

## 7. “Reserve Fund means liquidation cannot hurt holders” — still disproven

The strongest RF PoC uses:

```text
RF buffer          24 bps
Gross loss         30 bps
max-reward          5 bps
max-deviation       7 bps
```

Production controller checks **gross loss** against `max-reward` before applying RF.

Therefore the 30 bps gross loss is rejected before RF can be used, stale NAV remains, and the claimant exits.

After later recovery:

```text
RF absorbs                  240,000 sat
holder loss remains          60,000 sat
attacker fair loss           24,000 sat
attacker avoided loss        24,000 sat
victim incremental loss      24,000 sat
```

Exact equality, zero rounding discrepancy.

---

# What a hostile triager can still legitimately argue

## A. Broad known-issue policy — survives

M-03 and closed PRs #119/#137 clearly demonstrate prior awareness of the broad stale-share-price / withdrawal-timing security class.

Technically:

- old M-03 is separately proven fixed;
- PR #137's timestamp predicate is separately proven ineffective against a post-fresh-log adverse event.

But a bounty program may still decide that “known issue” is defined broadly enough to cover the class rather than the exact root cause/remediation bypass.

This cannot be disproven by another PoC because it is an eligibility-policy decision.

## B. No currently open Hermetica Zest position — survives

At the current observation block:

```text
position mask = 0
```

So there is no immediately liquidatable open Hermetica position right now.

The strategy state is demonstrably lifecycle-reachable and historically used under v0-4, but current-block exploitability is not present.

This is a legitimate argument against describing the issue as “exploitable right now.”

## C. Guardian pause can narrow the race — survives as mitigation

A successful protocol disable can block the Reserve transfer needed by `fund-claim()`.

However, Zest liquidation does not synchronously update/pause hBTC. Protection therefore depends on external detection and a guardian transaction winning the race before stale claim funding.

This is a real practical mitigation, but not a correctness fix.

---

# Final hostile verdict

After attempting to reject the report, the following rejection language is no longer technically defensible:

```text
false positive
same executable M-03 bug
PR #137 fixes it
Reserve Fund prevents holder loss
attacker must predict liquidation days ahead
small attack is erased by current exit fee
helper models an impossible external loss
Zest liquidation penalty is negligible
Hermetica did not use the current v0-4 borrowing path
```

The strongest remaining rejection is:

```text
We consider the broader stale-share-price / negative-PnL escape class already known,
and the current production Zest position is closed, so we do not accept this as a new currently exploitable Critical.
```

That is a policy/current-state rejection, not a technical falsification.

## Final classification after hostile review

```text
Technical vulnerability               CONFIRMED
Causal holder-to-holder loss shift     CONFIRMED
Old M-03 exact mechanism               FIXED / NOT the new exploit
PR137 timestamp remediation            BYPASSED executablely
Mature-claim timing feasibility        CONFIRMED; claim can cancel/re-arm
Current standard exit fee              0 bps
Deployed Zest equity-loss semantics    CONFIRMED
Deployed relevant liquidation penalty 7.5%–10%
Historical v0-4 borrowing             CONFIRMED
Current open Zest position            NO
Broad known-issue eligibility          UNRESOLVED POLICY RISK
Critical severity                      DEFENSIBLE CONDITIONALLY, NOT GUARANTEED
```
