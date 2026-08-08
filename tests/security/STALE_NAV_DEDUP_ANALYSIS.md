# Stale-NAV finding — known-issue / duplicate analysis

## Conclusion

The realized-loss exploit is **not the same executable condition as Clarity Alliance M-03, upstream PR #119, or PR #137**.

The strongest distinction is now executable in one CI suite:

1. the exact old M-03 request-time lock-in is reproduced as a negative control and **does not work** on current code;
2. the report begins with a successful **fresh** `log-reward()` and only then realizes a new external loss;
3. the loss is already economically real while the accounting timestamp remains fresh;
4. `state::update-state` prevents immediate negative-NAV reconciliation because the update window is closed;
5. a mature standard claim can then be funded at stale funding-time NAV;
6. an unrelated **non-manager** can execute the permissionless funding path;
7. later reconciliation proves that the claimant's avoided loss is shifted to another holder/depositor.

The remaining duplicate risk is therefore a **bounty-policy risk**: Hermetica and its auditors were clearly aware of the broader stale-share-price / negative-PnL class. A program may decide to classify the new trigger as part of that known class even though the old mechanism and proposed timestamp remediation are both falsified by the current executable controls.

---

## 1. Exact Clarity Alliance M-03 behavior is fixed

M-03 concerned a request-time snapshot: the old design could commit a claim's assets before negative PnL was reflected.

The current remediation moves the asset calculation to `fund-claim()`.

Executable control:

```text
tests/security/stale-nav/run-triager-m03-separation-and-timing-poc.mjs
```

The control deliberately creates a claim while accounting NAV is stale. Immediately after `request-redeem()` the claim stores:

```text
assets      = none
share-price = none
```

The loss is then reconciled **before** funding. Current code funds and redeems the claim at the corrected price.

Therefore the original M-03 mechanism is absent: request-time staleness no longer locks a stale payout.

### Root-cause difference

Old M-03:

```text
loss already exists
-> request-redeem snapshots stale value
-> later accounting correction cannot change already-fixed claim
```

Reported condition:

```text
claim is already mature but still unpriced
-> fresh log-reward succeeds
-> NEW external loss occurs after that fresh log
-> accounting timestamp is fresh but economic NAV is now wrong
-> immediate correction is blocked by update-window
-> fund-claim calculates assets now, using stale funding-time NAV
```

The report therefore targets **funding-time economic staleness created after a fresh accounting snapshot**, not the fixed request-time snapshot bug.

---

## 2. PR #119 and PR #137 do not detect the reported condition

### PR #119

PR #119: `feat: implement stale share price protection in vault`

Status: **closed, not merged**. It treated staleness as elapsed time since `last-log-ts`, primarily addressing keeper downtime.

Its proposed model was equivalent to:

```clarity
(define-read-only (is-sp-stale)
  (> current-time (+ last-log-ts staleness-window-sp))
)
```

### PR #137

PR #137: `feat: add share price staleness protection with emergency bypass`

Status: **closed, not merged**.

It retained the same timestamp-age predicate:

```clarity
(define-read-only (is-sp-stale)
  (>= current-time (+ last-log-ts staleness-window-sp))
)
```

### Executable counterfactual

The validation suite contains an exact shadow of the relevant PR #137 predicate:

```text
tests/security/stale-nav/pr137-shadow.clar
```

Observed sequence:

```text
fresh log-reward                     -> success
new external loss                    -> success
PR137 is-sp-stale                    -> false
immediate corrective log-reward      -> blocked
PR137 is-sp-stale                    -> false
stale fund-claim                     -> success
```

A timestamp can therefore be perfectly fresh while economic NAV became stale seconds later.

---

## 3. Production limits do not remove the root cause

Source defaults used by the production-contract runners:

```text
max-reward      5 bps
max-deviation   7 bps
```

A dedicated minimal runner uses a **1 bp** realized loss, below both limits:

```text
tests/security/stale-nav/run-1bp-minimal-loss-poc.mjs
```

