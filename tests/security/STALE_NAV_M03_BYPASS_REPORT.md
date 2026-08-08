# [Critical] Realized strategy losses remain unaccounted during NAV lockout, allowing matured claimants to capture later depositor funds

## Summary

The current hBTC redemption flow remains exploitable after the remediation for Clarity Alliance M-03 ("Premature Share Price Snapshot Leads to Unbacked Pending Claims").

M-03 was remediated by moving the redemption price snapshot from `request-redeem()` to `fund-claim()`. That fixes the original request-time snapshot problem, but it relies on a stronger assumption: the share price read at funding time must represent the vault's current economic NAV.

That assumption is false after an external strategy loss has already become real but before hBTC accounting is allowed to record it.

Negative PnL is submitted through the same `reward` branch of `state-hbtc-v1.update-state()` used for periodic reward accounting. Before the loss can reduce `total-assets`, production `state` applies:

```clarity
(try! (check-max-reward (get reward data)))
(try! (check-update-window))
...
(unwrap-panic (update-total-assets (get reward data) (get is-add data)))
```

At the same time:

- `vault.deposit()` does not require fresh NAV;
- `vault.fund-claim()` does not require fresh NAV;
- a standard redemption claim can be prepared days in advance, mature, remain unfunded, and still be cancelled before funding;
- a later user's normal deposit supplies fresh sBTC to `reserve`, making the old matured claim fundable even when strategy capital was previously fully deployed.

A local executable PoC using unchanged production hBTC contracts proves an exact **0.04 sBTC value transfer from a later depositor to a matured claimant** after a realized 0.10 sBTC strategy loss.

A second PoC using unchanged production accounting limits proves that even a **6 bps** realized loss cannot be fully reconciled in one accounting window while stale-price deposits and claim funding remain enabled.

## Recommended impact and severity

**Critical — Direct theft of user funds.**

The claimant exits with more sBTC than the claim is economically entitled to after the already-realized loss. The excess is funded with principal supplied by a later depositor. When NAV is eventually corrected, the later depositor and remaining hBTC holders absorb the exact value escaped by the claimant.

Primary PoC economics:

```text
Pre-loss vault NAV                  1.00 sBTC
Attacker matured claim              0.40 hBTC
Realized external loss              0.10 sBTC
Fair attacker value after loss      0.36 sBTC
Later victim deposit                0.40 sBTC
Stale fund-claim payout             0.40 sBTC
Attacker excess exit                0.04 sBTC
Victim value after reconciliation   0.36 sBTC
Victim loss                         0.04 sBTC
```

Exact invariant proven by the runner:

```text
attackerExcess == victimLoss == 0.04 sBTC
```

The PoC does not rely on yield theft, phishing, victim interaction with an attacker contract, leaked credentials, or a privileged attacker role.

## Root cause

### 1. `fund-claim()` trusts accounting share price rather than reconciled economic NAV

In `mainnet/contracts/hbtc/protocol/vault-v1-2.clar`, `fund-claim()` reads the accounting share price:

```clarity
(share-price (contract-call? .state get-share-price))
```

and `process-claim()` calculates:

```clarity
(assets (/ (* shares share-price) share-base))
```

The resulting amount is transferred from `reserve`, and the escrowed hBTC shares are burned.

There is no check that:

- external strategy state has been reconciled;
- `last-log-ts` is fresh enough for funding;
- an adverse external event occurred after the last log;
- the current share price includes a realized strategy loss.

### 2. Negative PnL cannot necessarily be reflected immediately

`mainnet/contracts/hbtc/protocol/controller-v1.clar` routes uncovered losses to `state.update-state()` as:

```clarity
(some { reward: reward, is-add: false })
```

`state.update-state()` applies the same reward magnitude/time guards before reducing `total-assets`:

```clarity
(try! (check-max-reward (get reward data)))
(try! (check-update-window))
```

