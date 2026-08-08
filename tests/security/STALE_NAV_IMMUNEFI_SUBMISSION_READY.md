# [Critical] Post-log strategy losses can be escaped by matured hBTC claimants and shifted to other holders

## Summary

hBTC remains vulnerable to a stale-NAV redemption race after the remediation for Clarity Alliance M-03.

The original M-03 was fixed by moving redemption asset calculation from `request-redeem()` to `fund-claim()`. That prevents request-time amount locking, but it assumes that the share price read at `fund-claim()` is economically current.

That assumption is false when an external strategy loss becomes real **after a fresh `log-reward()`**.

A realized external loss does not synchronously reduce hBTC `state.total-assets`. The loss must later pass through `controller.log-reward()`, where production accounting applies `max-reward`, `update-window`, and `max-deviation` guards. During the interval in which the loss is already real but cannot yet be reflected in hBTC NAV, a matured standard redemption claim can still be funded using the stale pre-loss share price.

If the reserve already contains liquidity, no third-party action is needed: the claimant exits from pre-existing reserve and shifts the claimant's proportional share of the realized loss onto the remaining holders.

If strategy deployment has depleted the reserve, a later normal depositor can supply fresh reserve liquidity, which the matured claimant can immediately consume at stale NAV.

The validation suite proves both cases, proves the exact economic value transfer, proves a negative A/B control, and executes the exact timestamp staleness predicate proposed in closed PR #137 to show that it remains `false` throughout the exploit.

## Recommended severity

**Critical — Direct theft / unauthorized transfer of user principal through loss reallocation.**

The claimant receives more sBTC than the claim is economically entitled to after an already-realized strategy loss. The claimant's escaped loss is subsequently imposed on other hBTC holders.

No privileged attacker role, phishing, malicious token, oracle corruption, stolen key, or victim interaction with an attacker contract is required.

---

# Strongest production-like PoC: existing holder + Reserve Fund

This is the strongest exploit configuration because it removes the most likely triage objections:

- no later depositor is required;
- attacker and victim are both holders before the adverse event;
- reserve contains ordinary pre-existing liquidity;
- Reserve Fund is non-zero;
- `max-reward=5 bps` and `max-deviation=7 bps` are unchanged when the exploit occurs;
- PR #137's exact timestamp-only staleness predicate remains false;
- the economic shift is exact with no rounding discrepancy.

Runner:

```text
tests/security/stale-nav/run-reserve-fund-buffer-loss-shift-poc.mjs
```

### Initial state

```text
Vault accounting assets:      1.00 sBTC
Attacker ownership:            0.40 hBTC / 40%
Victim ownership:              0.60 hBTC / 60%
Reserve liquidity:             0.50 sBTC
External strategy capital:     0.50 sBTC
Reserve Fund:                  0.0024 sBTC = 24 bps
max-reward:                    5 bps
max-deviation:                 7 bps
```

The attacker has already requested a standard redemption for 0.40 hBTC and waited through the normal cooldown. The claim is mature but unfunded.

A fresh NAV update is committed:

```text
log-reward(0) -> (ok true)
```

Immediately afterwards, the external strategy realizes a 30 bps loss:

```text
realized strategy loss = 300,000 sat
```

The Reserve Fund could economically absorb 240,000 sat, leaving only 60,000 sat / 6 bps as holder loss.

However, the production controller checks the **gross** loss against `max-reward` before Reserve Fund handling. Therefore:

```text
log-reward(300,000 sat loss)
-> (err u102009) // ERR_ABOVE_MAX
```

The failed call rolls back; the Reserve Fund remains untouched and hBTC NAV remains at the pre-loss value.

At the same moment, the exact PR #137 timestamp predicate is still:

```text
is-sp-stale == false
```

because the loss occurred immediately after a fresh reward log.

### Attacker exits before the realized loss can be reflected

The mature claim remains fundable from the existing 0.50 sBTC reserve:

```text
fund-claim(attacker claim) -> 0.40 sBTC
redeem(attacker claim)     -> 0.40 sBTC
```

