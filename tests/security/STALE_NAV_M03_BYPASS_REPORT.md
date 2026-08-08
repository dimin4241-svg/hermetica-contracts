# [Critical] Realized strategy losses remain unaccounted during NAV lockout, allowing matured claimants to capture later depositor funds

## Summary

The current hBTC redemption flow remains exploitable after the remediation for Clarity Alliance M-03 ("Premature Share Price Snapshot Leads to Unbacked Pending Claims").

The M-03 remediation moved the redemption price snapshot from `request-redeem()` to `fund-claim()`. That prevents a user from locking an asset amount at claim creation, but it assumes the share price read at funding time reflects the vault's current economic NAV.

That assumption is false after a strategy loss has already become real but before hBTC accounting is allowed to record the loss.

Negative PnL is submitted through the same `reward` branch of `state-hbtc-v1.update-state()` as positive rewards. Before a negative loss can update `total-assets`, `state` enforces both:

1. `check-max-reward(loss)`, and
2. `check-update-window()`.

Meanwhile, neither `vault-hbtc-v1.deposit()` nor `vault-hbtc-v1.fund-claim()` requires the NAV to be fresh.

As a result, a claimant can keep a matured standard redemption claim unfunded, wait for a real external strategy loss, and then use a later depositor's fresh sBTC liquidity to fund the old claim at the stale pre-loss share price. When the loss is eventually recorded, the new depositor and remaining holders absorb the value that the claimant escaped with.

A local executable PoC using unchanged production hBTC contracts demonstrates an exact transfer of **0.04 sBTC** from a later depositor to a matured claimant after a 0.10 sBTC realized strategy loss.

## Impact

**Recommended severity: Critical — Direct theft of user funds.**

The attacker exits with more sBTC than their shares are economically entitled to after the realized strategy loss. The excess is not created from yield: it is funded with principal supplied by a later depositor and is subsequently reflected as a loss to the remaining hBTC holders when NAV is corrected.

In the PoC:

- pre-loss vault NAV: `1.00 sBTC`
- attacker matured claim: `0.40 hBTC`
- realized external loss: `0.10 sBTC`
- fair value of attacker claim after the loss: `0.36 sBTC`
- later victim deposit: `0.40 sBTC`
- stale `fund-claim()` payout to attacker: `0.40 sBTC`
- attacker excess exit: **`0.04 sBTC`**
- victim's 0.40 hBTC value after loss reconciliation: `0.36 sBTC`
- victim loss: **`0.04 sBTC`**

Exact invariant proven by the runner:

```text
attackerExcess == victimLoss == 0.04 sBTC
```

The attack scales with the fraction of pre-loss shares held in matured claims and with the size of the realized loss, subject to fresh reserve liquidity becoming available before NAV reconciliation.

## Root cause

### 1. `fund-claim()` trusts accounting share price, not economic NAV

`mainnet/contracts/hbtc/protocol/vault-v1-2.clar`

`fund-claim()` reads:

```clarity
(share-price (contract-call? .state get-share-price))
```

and `process-claim()` computes:

```clarity
(assets (/ (* shares share-price) share-base))
```

The resulting amount is transferred from `reserve` and the escrowed hBTC shares are burned.

There is no freshness check against `last-log-ts`, no verification that external positions have been reconciled, and no check that the share price reflects a realized strategy loss.

### 2. Negative PnL is prevented from updating NAV immediately

`mainnet/contracts/hbtc/protocol/controller-v1.clar` routes losses into `state.update-state()` using:

```clarity
(some { reward: reward, is-add: false })
```

`mainnet/contracts/hbtc/protocol/state-v1.clar` then applies, in this order:

```clarity
(try! (check-max-reward (get reward data)))
(try! (check-update-window))
...
(unwrap-panic (update-total-assets (get reward data) (get is-add data)))
```

Therefore a loss may already be real in an external protocol while hBTC continues to expose the old `total-assets` and share price.

### 3. Deposits remain enabled while NAV is stale

`vault.deposit()` accepts sBTC and mints hBTC from `state.get-deposit-state()` without requiring a fresh NAV.

This is important when strategy capital is deployed and `reserve` has little or no sBTC: a new user's deposit supplies the exact liquid sBTC that an old matured claim can consume.

### 4. Matured standard claims are pre-positionable

A standard claim can be requested in advance and held after its cooldown expires. Before funding it remains cancellable. This gives an hBTC holder an asymmetric option:

- if no adverse event occurs, cancel or leave the claim unfunded;
- if a strategy loss occurs while NAV is stale, use the already-mature claim as soon as fresh reserve liquidity arrives.

The attacker does not require a privileged role, phishing, or a malicious token/contract interaction by the victim.

## Production reachability

### Zest liquidation is a real external-loss source

Hermetica's production hBTC architecture uses Zest borrowing against sBTC as a core strategy.

