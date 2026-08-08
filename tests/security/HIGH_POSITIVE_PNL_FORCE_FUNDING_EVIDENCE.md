# [High] Permissionless funding of mature claims at post-log stale NAV transfers already-realized yield to remaining hBTC holders

## Impact classification

**Immunefi impact:** Theft of unclaimed yield (High).

This is not a mark-to-market discrepancy. A non-manager remaining holder can cause another user's mature standard redemption claim to be funded at a stale pre-profit share price during the mandatory reward update window. The victim receives less underlying sBTC than the same claim receives in an otherwise-identical reconciled execution, and the remaining holder later receives exactly that missing amount as additional sBTC.

## Root cause

The M-03 remediation intentionally delays claim asset calculation until **funding time**, so the claimant remains economically exposed to vault PnL until funding. However, `fund-claim` does not prove that the current share price reflects all already-realized external strategy PnL.

A fresh `log-reward()` resets `last-log-ts`. If new external PnL is realized immediately afterwards, the accounting layer can reject a second reward update because `update-window` has not elapsed, while the vault continues to allow a mature standard claim to be permissionlessly funded using the old share price.

This creates the following state:

1. victim still owns claim shares economically until funding;
2. external profit has already been realized;
3. accounting is forced to remain stale by `update-window`;
4. timestamp-only staleness logic still reports the price as fresh;
5. any non-manager may call single-claim `fund-claim` after cooldown;
6. victim is paid before its already-earned PnL is incorporated;
7. the same PnL is later recognized and accrues entirely to remaining shares.

## Executable A/B proof

PoC:

`tests/security/stale-nav/run-positive-pnl-force-funding-ab-poc.mjs`

Replay:

```bash
npm ci
node tests/security/stale-nav/run-positive-pnl-force-funding-ab-poc.mjs
```

The test runs ATTACK and CONTROL from equivalent initial states and uses actual wallet-level sBTC payouts.

### Fixture

- attacker / remaining holder: 60,000,000 shares (60%)
- victim / mature claimant: 40,000,000 shares (40%)
- initial NAV: 100,000,000 sat
- external strategy allocation: 50,000,000 sat
- post-log realized profit: 12,000 sat = 1.2 bps of initial NAV
- production `max-reward`: 5 bps
- production `max-deviation`: 7 bps
- production `reserve-rate`: 500 = 5%
- performance fee: 0
- management fee: 0
- standard exit fee: 0

The 1.2 bps profit is below both production accounting caps. Its immediate recognition fails **only** because the daily update window is still active.

### Exact token-level result

| | ATTACK: stale funding | CONTROL: reconcile before funding | Delta |
|---|---:|---:|---:|
| Victim actual sBTC payout | 40,000,000 | 40,004,560 | **-4,560** |
| Attacker actual sBTC payout | 60,011,400 | 60,006,840 | **+4,560** |
| Aggregate user payout | 100,011,400 | 100,011,400 | **0** |

Additional accounting checks:

- gross realized profit: `12,000 sat`
- Reserve Fund allocation: `600 sat`
- net holder yield: `11,400 sat`
- victim's pro-rata net yield: `4,560 sat`
- attack victim yield shortfall: `4,560 sat`
- attack attacker excess yield: `4,560 sat`

Therefore:

```text
victim yield stolen == attacker excess yield == 4,560 sat
attack aggregate payouts == control aggregate payouts
```

This rules out rounding, fee extraction, accounting-only valuation, or protocol-created value.

## Permissionless attacker path

The attack does not require a manager, strategist, rewarder, trader, keeper, governance key, or oracle manipulation.

The production `vault-hbtc-v1-2` exposes single-claim `fund-claim`. `process-claim` permits a non-manager caller once the standard cooldown has elapsed. The PoC explicitly records:

```text
manager: (some false)
attacker force-funds victim at stale NAV: (ok u40000000)
```

The attacker only needs to remain an hBTC holder and call the public funding path for the victim's already-mature claim.

## Why the victim is entitled to the PnL until funding

Merged remediation PR #89 (`refactor: restructure withdrawal/redeem process (M-03 New)`) explicitly changed the design so:

- claims store shares rather than fixed assets;
- assets are calculated from the **current share price at funding time**;
- shares remain in the vault until funding;
- users participate in vault performance until funding;
- users have price exposure between request and funding.

PR: https://github.com/hermetica-fi/hermetica-contracts/pull/89

This makes the CONTROL execution the intended behavior: if already-realized positive PnL is reflected before funding, the victim's 40% claim receives its 40% share of net holder yield. The ATTACK execution removes exactly that entitlement solely because a third party funds while accounting is temporarily stale.

## Production positive-PnL reachability is proven on-chain

A read-only Hiro history scan of the production controller:

`SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D.controller-hbtc-v1`

found, in one internally-consistent 180-call history snapshot:

- successful `log-reward` calls scanned: 180
- non-zero positive calls: **177**
- zero positive calls: **2**
- negative calls: **1**
- failed calls: **0**
- aggregate non-zero positive rewards in this snapshot: **63,882,770 sat (0.63882770 BTC)**
- largest positive reward: **1,156,987 sat (0.01156987 BTC)**

Evidence artifact is generated by:

