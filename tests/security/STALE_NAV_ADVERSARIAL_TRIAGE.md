# hBTC post-log stale NAV — adversarial triager review

This document intentionally argues **against** the finding first. Each objection is treated as a potential rejection reason. A rejection is marked disproven only where production source, deployed source, or an executable counterfactual falsifies it.

## Bottom line

The technical finding survives hostile review.

The remaining meaningful uncertainty is not whether stale funding-time NAV can shift realized loss between holders. That is executable and causally controlled. The residual uncertainty is bounty policy and current-state feasibility:

1. M-03 / PR #119 / PR #137 establish broad prior awareness of stale-share-price risk, so a program may still apply a broad known-issue policy despite the different trigger and failed prior remediation predicate.
2. The hBTC Zest position is closed at the current observation block, so the report establishes lifecycle reachability rather than an immediately liquidatable current target.
3. A fast guardian pause can reactively narrow the exploitation window if the adverse event is detected before `fund-claim()` reaches the Reserve transfer path.

Everything else below was challenged and either disproven or materially narrowed.

---

## Objection 1 — “This is exactly Clarity Alliance M-03”

### Triager rejection

> M-03 already found that stale share price lets withdrawing users escape negative PnL. This is the same issue with different wording.

### Test that would support the rejection

Reproduce the old M-03 attack against current code:

```text
loss already exists
-> request-redeem while accounting price is stale
-> reconcile loss before funding
-> old request still pays stale amount
```

If that succeeds, the report is merely M-03.

### Result: exact M-03 behavior is fixed

Executable control:

```text
tests/security/stale-nav/run-triager-m03-separation-and-timing-poc.mjs
```

The control deliberately creates a claim while accounting NAV is stale.

Immediately after `request-redeem()` the current claim stores:

```text
assets      = none
share-price = none
shares      = 40,000,000
```

The 1.2 bp loss is then reconciled **before** funding.

Current code funds the old claim at the corrected price:

```text
corrected share price = 99,988,000
fund-claim             = 39,995,200 sat
redeem                 = 39,995,200 sat
```

Final assertion:

```text
PASS OLD-M03 NEGATIVE CONTROL:
request-time staleness does not lock assets or price;
once NAV is corrected before funding, current code pays exactly 39,995,200 sats.
```

### Why the reported path still succeeds

The positive half of the same runner changes the event ordering:

```text
claim is already mature
-> fresh log-reward
-> NEW external loss occurs after the fresh log
-> accounting cannot immediately record the new loss
-> fund-claim calculates assets only now, but at economically stale funding-time NAV
```

This produces an exact no-rounding loss shift:

```text
realized loss                12,000 sat
attacker fair share (40%)     4,800 sat
victim fair share (60%)       7,200 sat

attacker avoided loss         4,800 sat
victim incremental loss       4,800 sat
```

Therefore the original request-time M-03 mechanism is demonstrably absent while the new funding-time adverse-event mechanism remains exploitable.

### Verdict

**Technical duplicate objection: DISPROVEN.**

**Broad known-issue policy objection: SURVIVES.** The project can still elect to treat the entire stale-share-price security class as previously known.

---

## Objection 2 — “PR #137 already fixes this”

### Triager rejection

> The project already designed stale-price protection for `deposit()` and `fund-claim()`.

### Counterfactual

The validation suite includes:

```text
tests/security/stale-nav/pr137-shadow.clar
```

which reproduces the relevant PR #137 timestamp predicate:

```clarity
current-time >= last-log-ts + 86400
```

The attack begins with a successful fresh `log-reward()`.

A new loss then occurs after that log.

Observed sequence:

```text
fresh log-reward                         -> success
external loss after fresh log            -> success
PR137 is-sp-stale                        -> false
immediate corrective accounting          -> rejected
PR137 is-sp-stale                        -> false
stale fund-claim                         -> success
```

In the larger demonstrative run the loss was already real only about 20 seconds after the fresh log.

### Verdict

**DISPROVEN technically.** Timestamp age cannot detect an adverse event that occurs after a fresh accounting update.

PR #137 remains important prior art for policy disclosure, but its proposed predicate does not prevent this exploit.

---

## Objection 3 — “The attacker must predict a liquidation days in advance”

### Triager rejection

> A standard claim has a cooldown. The attacker cannot know several days beforehand that an external strategy loss will happen at the right moment.

### Executable challenge

The adversarial runner explicitly proves:

```text
request standard claim #1
-> wait until mature
-> cancel-redeem(#1)
-> all 40,000,000 hBTC shares returned
-> request standard claim #2
-> wait until mature
-> fresh log-reward
-> loss occurs only afterwards
-> use claim #2
```

`cancel-redeem()` works on an unfunded claim even after the cooldown has elapsed.

The attacker can therefore maintain/re-arm a mature withdrawal option rather than predict the adverse event before the first cooldown starts.

### Remaining practical cost

This is not a free option: while armed, the attacker's hBTC shares are escrowed in the claim and cannot be used normally. Re-arming after cancellation restarts the cooldown.

### Verdict

**Prediction requirement: DISPROVEN.**