The deployed Zest `v0-3-market` exposes permissionless liquidation for unhealthy borrowers. The borrower principal is supplied to `liquidate()`, and a direct EOA liquidator repays debt in exchange for collateral when the position is liquidatable.

A read-only historical reconstruction proves the production hBTC account actually operated this strategy:

```text
account:
SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D.zest-interface-hbtc-v1

historical position around block 8179328:
  sBTC collateral: 73.81247997 sBTC
  USDh debt:       non-zero
  hBTC totalAssets:73.81828601 sBTC
  reserve sBTC:    0
```

The current live position is closed (`mask = 0`), so this report does **not** claim the liquidation path is immediately executable against the current block. The state is nevertheless a demonstrated production state of the intended core strategy rather than an artificial test configuration.

## Current production accounting controls

Read-only mainnet snapshot on 2026-08-08:

```text
max-reward:              5 bps
max-deviation:           7 bps
update-window:           82,800 seconds (~23 hours)
staleness-window:        50 seconds
Deposits:                enabled
Redeems:                 enabled
Request redeem:          enabled
Reward accounting:       enabled
```

The `staleness-window` value is stored in `state` but is not used by `deposit()` or `fund-claim()` to protect these operations from a stale NAV.

### Losses above 5 bps are even harder to reconcile

A second executable PoC uses the unchanged production default `max-reward = 5 bps` and a realized loss of only **6 bps**.

Results:

1. The full 6 bps negative update is rejected with `ERR_ABOVE_MAX (u102009)`.
2. A victim deposit still succeeds at the stale price.
3. The matured claimant is still funded from that fresh deposit at the stale price.
4. After the daily window opens, the full 6 bps update is **still** rejected by the 5 bps ceiling.
5. Logging the allowed 5 bps succeeds.
6. That successful partial update resets `last-log-ts`.
7. The remaining 1 bp is immediately rejected with `ERR_WINDOW_CLOSED (u102011)`.

Runner assertion:

```text
PASS LIVE-LIMITS: a realized 6bps loss cannot be fully reconciled in one daily window under the unchanged 5bps cap, while stale-price deposits and matured claim funding remain enabled.
```

Thus for losses above the configured ceiling, the issue is stronger than ordinary daily keeper latency: the contracts themselves prevent full immediate reconciliation.

## Attack path

Assume an hBTC strategy position is active, as it has been in production historically.

1. Attacker deposits into hBTC and owns shares.
2. Attacker calls `request-redeem(shares, false)` and waits through the normal cooldown.
3. The claim is mature but remains unfunded.
4. A fresh NAV/reward log occurs.
5. The external strategy suffers a real loss, e.g. a Zest liquidation.
6. hBTC `total-assets` still reflects the pre-loss NAV.
7. Immediate loss reconciliation is blocked by `max-reward` and/or `update-window`.
8. A normal victim deposits fresh sBTC into hBTC.
9. The victim receives hBTC using the same stale NAV.
10. The victim's sBTC is now liquid in `reserve`.
11. Attacker calls `fund-claim()` for the already-mature claim.
12. `fund-claim()` snapshots the stale pre-loss share price and transfers the victim's fresh sBTC from `reserve` to the claim escrow.
13. Attacker calls `redeem()` and receives the stale full amount.
14. When negative PnL is eventually reconciled, the hBTC share price falls and remaining holders, including the later depositor, absorb the loss that should have reduced the attacker's redemption.

## Executable PoC

Files:

```text
tests/security/stale-nav/Clarinet.toml
tests/security/stale-nav/settings/Devnet.toml
tests/security/stale-nav/strategy-loss-helper.clar
tests/security/stale-nav/run-stale-nav-poc.mjs
tests/security/stale-nav/run-live-limits-blocking-poc.mjs
```

The manifest references unchanged production hBTC source files under `mainnet/contracts/hbtc/` and the real sBTC contract as a Clarinet requirement.

`strategy-loss-helper.clar` is test-only and performs only two functions needed to isolate the hBTC invariant:

1. represent capital already deployed from `reserve` into an external strategy;
2. realize an external loss by removing part of that strategy balance.

The permissionless production Zest liquidation semantics and historical production Zest position are independently established through read-only chain data; the helper does not replace or weaken any hBTC authorization/accounting check involved in the exploit.

### Primary economic PoC

Successful GitHub Actions run:

```text
run: 31263673419
job: 93118253154
```

Key runtime results:

```text
external strategy realizes 0.10 sBTC loss:       (ok true)
immediate negative NAV update:                    (err u102011)
victim deposits 0.40 after loss:                  (ok u40000000)
permissionless fund matured claim:                 (ok u40000000)
attacker redeems funded claim:                     (ok u40000000)
delayed negative NAV update:                       (ok true)

attacker stale payout:       0.40 sBTC
attacker fair post-loss:     0.36 sBTC
attacker excess:             0.04 sBTC
victim post-correction loss: 0.04 sBTC
```