Therefore a strategy loss can already be final in an external protocol while hBTC continues exposing the pre-loss `total-assets` and share price.

### 3. Deposits remain open during the stale accounting state

`vault.deposit()` accepts new sBTC and mints hBTC using `state.get-deposit-state()` without requiring a post-loss reconciliation.

This is what turns stale accounting into direct value transfer when most vault capital is deployed externally: a later victim's fresh sBTC becomes liquid `reserve` balance, and an old matured claim can immediately consume it at the stale pre-loss price.

### 4. Mature claims can be pre-positioned at low attacker risk

The attacker does not need to predict the loss three days in advance with precision.

A standard claim can be requested ahead of time, allowed to mature, and left unfunded. Before funding it remains cancellable. The attacker therefore has an asymmetric option:

- no adverse event: cancel or keep waiting;
- realized loss while accounting is stale: wait for reserve liquidity and fund the mature claim at the stale price.

## Executable PoC #1 — exact later-depositor value transfer

Files:

```text
tests/security/stale-nav/Clarinet.toml
tests/security/stale-nav/settings/Devnet.toml
tests/security/stale-nav/strategy-loss-helper.clar
tests/security/stale-nav/run-stale-nav-poc.mjs
```

The Clarinet manifest references unchanged production hBTC source files under `mainnet/contracts/hbtc/` and the real sBTC contract as a requirement.

`strategy-loss-helper.clar` is test-only. It only isolates the external-strategy invariant by representing:

1. hBTC capital already moved from `reserve` to an external strategy; and
2. a realized loss that removes strategy value.

It does not replace or weaken any production hBTC accounting, deposit, claim, funding, reserve, share-burning, or redemption check.

The corresponding real external-loss source is independently established below from deployed Zest contracts and production history.

### Runtime sequence

The test constructs a 1.00 sBTC vault:

```text
attacker deposit        0.40 sBTC -> 0.40 hBTC
other holder deposit    0.60 sBTC -> 0.60 hBTC
```

The attacker requests a normal 0.40 hBTC redemption and waits until the claim is mature.

The 1.00 sBTC reserve is then deployed to the strategy helper. A fresh zero-PnL NAV log is committed. Immediately afterwards, the external strategy realizes a 0.10 sBTC loss.

The first attempt to account for that already-realized loss fails:

```text
immediate negative NAV update: (err u102011)
```

A normal later user then deposits 0.40 sBTC:

```text
victim deposits 0.40 after loss: (ok u40000000)
reserve sBTC:                    0.40
victim hBTC:                     0.40
share price:                     still 1.00
```

The attacker funds the old mature claim:

```text
permissionless fund matured claim: (ok u40000000)
reserve sBTC after funding:          0
attacker redeem:                     (ok u40000000)
```

After the accounting window opens, the negative PnL is finally applied:

```text
total-assets: 1.00 -> 0.90 sBTC
remaining supply: 1.00 hBTC
share price: 1.00 -> 0.90
```

The final economic calculation is:

```text
attacker stale payout raw:       40000000
attacker fair post-loss raw:     36000000
attacker excess exit raw:         4000000
victim deposit raw:              40000000
victim post-correction value:    36000000
victim loss raw:                  4000000
```

Final runner assertion:

```text
PASS: a realized external loss + time-gated NAV update lets a matured claimant capture 0.04 sBTC of a later depositor value at stale NAV.
```

## Executable PoC #2 — unchanged production 5 bps loss ceiling

File:

```text
tests/security/stale-nav/run-live-limits-blocking-poc.mjs
```

This test does **not** relax the production source defaults for `max-reward` or `max-deviation`.

It first confirms from unchanged source:

```text
max-reward      5 bps
max-deviation   7 bps
update-window   86,340 seconds (source default)
```

It then realizes a loss of only **6 bps**.

The full loss cannot be accounted even immediately:

```text
6 bps negative update -> (err u102009)  // ERR_ABOVE_MAX
```

Despite the realized loss:

```text
victim deposit       -> succeeds at stale price
fund old mature claim -> succeeds at stale price
attacker redeem       -> succeeds
```

After the daily accounting window opens, the full 6 bps update remains impossible:

```text
post-window 6 bps negative update -> (err u102009)
```

Only 5 bps can be recognized:

```text
5 bps update -> (ok true)
```

That successful partial update resets `last-log-ts`, so the remaining 1 bp is immediately blocked by a new time window:

```text
remaining 1 bp -> (err u102011)  // ERR_WINDOW_CLOSED
```

Final assertion:

```text
PASS LIVE-LIMITS: a realized 6bps loss cannot be fully reconciled in one daily window under the unchanged 5bps cap, while stale-price deposits and matured claim funding remain enabled.
```

Thus the issue is stronger than normal keeper latency. For losses above the configured ceiling, the contracts themselves prevent full immediate reconciliation.

## Current production controls — read-only mainnet evidence

A read-only snapshot on 2026-08-08 confirmed the live hBTC configuration:

```text
protocol enabled          true
vault enabled             true
trading enabled           true
deposit enabled           true
request redeem enabled    true
reward accounting enabled true
HQ timelock                86,400 seconds
max-reward                 5 bps
max-deviation              7 bps
live update-window         82,800 seconds (~23 hours)
staleness-window           50 seconds
```

The stored `staleness-window` is not used to require fresh NAV in `deposit()` or `fund-claim()`.

At the same snapshot:

```text
hBTC total-assets          51.14698562 sBTC
reserve sBTC               51.14698562 sBTC
current Zest position mask 0
```

The current Zest position was therefore closed at the snapshot. This report does **not** claim that a liquidation can be executed against an open Hermetica position at that exact current block.

However, current registry and deployed-code evidence shows that the strategy-loss state remains reachable through the protocol's current intended configuration.

## Current Zest v0-4 reachability

### Hermetica migrated from v0-3 to v0-4 and v0-4 is active today

Read-only reconstruction of `state-hbtc-v1` external-registry transactions proves:

```text
2026-02-25  request-external-add(v0-4-market)
2026-02-25  request-external-remove(v0-3-market)
2026-02-26  confirm-external-request(v0-4-market)
2026-02-26  confirm-external-request(v0-3-market)  // confirms removal
```

Current `state-hbtc-v1.get-external()` values:

```text
Zest v0-3-market         false
Zest v0-4-market         true
Zest v0-vault-sbtc       true
Zest v0-vault-usdh       true
Hermetica staking-v1-1   true
Hermetica staking-silo   true
Hermetica minting-auto   true
```

So the finding does not depend on governance re-adding the retired v0-3 market. The currently authorized lending market is **Zest v0-4**.

### Deployed Zest v0-4 liquidation is permissionless for a direct liquidator

The read-only probe fetched the deployed source of:

```text
SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market
```

Its public `liquidate()` accepts an arbitrary borrower principal and sets:

```clarity
(liquidator contract-caller)
(position (try! (get-liquidation-position borrower)))
```

After checking health and liquidation parameters, the authorization condition is:

```clarity
(asserts! (is-eq contract-caller tx-sender) ERR-AUTHORIZATION)
```

This does not require a Hermetica governance/admin role. It permits a direct standard account to liquidate an unhealthy borrower.

The function then repays debt and removes borrower collateral to the liquidator or requested collateral receiver. No call is made to hBTC `state` or `controller` to synchronously reduce hBTC `total-assets`.

Therefore a Zest liquidation can make an hBTC strategy loss real before Hermetica's periodic NAV accounting is able to recognize it.

## Production history proves the Zest strategy state is not hypothetical

The hBTC Zest interface account is:

```text
SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D.zest-interface-hbtc-v1
```

The shared Zest market-vault records position id `11` for this account and reports:

```text
last-borrow-block = 8,179,328
```

That borrow occurred well **after** Hermetica activated `v0-4-market` in February 2026.