**Capital opportunity cost: REAL but not a correctness refutation.**

---

## Objection 4 — “The Reserve Fund absorbs the strategy loss, so holders are not harmed”

### Triager rejection

> hBTC has a Reserve Fund specifically for negative rewards. The PoC without RF is economically incomplete.

### Production-like RF counterexample

Runner:

```text
tests/security/stale-nav/run-reserve-fund-buffer-loss-shift-poc.mjs
```

Attack-time state:

```text
hBTC accounting assets  1.00 sBTC
attacker                 40%
victim                   60%
Reserve                  0.50 sBTC
strategy                 0.50 sBTC
Reserve Fund             240,000 sat = 24 bps
max-reward               5 bps
max-deviation            7 bps
gross realized loss      300,000 sat = 30 bps
```

Production `controller.log-reward()` calls `state.check-max-reward(reward)` on the **gross** loss before entering the RF coverage branch.

Therefore:

```text
30 bps gross loss -> ERR_ABOVE_MAX
```

The failed transaction rolls back RF transfer and leaves accounting NAV stale.

The mature claimant exits from existing Reserve.

Later, after governance recovery, RF covers 240,000 sat and exactly 60,000 sat remains as holder loss.

Final exact allocation:

```text
attacker fair loss             24,000 sat
victim fair loss               36,000 sat

attacker avoided loss          24,000 sat
victim actual loss             60,000 sat
victim incremental loss        24,000 sat
```

No rounding discrepancy exists.

### Verdict

**DISPROVEN.** RF reduces the final holder loss but does not prevent stale exit when the gross loss is rejected before RF handling.

---

## Objection 5 — “This is just normal strategy-loss socialization, not theft/value transfer”

### Triager rejection

> One holder exits, another holder remains. Of course the remaining holder later experiences more loss.

### Causal A/B test

Runner:

```text
tests/security/stale-nav/run-reconciled-control.mjs
```

The control holds constant:

- same production hBTC contracts;
- same vault balances;
- same claimant shares;
- same external loss;
- same later liquidity where applicable.

Only ordering changes.

Attack ordering:

```text
loss -> stale funding -> attacker exits -> reconcile
```

Control ordering:

```text
loss -> reconcile -> funding -> attacker exits
```

In the 0.10 sBTC demonstration:

```text
attack payout      0.40 sBTC
fair/control payout 0.36 sBTC
excess              0.04 sBTC
```

The correctly ordered control leaves the 0.04 sBTC in the system rather than giving it to the claimant.

In the RF scenario the no-rounding invariant is even cleaner:

```text
attacker avoided loss == victim incremental loss == 24,000 sat
```

### Verdict

**DISPROVEN.** The stale ordering deterministically reallocates a loss that the claimant economically owned to another holder.

---

## Objection 6 — “The PoC only works because the loss is unrealistically large or test limits were relaxed”

### Triager rejection

> `max-reward` and `max-deviation` would stop the demonstrated state in production.

### Minimal counterexample

The suite contains both 1 bp and 1.2 bp examples with production defaults:

```text
max-reward      5 bps
max-deviation   7 bps
loss            < 5 bps and < 7 bps
```

Immediate loss accounting still fails solely because `update-window` is closed after the fresh log.

The 1.2 bp adversarial control produces exact no-rounding economics:

```text
attacker avoided loss      4,800 sat
victim incremental loss    4,800 sat
```

### Verdict

**DISPROVEN.** Exceeding a magnitude cap is not required for the root cause.

---

## Objection 7 — “The strategy helper invents a kind of loss Zest cannot create”

### Triager rejection

> The local helper simply removes sBTC. Real Zest liquidation repays debt and may merely transform the position rather than reduce Hermetica equity.

### Deployed-source test

Independent workflow:

```text
.github/workflows/zest-liquidation-source-evidence.yml
```

Read-only source is fetched from the deployed contract:

```text
SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market
```

The resulting source artifact is generated from the Hiro deployed-contract source endpoint, not a local model.

The deployed liquidation contains:

```clarity
(calc-liq-collateral-repay debt-repay liq-penalty)
=> debt-repay * (BPS + liq-penalty) / BPS
```

`process-collateral-asset()` uses that value to calculate expected collateral seizure.

The public `liquidate()` then:

1. repays the borrower's debt with `vault-system-repay`;
2. removes the corresponding scaled debt from the borrower;
3. calls `.v0-market-vault collateral-remove` for `coll-final`;
4. sends seized collateral to the liquidator / requested receiver;
5. reports both `debt-repaid` and `collateral-seized`, including `liq-penalty-bps`.

Thus, where collateral is sufficient, the borrower loses collateral worth the repaid debt **plus the liquidation penalty**. Debt removal offsets the debt principal portion, while the penalty is a real reduction of borrower equity.

The deployed `liquidate()` also contains:

```clarity
(asserts! (is-eq contract-caller tx-sender) ERR-AUTHORIZATION)
```

so a direct standard account can execute a valid liquidation when the health conditions are met.

The deployed form contains no call to:

```text
state-hbtc
controller-hbtc
log-reward
update-state
```