The attacker receives the full stale pre-loss value.

After this exit:

```text
remaining hBTC supply:       0.60 hBTC
accounting total-assets:     0.60 sBTC
actual economic strategy loss is still outstanding
```

### The stale exit also makes loss recovery harder

The same 300,000-sat gross loss is now 50 bps of the reduced 0.60 sBTC accounting denominator.

Therefore normal governance must first timelock-increase:

```text
max-reward: 5 bps -> 50 bps
```

After that, the controller can reach Reserve Fund handling. The RF covers 240,000 sat, leaving exactly 60,000 sat uncovered.

But because only 0.60 hBTC supply remains, that 60,000-sat loss causes exactly a 10 bps share-price move, which still exceeds production `max-deviation=7 bps`:

```text
loss reconciliation -> (err u102014) // ERR_MAX_DEVIATION
```

The attempted RF transfer rolls back.

Governance must therefore also timelock-increase:

```text
max-deviation: 7 bps -> 10 bps
```

Only after both recovery changes can the already-realized loss finally be committed.

### Exact final loss allocation

Once accounting can finally reconcile:

```text
Gross realized strategy loss:       300,000 sat
Reserve Fund absorbs:                240,000 sat
Actual holder loss:                   60,000 sat
```

Without the stale exit, the 40% attacker should bear:

```text
40% * 60,000 = 24,000 sat
```

and the 60% victim should bear:

```text
60% * 60,000 = 36,000 sat
```

Instead, because the attacker exited at stale NAV:

```text
Attacker stale payout:             40,000,000 sat
Attacker fair payout:              39,976,000 sat
Attacker avoided loss:                 24,000 sat

Victim fair loss:                      36,000 sat
Victim actual loss:                    60,000 sat
Victim incremental loss:               24,000 sat
```

Exact invariant:

```text
attackerAvoidedLoss == victimIncrementalLoss == 24,000 sat
```

There is no rounding discrepancy in this scenario.

This demonstrates direct, deterministic loss transfer from the matured claimant to another pre-existing holder despite the Reserve Fund.

---

# General economic invariant

Let:

```text
T = pre-loss economic assets
S = pre-loss share supply
C = claimant shares
L = realized but unaccounted holder loss after any effective protection
```

The stale payout is:

```text
C * T / S
```

The economically fair payout is:

```text
C * (T - L) / S
```

Therefore:

```text
attacker excess
= C*T/S - C*(T-L)/S
= C*L/S
= claimant share fraction * realized holder loss
```

The test suite validates this invariant independently at multiple magnitudes.

Examples:

```text
40% claimant × 60,000 sat uncovered loss = 24,000 sat escaped loss
40% claimant × 10,000 sat uncovered loss =  4,000 sat escaped loss
```

This is not a fixture-specific rounding effect.

---

# Minimal 1 bp structural proof

Runner:

```text
tests/security/stale-nav/run-1bp-minimal-loss-poc.mjs
```

This test keeps:

```text
max-reward = 5 bps
max-deviation = 7 bps
```

and realizes a loss of only:

```text
1 bp
```

Thus the loss is below both magnitude guards.

The immediate correction still fails solely because of the normal accounting window:

```text
log-reward(1 bp negative)
-> (err u102011) // ERR_WINDOW_CLOSED
```

During that forced stale interval, the exact PR #137 predicate remains false, a victim deposit succeeds at stale NAV, and the mature claimant exits at stale NAV.

After the accounting window opens and the 1 bp loss is applied:

```text
attacker excess = 4,000 sat
victim loss     = 4,000 sat
```

This proves that `update-window` alone can create the vulnerable state. A magnitude-cap violation is not required for the root cause.

This minimal test is a structural proof. The production-like RF scenario above separately demonstrates the same loss-shift class with a non-zero Reserve Fund.

---

# Existing-holder PoC without Reserve Fund

Runner:

```text
tests/security/stale-nav/run-live-limits-existing-holder-loss-shift-poc.mjs
```

Two holders exist before the loss:

```text
attacker: 40%
victim:   60%
```

The vault is split between:

```text
0.50 sBTC reserve
0.50 sBTC strategy
```

After a fresh log, the strategy realizes a 6 bps loss. With production source defaults:

```text
max-reward=5 bps
max-deviation=7 bps
```

full correction is rejected.

The mature claimant exits from pre-existing reserve without any new depositor.

After full reconciliation:

```text
attacker avoided loss:       24,000 sat
victim incremental loss:     24,000 sat
```

This proves that the exploit does not inherently depend on a post-loss depositor.

---

# Later-depositor PoC

When reserve liquidity is depleted by strategy deployment, the same stale-NAV defect creates a second exploitation path.

Runner:

```text
tests/security/stale-nav/run-stale-nav-poc.mjs
```

Demonstrative scenario:

```text
pre-loss vault:                 1.00 sBTC
attacker mature claim:          0.40 hBTC
external realized loss:         0.10 sBTC
fair attacker post-loss value:  0.36 sBTC
```

A later user deposits 0.40 sBTC while accounting is stale. That deposit becomes reserve liquidity.

The mature claimant immediately consumes it through `fund-claim()` at the stale pre-loss price and redeems 0.40 sBTC.

Once loss accounting is finally allowed:

```text
attacker excess: 0.04 sBTC
victim loss:     0.04 sBTC
```

Exact invariant:

```text
attackerExcess == victimLoss
```

---

# Causal A/B negative control

Runner:

```text
tests/security/stale-nav/run-reconciled-control.mjs
```

The control holds constant:

- same production hBTC contracts;
- same initial vault;
- same mature 0.40 hBTC attacker claim;
- same 0.10 sBTC realized strategy loss;
- same later 0.40 sBTC victim deposit.

The only material difference is ordering: the loss is reconciled **before** the victim deposit and claim funding.

Control result:

```text
attacker fund-claim:              0.36 sBTC
attacker redeem:                  0.36 sBTC
victim post-funding value:        0.39999999 sBTC
integer rounding:                 1 sat
reserve retains:                  0.04 sBTC
```

Therefore the 0.04 sBTC that disappears into the claimant in the attack ordering remains in the system in the correctly reconciled ordering.

This isolates stale funding-time NAV as the cause of the value transfer.

---

# Why this is not the original M-03

The original M-03 was a **request-time snapshot** issue:

```text
user requests redeem while share price is stale
-> asset amount is fixed immediately
-> negative PnL is logged later
-> old fixed claim remains overvalued
```

PR #89 remediated that by storing shares instead of a fixed asset amount and calculating assets only at `fund-claim()`.

This report uses that remediated flow.

No asset amount is locked when the claim is requested.

The claim can be created days before the adverse event. A fresh reward log can then occur. The strategy loss occurs **after the fresh log**. Only later, at `fund-claim()`, is the excessive asset amount calculated.

The new failure is therefore:

```text
funding-time accounting price != current economic NAV
```

because a real external loss occurred after the last log and the contracts cannot immediately reconcile it.

The M-03 remediation explicitly relies on the funding-time share price being current. These PoCs falsify that security assumption.

The appropriate characterization is:

```text
incomplete M-03 remediation / post-log adverse-event stale NAV
```

not the original request-time M-03.

---

# Why PR #119 and PR #137 do not fix this exploit

I explicitly reviewed the closed, unmerged stale-share-price PRs #119 and #137.

They are relevant prior art and should not be hidden from triage.

Their model of staleness is timestamp-only.

PR #137 proposed effectively:

```clarity
is-sp-stale := current_time >= last-log-ts + 86400
```

That protects against an old `last-log-ts`, such as keeper downtime.

This report is different:

```text
T0:     log-reward() succeeds; timestamp is fresh
T0+N:   external strategy loss becomes real
T0+N:   hBTC correction is blocked
T0+N:   last-log-ts is still fresh
```

A test-only shadow contract reproduces the exact PR #137 predicate:

```text
tests/security/stale-nav/pr137-shadow.clar
```

