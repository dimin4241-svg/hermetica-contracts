# hBTC stale-NAV — strongest exploit evidence summary

This file is a compact triage companion to:

- `STALE_NAV_M03_BYPASS_REPORT.md`
- `STALE_NAV_DEDUP_AND_CONTROL_EVIDENCE.md`

It collects the strongest evidence added after adversarial review.

## 1. General economic invariant

Let, immediately before an external loss:

- `T` = hBTC economic assets;
- `S` = hBTC share supply;
- `C` = shares held in the attacker's mature unfunded claim;
- `L` = external loss that has already become real but is not yet reflected in hBTC accounting.

Pre-loss accounting price is:

```text
P_stale = T / S
```

The economically correct post-loss price is:

```text
P_fair = (T - L) / S
```

If `fund-claim()` executes before reconciliation, the stale payout is:

```text
stalePayout = C * T / S
```

The fair payout is:

```text
fairPayout = C * (T - L) / S
```

Therefore the value escaped by the mature claimant is:

```text
attackerExcess
  = stalePayout - fairPayout
  = C * L / S
  = claimFraction * realizedLoss
```

That amount is not destroyed. It is left for the remaining holders to absorb when the already-realized loss is finally recorded.

The executable tests validate the same invariant at different loss magnitudes:

```text
claim fraction = 40%

6 bps loss on 1.00 sBTC = 60,000 sat
40% * 60,000 = 24,000 sat attacker avoided loss
                   = 24,000 sat incremental loss to other holder / later depositor

1 bp loss on 1.00 sBTC = 10,000 sat
40% * 10,000 = 4,000 sat attacker avoided loss
                   = 4,000 sat later-depositor loss
```

This demonstrates a linear economic defect rather than a fixture-specific rounding artifact.

---

## 2. Minimal 1 bp exploit — below every magnitude guard

Runner:

```text
tests/security/stale-nav/run-1bp-minimal-loss-poc.mjs
```

No relevant accounting guard is relaxed.

The runner proves:

```text
max-reward     = 5 bps
max-deviation  = 7 bps
realized loss  = 1 bp
```

So the loss is five times smaller than `max-reward` and seven times smaller than `max-deviation`.

Observed sequence:

```text
fresh NAV log                                  -> ok
PR #137 timestamp guard                        -> false
realize 1 bp external loss                     -> ok
PR #137 timestamp guard after loss             -> false
immediate 1 bp correction                      -> ERR_WINDOW_CLOSED
victim deposit at stale NAV                    -> ok
fund mature attacker claim at stale NAV        -> 0.40 sBTC
attacker redeem                                -> 0.40 sBTC
wait normal accounting window
same 1 bp correction                           -> ok
```

Final values:

```text
attacker stale payout        40,000,000 sat
attacker fair payout         39,996,000 sat
attacker excess                   4,000 sat
victim final value           39,996,000 sat
victim loss                       4,000 sat
```

Final assertion:

```text
PASS 1BP MINIMAL LOSS: with max-reward=5bps and max-deviation=7bps unchanged, a realized loss of only 1bp is forced stale by update-window, letting a 40% matured claimant avoid exactly 4,000 sats of loss and shifting exactly 4,000 sats to the later depositor. PR #137 timestamp guard remains false.
```

This removes the objection that exploitation requires a loss large enough to exceed `max-reward`.

---

## 3. Existing-holder loss shift — no later deposit is required

Runner:

```text
tests/security/stale-nav/run-live-limits-existing-holder-loss-shift-poc.mjs
```

This is a separate exploit configuration with ordinary mixed liquidity:

```text
pre-loss vault               1.00 sBTC
attacker shares              0.40 hBTC
victim shares                0.60 hBTC
reserve liquidity            0.50 sBTC
external strategy            0.50 sBTC
realized external loss       6 bps = 60,000 sat
```

Both attacker and victim are holders **before** the loss. No post-loss user action or new depositor is required.

After a fresh NAV log:

```text
realize 6 bps loss                         -> ok
PR #137 timestamp guard                    -> false
full correction                            -> ERR_ABOVE_MAX
mature attacker claim funded from reserve  -> 0.40 sBTC
attacker redeems                           -> 0.40 sBTC
```

The loss is then fully reconciled under the unchanged 5 bps cap.

Final invariant:

```text
attacker fair payout       39,976,000 sat
attacker stale payout      40,000,000 sat
attacker avoided loss          24,000 sat

victim fair loss               36,000 sat
victim actual loss             60,000 sat
victim incremental loss        24,000 sat
```

Thus:

```text
attackerAvoidedLoss == victimIncrementalLoss == 24,000 sat
```

Final assertion:

```text
PASS EXISTING-HOLDER LOSS SHIFT: no post-loss depositor is required. With max-reward=5bps and max-deviation=7bps unchanged, a matured claimant exits from pre-existing reserve at stale NAV after a 6bps realized strategy loss, avoids exactly 24,000 sats of loss, and an already-existing holder absorbs exactly 24,000 sats of incremental loss after reconciliation. PR #137 timestamp-only staleness remains false during the exploit window.
```