Immediate reconciliation still fails because `update-window` is closed immediately after the fresh log.

A separate live read observed the deployed update window at approximately 23 hours (`u82800`) at the sampled mainnet state; the source default used by local production-contract fixtures is `u86340`.

The distinction does not affect the root cause: both create a long interval after a fresh log during which a new external loss can be economically final while negative-NAV accounting cannot be committed.

---

## 4. No attacker-vs-keeper race or privileged funder is required

This was a material triage concern and now has a dedicated executable control:

```text
tests/security/stale-nav/run-zero-reserve-neutral-funder-poc.mjs
```

The control uses only a standard claim and normal protocol roles.

### Timeline

```text
attacker + existing holder deposit 1.00 sBTC
-> attacker requests standard redeem and waits for maturity
-> all 1.00 sBTC Reserve liquidity is deployed externally
-> Reserve = 0
```

Before the adverse event, an unrelated non-manager tries to fund the mature claim:

```text
fund-claim -> revert because Reserve has no sBTC
claim.assets remains none
```

So there is no opportunity for a keeper to safely pre-fund and eliminate the option while Reserve is empty.

Then:

```text
fresh log-reward
-> new 1 bp external loss
-> immediate correction blocked by update-window
-> ordinary third-party deposit adds 0.40 sBTC to Reserve at stale NAV
```

The same third party is explicitly verified to be **not a manager**, yet can now call the post-cooldown permissionless funding path:

```text
non-manager fund-claim -> success
attacker redeem        -> success
```

After later NAV reconciliation:

```text
attacker fair loss avoided = 4,000 sat
pre-existing 60% holder fair loss = 6,000 sat
later depositor loss = 4,000 sat
```

The later depositor absorbs the claimant's avoided 40% share of the already-realized loss.

### Consequence

The exploit does **not** require:

- attacker privilege;
- attacker to call `fund-claim()` personally;
- a malicious keeper;
- attacker to front-run a manager;
- prediction that a keeper will intentionally leave a liquid mature claim unfunded.

A zero-Reserve strategy state naturally keeps the mature claim unfunded until new liquid principal arrives after the adverse event.

---

## 5. Live standard exit fee does not erase the minimal economics

A dedicated read-only mainnet probe is part of the same green workflow:

```text
tests/security/standalone/read-live-hbtc-fees.mjs
```

The probe asserts the current effective **standard** exit fee is:

```text
0 bps
```

and the CI step `Verify live hBTC standard exit fee` passes.

The exploit uses a **standard** redeem claim, not express redeem, so the express fee is irrelevant to this path.

This removes the simple rejection that a fixed current exit fee necessarily costs more than the claimant's avoided loss in the 1 bp counterexample.

The economic transfer also scales linearly with the claimant's ownership share and the realized holder loss; the 1 bp runner is intentionally a minimal correctness proof, not a claimed maximum extraction amount.

---

## 6. Reserve Fund does not eliminate the condition

Runner:

```text
tests/security/stale-nav/run-reserve-fund-buffer-loss-shift-poc.mjs
```

It supplies a physical Reserve Fund and creates a gross strategy loss larger than the RF buffer.

`controller::log-reward()` invokes `check-max-reward(reward)` on the **gross** reward/loss before the RF handling branch. Therefore an oversized gross adverse event can be rejected before RF transfer/reconciliation is committed.

After RF ultimately absorbs its portion, the remaining holder loss is still shifted away from the stale claimant in exact proportion to the claimant's ownership.

Thus RF reduces eventual holder loss but is not a synchronous mark-to-market mechanism that makes `fund-claim()` safe after an external loss.

---

## 7. Production strategy-loss semantics are not invented by the helper

The suite separately retrieves deployed source for the currently authorized Zest v0-4 market.

The deployed liquidation flow:

- is callable by a normal direct account when liquidation conditions are met;
- repays debt;
- seizes collateral including a liquidation penalty;
- sends seized collateral to the liquidator/receiver;
- contains no synchronous callback to hBTC `controller-hbtc::log-reward` or `state-hbtc-v1::update-state`.

A liquidation penalty is therefore a real reduction in the Hermetica strategy account's equity, while hBTC accounting can remain at the previous NAV until a separate reward/accounting transaction occurs.

The local strategy-loss helper models that economic boundary; it is not evidence that an arbitrary attacker can directly steal from the helper contract.

---

## 8. Current-state reachability must be disclosed

At the most recent read-only observation used by the validation suite, the hBTC Zest position was closed / inactive.

Therefore the report should **not** claim that an unhealthy live position is available for immediate exploitation at the observation block.

However:

- Zest v0-4 remains authorized in hBTC's external registry;
- the production integration remains enabled;
- historical on-chain state demonstrates that the same hBTC integration previously held a large leveraged Zest position with essentially no liquid Reserve.

The vulnerable state is therefore part of the intended strategy lifecycle, but exploitation is contingent on a future external adverse event while such a position is active.

This is a real severity/current-exploitability limitation and should be disclosed rather than hidden.

---

## 9. Strong triager objections and concise answers

### “This is M-03.”

The exact old M-03 ordering is now a negative control and pays the corrected value. The positive exploit starts with a fresh accounting snapshot and a **new loss afterwards**, leaving funding-time NAV stale.

### “PR #137 fixes stale share prices.”

The exact timestamp predicate is executed as a counterfactual and remains `false` throughout the exploit window.

### “Keeper can fund the claim before the attacker.”

In the zero-Reserve control nobody can fund before the event. New third-party liquidity arrives only after NAV became stale, and the non-manager depositor itself can permissionlessly crystallize the stale claim.

### “The exit fee makes this uneconomic.”

The current live effective standard exit fee is read as `0 bps`; the exploit uses a standard claim.

### “Reserve Fund covers losses.”

RF is not a synchronous external-NAV oracle. Gross loss can be rejected before RF handling, and a buffered test still produces exact holder-to-claimant loss shifting.

### “No real strategy can create this loss.”

Deployed Zest liquidation explicitly removes borrower equity via collateral penalty and does not synchronously update hBTC NAV.

### “It is immediately exploitable today.”

No. The latest observed Zest position is closed. The report should claim lifecycle reachability, not a currently liquidatable target.

---

## 10. Submission positioning

### Technical impact

Once the vulnerable lifecycle state exists, stale claim funding causes a deterministic reallocation of a **realized principal loss** from the claimant to other holders/depositors.

That supports the impact category:

```text
Direct theft / direct loss of user funds, other than unclaimed yield
```

because the A/B controls show the claimant receives value that remains in the system when NAV is reconciled before funding, and another user subsequently loses the same economic amount.

### Severity caveat

A **Critical-impact argument is technically defensible**, but the report has two material triage risks:

1. broad prior awareness of stale-share-price / negative-PnL withdrawal timing from M-03 and later PRs;
2. the currently observed external strategy position is closed, making the issue lifecycle-contingent rather than immediately exploitable at the sampled block.

The most accurate posture is:

**strong technical Critical-impact candidate with meaningful known-issue/current-state severity risk.**

Do not hide either risk from the submission.

---

## CI evidence

The consolidated validation workflow independently passes all of the following steps in the same run:

```text
M-03 separation + mature-claim timing triager control
minimal 1bp stale-NAV value-transfer PoC
zero-reserve neutral-funder stale-NAV PoC
live-limits stale-NAV blocking/value-transfer controls
existing-holder loss-shift control
Reserve-Fund-buffered loss-shift control
live hBTC standard exit-fee probe
deployed Zest v0-4 liquidation-source semantics
live hBTC external registry reconstruction
live hBTC PROTOCOL-role reconstruction
```

This is intentionally broader than a single happy-path PoC: the suite contains negative controls, counterfactual known fixes, live configuration reads, and external deployed-source evidence.