Historical read-only snapshots around that production position showed approximately:

```text
sBTC collateral       73.81247997 sBTC
USDh debt             non-zero
hBTC total-assets     73.81828601 sBTC
reserve sBTC          0
```

This is exactly the economically relevant configuration for the exploit:

- most capital deployed externally;
- little/no immediate reserve liquidity;
- a real lending position subject to permissionless liquidation;
- a later normal deposit capable of supplying fresh reserve sBTC before stale NAV is corrected.

Thus the vulnerable state has existed in production under the same hBTC/Zest interface and the currently authorized v0-4 market generation.

## Attack path

1. Attacker acquires hBTC shares.
2. Attacker calls `request-redeem(shares, false)`.
3. The normal cooldown expires; the claim is mature but left unfunded.
4. hBTC has an active external Zest strategy position.
5. A fresh periodic NAV/reward log occurs.
6. The Zest position later becomes unhealthy and is liquidated through permissionless `v0-4-market.liquidate()`.
7. The economic loss is now real in the external strategy.
8. hBTC `total-assets` and share price still reflect the pre-liquidation state.
9. Full immediate loss reconciliation is blocked by `max-reward` and/or `update-window`.
10. A normal victim deposits sBTC into hBTC.
11. Victim receives hBTC at stale NAV, and the deposited sBTC becomes liquid in `reserve`.
12. Attacker calls `fund-claim()` on the already-mature claim.
13. `fund-claim()` snapshots the same stale pre-loss share price and transfers the victim's fresh sBTC from `reserve` into claim escrow.
14. Attacker calls `redeem()` and exits above fair post-loss value.
15. When negative PnL is eventually reconciled, the hBTC share price falls and the later depositor/remaining holders absorb the difference.

## Relationship to Clarity Alliance M-03

This should be submitted as an **incomplete remediation / bypass of M-03**, not as the original M-03.

The original M-03 issue was a premature request-time snapshot. Remediation PR #89 moved the asset calculation to `fund-claim()` and states that the redesign prevents stale-price attacks, reflects negative PnL at funding, and prevents users from escaping negative PnL by timing withdrawals.

This exploit uses the remediated flow:

- no asset amount is locked at `request-redeem()`;
- the claim may be created days before the loss;
- the loss happens after a fresh NAV log;
- the **funding-time** share price itself remains stale because loss accounting is contractually rate/time limited;
- a later deposit supplies principal that did not exist in reserve when the claim matured;
- the old claim is then funded from that new principal at the stale price.

Distinct exploit path:

```text
realized external loss
    -> loss update blocked by max-reward/update-window
    -> later deposit supplies fresh reserve principal at stale NAV
    -> matured old claim funded at stale funding-time NAV
    -> claimant exits above fair post-loss value
    -> later depositor absorbs the exact excess after reconciliation
```

This executable path falsifies the remediation assumption that moving the snapshot to funding guarantees an economically current price.

## Strongest triager objections

### "This is the already-known M-03"

M-03 was marked resolved by changing the snapshot from request time to funding time. This PoC uses that remediated implementation and does not exploit a request-time asset snapshot.

The bypass exists because **funding-time NAV can itself be stale after a realized loss**, and a later deposit makes the stale claim liquid/fundable.

### "Daily NAV staleness is intended"

Even if periodic valuation is intentional, a realized loss is qualitatively different from unrealized strategy mark-to-market drift. Once an external liquidation has already removed value, allowing deposits and old-claim funding at the pre-loss NAV reallocates that realized loss based on transaction ordering.

Additionally, the 6 bps PoC proves the issue is not merely a 23-hour keeper cadence: the live 5 bps cap can prevent full reconciliation even when the time window is open.

### "The reserve may be empty when strategy capital is deployed"

The exploit explicitly handles that condition. Production history showed `reserve sBTC = 0` with the Zest position open. The later victim deposit supplies fresh reserve liquidity, which `fund-claim()` then consumes at stale NAV.