This removes the objection that the attack depends on an unrelated third party depositing during the stale interval.

Two liquidity cases are now independently proven:

1. **Reserve already has sufficient liquidity** → attacker shifts loss directly onto existing holders.
2. **Reserve was depleted by strategy deployment** → a later normal deposit supplies the liquidity and the attacker captures part of that depositor's principal.

---

## 4. Exact PR #137 bypass is part of the exploit execution

The validation manifest includes:

```text
tests/security/stale-nav/pr137-shadow.clar
```

which models the proposed PR #137 predicate exactly:

```clarity
(>= current-time (+ last-log-ts u86400))
```

The predicate is evaluated inside the exploit tests rather than argued only in prose.

It remains `false`:

- after the fresh `log-reward`;
- after the external loss has already become real;
- while the corrective hBTC accounting call is rejected;
- before stale `deposit()` where applicable;
- before stale `fund-claim()`.

The 10% demonstrative PoC observed only 20 seconds between the fresh log and the already-realized loss state:

```text
seconds since fresh log after realized loss = 20
PR137 is-sp-stale = false
```

This proves that PR #137's timestamp model and this report's adverse-event model are not equivalent.

---

## 5. Causal A/B control

Runner:

```text
tests/security/stale-nav/run-reconciled-control.mjs
```

The control holds constant:

- same production hBTC code;
- same 1.00 sBTC initial vault;
- same 0.40 hBTC mature attacker claim;
- same 0.10 sBTC external loss;
- same later 0.40 sBTC victim deposit.

The only material change is ordering: reconcile the already-realized loss before the deposit and claim funding.

Result:

```text
attacker payout                    0.36 sBTC
victim minted shares               0.44444444 hBTC
victim value after claim funding   0.39999999 sBTC
victim rounding loss               1 sat
reserve retains                    0.04 sBTC
```

The 0.04 sBTC that the exploit transfers to the claimant therefore remains in the system in the correctly ordered control.

This demonstrates causation, not mere correlation.

---

## 6. Production reachability is independent of the test strategy helper

The helper only models the moment an external asset loss becomes real. The production source of that state is independently established read-only:

- current hBTC registry authorizes Zest `v0-4-market`;
- deployed `v0-4-market.liquidate()` allows a direct standard account to liquidate an unhealthy borrower;
- liquidation changes the borrower's external collateral/debt state without synchronously updating hBTC `state.total-assets`;
- hBTC's production `zest-interface-hbtc-v1` has actually borrowed in the v0-4 era;
- the historical production position held roughly `73.81247997 sBTC` collateral with non-zero USDh debt;
- the current position is closed, which is disclosed as a current-block feasibility limitation rather than hidden.

The finding therefore does not depend on a malicious replacement strategy contract or privileged attacker.

---

## 7. Current live accounting parameters

Read-only mainnet probe in the final validation run reports:

```text
max-reward       5 bps
max-deviation    7 bps
update-window    82,800 seconds
protocol         enabled
deposit          enabled
request-redeem   enabled
reward           enabled
trading          enabled
```

The production deployment therefore still has the same class of time/magnitude loss-accounting gates exercised by the regression tests.

---

## 8. Final adversarial triage position

The strongest remaining rejection argument is **policy**, not technical reproducibility:

- M-03 already discussed stale daily share price in the context of request-time claim locking.
- Closed, unmerged PR #119/#137 discussed timestamp-age guards for `deposit` and `fund-claim`.

However, the validation package now provides executable evidence that:

1. the attack uses the remediated funding-time pricing path, not the old request-time amount lock;
2. the exact PR #137 predicate is false throughout the exploit;
3. the attack works for a 1 bp loss below all magnitude guards;
4. it works with unchanged 5/7 bps limits at larger loss values too;
5. it can shift loss to an already-existing holder without any later depositor;
6. a controlled run with NAV reconciled first removes the transfer;
7. the amount shifted follows the exact general invariant `claimFraction * realizedLoss`.

The technically appropriate characterization is therefore:

```text
post-log adverse-event stale NAV / incomplete M-03 remediation
```

rather than:

```text
old last-log timestamp / keeper downtime / original request-time M-03
```

## 9. Final CI evidence

The expanded workflow executes all of the following in one job:

1. 0.10 sBTC demonstrative value-transfer exploit;
2. reconciled-NAV A/B negative control;
3. minimal 1 bp exploit with unchanged 5/7 bps limits;
4. 6 bps reconciliation-blocking test;
5. 6 bps exact later-depositor value-transfer test;
6. 6 bps existing-holder loss-shift test;
7. live hBTC accounting controls;
8. live hBTC/Zest position state;
9. live hBTC external registry + deployed Zest v0-4 liquidation source.

All stages pass in the final expanded validation run.