It is evaluated inside the exploit runners.

In the primary execution, only approximately 20 seconds had elapsed since the fresh log when the loss was already realized and accounting was blocked:

```text
seconds since fresh log after loss = 20
PR137 is-sp-stale = false
```

The predicate remains false:

- after the external loss;
- while corrective accounting is rejected;
- before stale deposit where applicable;
- before stale `fund-claim()`.

Yet the exploit succeeds.

Therefore, even if PR #137 were applied exactly, it would not prevent the reported attack.

The reason is fundamental:

```text
"accounting was updated recently"
```

does not imply:

```text
"no adverse external event occurred after that update"
```

The required remediation must be adverse-event/reconciliation aware, not merely based on the age of `last-log-ts`.

---

# Production strategy reachability

The local strategy helper is used only to isolate the moment when external value becomes irreversibly lower. It does not replace or weaken hBTC deposit, claim, funding, reserve, share, or accounting checks.

The corresponding real production loss source is independently established from deployed Zest contracts and chain history.

Current hBTC external registry evidence shows:

```text
Zest v0-3-market:     inactive
Zest v0-4-market:     active
v0-vault-sbtc:        active
v0-vault-usdh:        active
```

The deployed `v0-4-market.liquidate()` is public. It accepts a borrower principal and requires the liquidator to be a direct standard account (`contract-caller == tx-sender`). Thus an unhealthy strategy position can be liquidated permissionlessly without any Hermetica role.

The production hBTC account:

```text
SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D.zest-interface-hbtc-v1
```

has actually operated a Zest borrow position in the v0-4 era.

Historical production state included approximately:

```text
73.81247997 sBTC collateral
non-zero USDh debt
0 sBTC in hBTC reserve
```

The exact current position is closed (`mask = 0`), and this report does not claim an immediately liquidatable target at the current block.

The point is reachability: the required external-loss state is a demonstrated intended production lifecycle state under the currently authorized Zest market generation, not a malicious or invented strategy configuration.

---

# Current live hBTC controls

Read-only production probes on 2026-08-08 observed approximately:

```text
max-reward:          5 bps
max-deviation:       7 bps
update-window:       82,800 seconds (~23h)
deposit:             enabled
request-redeem:      enabled
reward accounting:   enabled
trading:             enabled
vault:               enabled
```

At the same snapshot:

```text
total-assets:        ~51.14698562 sBTC
reserve:             ~51.14698562 sBTC
Reserve Fund:        ~0.12646477 sBTC
```

The RF ratio is approximately 24.7 bps of total assets. The strongest RF test deliberately uses a nearby 24 bps buffer and a 30 bps gross loss, demonstrating that a realistic non-zero RF does not eliminate the stale-loss-shift primitive.

---

# Root cause

There are two coupled accounting design issues.

## 1. User entry/exit trusts asynchronous accounting NAV

`deposit()` and `fund-claim()` use state-derived share pricing even when a real external strategy event after the latest log has changed economic NAV.

There is no adverse-event-aware reconciliation requirement before those operations.

## 2. Negative PnL uses guards that can prevent immediate loss recognition

`controller.log-reward()` validates the gross reward/loss against `max-reward` before Reserve Fund handling.

The state update also enforces `update-window` and share-price `max-deviation`.

These protections are reasonable as guardrails for periodic accounting, but they become dangerous when the underlying loss is already final: while accounting is prohibited from recognizing reality, user-facing share-priced operations remain enabled.

The stale claimant can transact during that inconsistency window and permanently change who bears the loss.

---

# Attack requirements

The attacker needs only:

1. hBTC shares;
2. a mature standard redemption claim;
3. an external strategy loss that occurs after the latest hBTC NAV log;
4. enough reserve liquidity to fund the claim before reconciliation.

The liquidity may already exist in reserve. A later depositor is not required in that case.

The attacker does **not** require:

- owner/admin/trader/rewarder/manager access;
- compromised keys;
- malicious contracts;
- phishing;
- oracle manipulation;
- direct control of the external loss event beyond the normal permissionless liquidation mechanics when a position is unhealthy.