Final runner assertion:

```text
PASS: a realized external loss + time-gated NAV update lets a matured claimant capture 0.04 sBTC of a later depositor value at stale NAV.
```

### Production-limit PoC

Successful GitHub Actions run:

```text
run: 31263953785
job: 93118969108
```

This test proves the separate 5-bps reconciliation ceiling using unchanged defaults.

## Relationship to Clarity Alliance M-03

This report should be treated as an **incomplete remediation / bypass of M-03**, not as the original M-03 report.

The original M-03 problem was that claim assets were fixed at `request-redeem()` time. PR #89 moved the asset calculation to `fund-claim()` and states that the change:

- eliminates stale-price attacks;
- makes negative PnL reflected at funding;
- prevents users from escaping negative PnL by timing withdrawals;
- ensures claims are funded at the current vault state.

The new attack does **not** rely on a price snapshot at request time. The attacker can create the claim days before the loss. The exploit occurs because the later funding-time share price itself remains stale after the loss has become real.

The distinguishing path is:

```text
realized external loss
    -> loss update blocked by max-reward/update-window
    -> later user deposit supplies fresh reserve principal at stale NAV
    -> matured old claim funded at the same stale NAV
    -> claimant exits above fair post-loss value
    -> later depositor absorbs the difference after reconciliation
```

This directly falsifies the remediation's security assumption that moving the snapshot to funding makes the funding-time price economically current.

## Strongest triager objections and responses

### "This is the already-known M-03"

M-03 was marked remediated by changing **when** the claim amount is calculated. This PoC uses the remediated flow and does not lock any asset amount at claim creation. It demonstrates that the funding-time price can itself be stale because the loss-accounting path is contractually rate/time limited.

The later-deposit liquidity step is also important: it makes an otherwise illiquid stale claim fundable with principal that entered only after the loss.

### "Daily NAV staleness is intended"

Even if daily valuation is intentional, deposits and claim funding are allowed during the stale interval without a freshness guard. A realized loss is therefore allocated according to transaction ordering rather than share ownership at the time of loss.

More importantly, a loss above `max-reward` cannot be fully reconciled in one update even after the daily window has opened. The 6-bps PoC proves this using the unchanged 5-bps limit.

### "The reserve may be empty after a strategy loss"

That is why the exploit uses a **later normal deposit**. Historical production data shows the reserve could indeed be empty while the Zest strategy was active. The victim's deposit supplies fresh sBTC, and `fund-claim()` immediately consumes that liquidity at stale NAV.

### "The attacker cannot force a Zest liquidation"

The attacker does not need privileged access to Hermetica. Zest liquidation itself is permissionless once the position becomes unhealthy. Adverse market movement is a strategy risk that hBTC explicitly supports with negative-PnL accounting and a reserve fund. The security issue is that once the loss is real, the contracts allow value to be reallocated before it can be recognized.

### "The position is closed right now"

The PoC does not claim an immediately open Zest liquidation target at the current block. The relevant state has existed in production, and Zest borrowing is documented as a core hBTC strategy. This is a feasibility consideration, not a false reachability assumption.

## Recommended remediation

The strongest fix is to separate loss reconciliation from positive reward throttling.

1. **Allow realized negative PnL to be recorded immediately.**
   - Do not apply the positive-reward `update-window` / `max-reward` throttles unchanged to loss accounting.
   - If a magnitude guard is required, provide a dedicated emergency loss path capable of reconciling the full verified loss atomically.

2. **Block deposits and claim funding when NAV is stale after an adverse strategy event.**
   - Require a fresh strategy/NAV reconciliation before `deposit()` and `fund-claim()`.
   - The existing `last-log-ts` / `staleness-window` state can be used as part of the guard, but a simple periodic timestamp alone is insufficient if a realized loss occurs after the last log.

3. **Pause affected user flows on liquidation detection until accounting is reconciled.**
   - A realized external liquidation should not coexist with an unchanged hBTC share price while deposits and old-claim funding remain open.

4. **Add a regression invariant.**

After a realized external loss at time `T`, no holder should be able to redeem more value than their post-loss proportional ownership by consuming principal deposited by another user after `T`.

## Validation status

- Root cause: **confirmed**
- Local economic exploit: **confirmed**
- Direct victim/attacker value delta: **confirmed**
- Production contracts used unchanged: **yes**
- External Zest liquidation reachability: **confirmed read-only against deployed source**
- Historical active production Zest position: **confirmed read-only**
- Current active Zest position: **no; currently closed**
- Current live hBTC loss controls: **confirmed read-only (`max-reward=5`, `max-deviation=7`, `update-window=82,800s`)**
- Prior-audit relationship: **M-03 incomplete-remediation/bypass risk; should be disclosed explicitly in submission**