### "The attacker cannot create the external loss"

A direct EOA can call deployed active `v0-4-market.liquidate()` against an unhealthy borrower. The attacker does not require a Hermetica role. Market movement can make the position unhealthy; the security failure is the allocation of an already-realized loss before accounting can catch up.

### "The Zest position is closed right now"

Correct: it was closed at the read-only snapshot. The report does not claim an immediately liquidatable current position.

However:

- `trading-enabled` is currently true;
- `v0-4-market` is currently active in the hBTC external registry;
- Zest sBTC/USDh vaults are active;
- the same hBTC Zest interface held a material borrowed position in production after the v0-4 migration.

The vulnerable strategy state is therefore part of the current authorized protocol lifecycle, not a retired-contract-only scenario.

## Recommended remediation

### 1. Separate realized loss accounting from positive reward throttling

A verified realized negative PnL should be capable of reducing NAV immediately. Applying positive-reward throttles (`max-reward` and periodic update windows) unchanged to realized losses creates a stale solvency/accounting state.

If magnitude limits are required, add a dedicated loss-reconciliation path that can atomically account for the full verified external loss.

### 2. Gate `deposit()` and `fund-claim()` when NAV may be stale after an adverse strategy event

Do not mint new shares or finalize existing claims against a share price known to precede a realized strategy loss.

The existing `last-log-ts` / `staleness-window` can be part of a general freshness policy, but timestamp freshness alone is insufficient when a liquidation occurs immediately after a log. Strategy-specific adverse-event reconciliation is required.

### 3. Pause value-sensitive user flows on liquidation detection

Once a strategy liquidation is observed/processed, deposits and claim funding should not coexist with an unchanged pre-loss share price.

### 4. Regression invariant

After an external loss becomes realized at time `T`, no pre-existing holder should be able to redeem more than their post-loss proportional ownership by consuming principal deposited by another user after `T`.

## Validation evidence

### Latest consolidated green run

```text
GitHub Actions run: 31264272389
job:               93119778571
result:            success
```

The same run successfully executed:

1. exact 0.04 sBTC stale-NAV value-transfer PoC;
2. unchanged-production-limit 6 bps PoC;
3. live hBTC accounting/control snapshot;
4. live hBTC/Zest position snapshot;
5. current hBTC external-registry reconstruction;
6. deployed active Zest v0-4 liquidation source inspection.

### Earlier focused runs

```text
Primary economic PoC:
run 31263673419 / job 93118253154 — PASS

Production 5 bps ceiling PoC:
run 31263953785 / job 93118969108 — PASS

Historical hBTC/Zest position reconstruction:
run 31263058920 / job 93116730414 — PASS
```

## Validation status

- Root cause: **confirmed**
- Local economic exploit: **confirmed**
- Exact attacker/victim value transfer: **confirmed**
- Production hBTC contracts used unchanged: **yes**
- Victim malicious-contract/phishing prerequisite: **none**
- Privileged attacker prerequisite: **none**
- Current active Zest market generation: **v0-4, confirmed active**
- Deployed v0-4 permissionless liquidation: **confirmed read-only**
- Historical material production Zest position after v0-4 migration: **confirmed read-only**
- Current open Zest position: **no; closed at snapshot**
- Current live hBTC loss controls: **confirmed (`max-reward=5 bps`, `max-deviation=7 bps`, `update-window=82,800s`)**
- Prior-audit relationship: **M-03 incomplete-remediation/bypass; disclose explicitly**

## Submission verdict

**Recommended submission: YES.**

Technical confidence is high because the value transfer is executable and exact, current accounting limits independently reproduce the stale-state problem, and the external-loss source is supported by current active Zest v0-4 deployed code plus production position history.

The main acceptance risk is the relationship to M-03. The report should proactively frame the issue as an incomplete remediation and emphasize that the exploit occurs at funding time under the remediated code, not at request time as in the original finding.