A mature unfunded claim can also be cancelled before funding, which lets a holder pre-position the claim without committing to an exit if no favorable adverse-event window appears.

---

# Recommended remediation

The safest fix is to make realized-loss reconciliation capable of taking precedence over periodic reward throttles and to prevent share-priced user operations while economic NAV is known to be unreconciled.

Recommended properties:

1. **Separate realized-loss accounting from positive reward throttling.**
   - Do not allow `max-reward` / normal update cadence to prevent a verified realized loss from being reflected.
   - If magnitude protection is needed, provide a dedicated adverse-event path that can atomically reconcile the full verified loss.

2. **Pause share-priced operations after an adverse external event until reconciliation.**
   - At minimum, block `fund-claim()` and `deposit()` while a strategy liquidation/loss is known but not reflected.

3. **Do not rely solely on `last-log-ts` age.**
   - PR #137-style timestamp freshness is insufficient because the loss may occur immediately after a fresh log.

4. **Regression invariant.**
   - Once an external loss is realized at time `T`, no holder should be able to exit with more than their post-loss proportional economic value by transacting before accounting catches up.

---

# Evidence files

```text
tests/security/stale-nav/Clarinet.toml
tests/security/stale-nav/strategy-loss-helper.clar
tests/security/stale-nav/pr137-shadow.clar

tests/security/stale-nav/run-stale-nav-poc.mjs
tests/security/stale-nav/run-reconciled-control.mjs
tests/security/stale-nav/run-1bp-minimal-loss-poc.mjs
tests/security/stale-nav/run-live-limits-blocking-poc.mjs
tests/security/stale-nav/run-live-limits-value-transfer-poc.mjs
tests/security/stale-nav/run-live-limits-existing-holder-loss-shift-poc.mjs
tests/security/stale-nav/run-reserve-fund-buffer-loss-shift-poc.mjs

tests/security/standalone/read-live-hbtc-controls.mjs
tests/security/standalone/read-live-hbtc-risk.mjs
tests/security/standalone/read-live-hbtc-externals.mjs
```

Supporting analysis:

```text
tests/security/STALE_NAV_M03_BYPASS_REPORT.md
tests/security/STALE_NAV_DEDUP_AND_CONTROL_EVIDENCE.md
tests/security/STALE_NAV_STRONGEST_EVIDENCE.md
```

---

# Final reproducibility status

The expanded CI executes in one job:

1. demonstrative 0.10 sBTC stale-NAV value-transfer exploit;
2. reconciled-NAV A/B negative control;
3. minimal 1 bp structural exploit;
4. 6 bps production-limit blocking proof;
5. 6 bps exact later-depositor value-transfer + PR #137 bypass;
6. 6 bps existing-holder loss-shift without a new depositor;
7. 24 bps Reserve Fund / 30 bps gross-loss exact loss-shift proof;
8. live hBTC accounting-control probe;
9. live/current Zest position probe;
10. current hBTC external-registry + deployed Zest v0-4 liquidation-source probe.

Final expanded validation run after all assertions:

```text
GitHub Actions run: 31266641858
job:                93125748056
result:             SUCCESS
```

All exploit, control, Reserve Fund, de-dup counterfactual, and live-read-only stages pass in the same run.

## Validation conclusion

- Root cause: **confirmed**
- Direct loss reallocation: **confirmed**
- Exact attacker/victim equality: **confirmed in multiple scenarios**
- No-new-depositor path: **confirmed**
- Non-zero Reserve Fund path: **confirmed**
- Production 5/7 bps guard behavior: **confirmed**
- PR #137 exact guard bypass: **confirmed executablely**
- M-03 distinction: **confirmed by use of remediated funding-time calculation**
- A/B causal control: **confirmed**
- Current Zest v0-4 integration reachability: **confirmed read-only**
- Current exact open liquidatable position: **not claimed; current position observed closed**
- Remaining uncertainty: **triage policy / known-issue classification, not technical reproducibility**