`tests/security/standalone/read-live-hbtc-positive-reward-history.mjs`

and uploaded in CI as `live-hbtc-positive-reward-history`.

### Concrete production transactions

Largest observed positive logs:

1. `0x26dd0ab448936959d3778706dcf42669f1274fd2521c9a12851b6528bac4a79e`
   - 2026-04-23 22:00:08 UTC
   - block 7,719,434
   - `log-reward(u1156987, true)`
   - result `(ok true)`

2. `0xff9b10655d20fa614d46836cbb8f5316ffb84ae25e7a3903edcd78191159bd22`
   - 2026-05-27 22:00:18 UTC
   - block 8,107,876
   - `log-reward(u1082586, true)`
   - result `(ok true)`

3. `0xdf6768be6308d1af78a26fbc65a79e057e25e90ee5971840a93fc4e01dc4f8f0`
   - 2026-05-29 22:00:25 UTC
   - block 8,126,612
   - `log-reward(u1000057, true)`
   - result `(ok true)`

Most recent observed positive log:

- `0x70d492cdcb3e08f8fa62885807e1479721a7e53e589495557c3d4d466f073dfb`
- 2026-08-07 22:00:13 UTC
- block 8,718,474
- `log-reward(u201722, true)`
- result `(ok true)`

Positive reward accounting is therefore a routinely exercised production path, not a hypothetical state invented for the PoC.

## Live production parameters

Read-only mainnet evidence has confirmed:

- `max-reward = 5 bps`
- `max-deviation = 7 bps`
- `update-window = 82,800 seconds` (~23h)
- `reserve-rate = 500` (5%)
- global standard exit fee = 0 bps
- reward/deposit/redeem/request-redeem enabled
- active vault = `vault-hbtc-v1-2`

The PoC's 1.2 bps profit therefore does **not** rely on exceeding reward/deviation safety caps. It is blocked from immediate accounting solely by the ordinary update-window after a fresh reward log.

## Why PR #119 / PR #137 do not remove this path

There is public prior art for generic timestamp-based share-price staleness protection:

- PR #119: https://github.com/hermetica-fi/hermetica-contracts/pull/119
- PR #137: https://github.com/hermetica-fi/hermetica-contracts/pull/137

Both are closed and were not merged into `master`.

More importantly, their model is based on **time since the last `log-reward`**. That does not detect an external economic state change occurring immediately *after* a fresh log.

The PoC checks the exact PR #137-style condition twice:

```text
fresh zero NAV log: (ok true)
PR137 timestamp guard says fresh: false
external strategy realizes +12000 sats profit
PR137 still says fresh after realized profit: false
immediate +1.2bp profit accounting blocked only by update-window: (err u102011)
```

Thus even the proposed timestamp stale guard classifies the old price as fresh during the exploit window.

## M-03 is not the same bug

The original M-03 problem was **request-time price lock-in**. A user could request redemption while NAV was stale and lock a fixed asset amount before later negative PnL was recognized.

PR #89 fixed that exact mechanism by storing shares and deferring valuation to funding.

This finding begins from the opposite assumption: M-03's funding-time design is working as intended, but the **funding-time price itself can be economically stale after a new post-log PnL event**, and a third party can choose the stale funding moment for another user's claim.

The existing negative control demonstrates that old request-time M-03 behavior is fixed when NAV is corrected before funding.

## Public duplicate search

Searches were performed across public repository PRs/issues/commits for combinations of:

- `fund-claim`
- positive PnL / profit / yield
- stale share price / NAV
- mature claim
- third-party / permissionless funding

No exact public report was found describing the complete path:

```text
post-log positive PnL
→ update-window forces accounting stale
→ non-manager remaining holder funds another user's mature claim
→ victim loses already-realized yield
→ remaining holder receives the exact same yield later
```

The closest public prior art is generic stale-share-price protection in PR #119/#137 and M-03's request-time stale price bug. This should be disclosed honestly because the program may apply a broad known-class interpretation, but neither public item demonstrates or fixes this exact post-log positive-PnL force-funding value transfer.

## Triager falsification checklist

To invalidate the High impact, one of the following must be shown:

1. a mature standard claimant is not economically entitled to PnL realized before funding — contradicted by merged PR #89's explicit funding-time exposure design;
2. only a privileged actor can fund the victim — contradicted by the non-manager executable path;
3. the profit is hypothetical — contradicted by 177 non-zero successful production positive logs, including one on 2026-08-07;
4. production limits prevent the state — contradicted by the 1.2 bps fixture being below 5/7 bps caps and failing only on update-window;
5. the victim's missing value is a fee/rounding artifact — contradicted by exact A/B conservation and `4,560 == 4,560` transfer;
6. timestamp staleness protection catches the event — contradicted by the exact PR #137 shadow check remaining false after post-log profit;
7. the same bug is already publicly documented — no exact public positive-PnL force-funding path was found; broad stale-price prior art remains the main eligibility risk.

## Severity conclusion

Technically, this is a direct **theft of unclaimed yield** from one hBTC holder to another through permissionless stale funding of a mature claim. That impact is explicitly classified as **High** in the Hermetica Immunefi program.

The strongest residual uncertainty is eligibility/deduplication under a broad interpretation of the previously known stale-share-price class, not technical exploitability or impact.