The isolated evidence workflow asserts:

```text
synchronous_hbtc_nav_callback = false
```

and passes.

### Verdict

**DISPROVEN as a semantic objection.** The helper abstracts a real external equity-loss event: deployed Zest liquidation explicitly charges a collateral penalty and does not synchronously reconcile Hermetica NAV.

### Remaining magnitude question

The exact realized hBTC loss from any particular future liquidation depends on the future position size, health, collateral/debt prices, e-group penalty parameters, and RF state. The report should not claim a specific future loss amount unless those future values exist on-chain.

---

## Objection 8 — “The current hBTC Zest position is closed, so the exploit is not currently executable”

### Evidence supporting the rejection

Current read-only position state reports:

```text
mask = 0
```

The observation block therefore contains no open Hermetica Zest position to liquidate.

### Evidence against permanent unreachability

Current hBTC configuration still authorizes the v0-4 Zest market and its sBTC/USDh vaults.

The same production hBTC Zest interface has historically operated a v0-4-era leveraged position, including a state with roughly 73.81247997 sBTC collateral, non-zero USDh debt, and essentially no hBTC Reserve liquidity.

So the required external-position state is part of the intended production lifecycle, not a malicious replacement strategy.

### Verdict

**PARTIALLY SURVIVES.**

The finding is lifecycle-reachable but not immediately executable against a currently open unhealthy Hermetica Zest position at the observation block.

This is one of the strongest legitimate triage arguments against Critical/current exploitability and must be disclosed.

---

## Objection 9 — “Guardian can pause the protocol before a stale claim is funded”

### Evidence supporting the rejection

The hBTC Reserve transfer path checks protocol/transfer authorization. A successful emergency disable can therefore block the transfer needed to fund the claim.

### Why it is not a correctness fix

There is no atomic production invariant that does:

```text
external adverse event
-> synchronously mark hBTC NAV invalid / pause exits
-> only then allow another user transaction
```

Zest liquidation is external and permissionless; hBTC accounting is not synchronously called by it.

Therefore protection depends on off-chain detection and a guardian transaction winning the race before stale `fund-claim()`.

### Verdict

**PARTIAL MITIGATION, NOT A REFUTATION.**

It narrows practical exploitation and may influence severity, but it does not make stale funding-time NAV correct.

---

## Objection 10 — “The team already knew the broader stale-share-price problem, so this is ineligible regardless of technical distinction”

### Evidence supporting the rejection

This is the strongest surviving bounty-policy argument:

- Clarity Alliance M-03 addressed stale share price and escaping negative PnL through withdrawal timing.
- merged PR #89 changed request-time pricing to funding-time pricing.
- closed PR #119 considered stale share price at `deposit()` / `fund-claim()`.
- closed PR #137 proposed timestamp-age stale-price protection for those flows.

The team therefore had clear prior awareness of the broader stale-share-price security class.

### Evidence against exact-known classification

The current report is executable after the M-03 fix and after applying the exact PR #137 timestamp predicate as a counterfactual.

The old M-03 mechanism is separately proven fixed.

PR #137's predicate remains false during the new exploit.

Therefore neither published remediation mechanism captures the actual state predicate:

```text
an adverse external event occurred after the last accounting update
```

### Verdict

**SURVIVES AS POLICY RISK.**

This cannot be disproven technically because eligibility is ultimately the program's interpretation of “known issue.”

The correct submission posture is full disclosure, followed immediately by the executable old-M03 negative control and PR137 counterfactual.

---

# Hostile final verdict

If I were rejecting this as a triager, the strongest defensible rejection would no longer be:

```text
false positive
no loss
Reserve Fund prevents it
requires a new depositor
requires predicting liquidation
PR137 fixes it
same executable M-03 bug
helper invents impossible Zest behavior
```

Those positions now have direct counterexamples.

The strongest remaining rejection would instead be:

```text
The broad stale-share-price / negative-PnL escape class was already known from M-03 and the team's later stale-price PRs, and the currently observed Zest position is closed, so we treat this as a known/lifecycle-contingent issue rather than a new currently exploitable Critical.
```

That is a materially narrower argument. It is a bounty-policy/current-state argument, not a technical falsification of the loss-shift vulnerability.

## Severity under hostile review

Technical impact once the vulnerable lifecycle state exists:

```text
direct deterministic reallocation of realized user loss / principal between holders
```

supports a Critical-impact argument.

However, a hostile severity review can reasonably push toward High or reject Critical because:

- an external strategy loss must first occur;
- the attacker must have a mature unfunded claim and sufficient Reserve liquidity must be present for the existing-holder path;
- current Zest position is closed at the observation block;
- guardian pause can reactively narrow the window;
- exact future loss magnitude is state dependent.

Therefore the strongest honest position is:

```text
Technical vulnerability: confirmed.
Exact M-03 duplicate: disproven.
PR137 remediation: disproven.
Production external-loss semantics: confirmed from deployed Zest source.
Current-block exploitability: not present at observation block.
Known-issue eligibility: unresolved policy risk.
Critical severity: defensible when an exposed strategy position exists, but not guaranteed under hostile triage.
```
