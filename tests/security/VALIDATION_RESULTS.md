# Hermetica security validation results

Validation branch: `validation-susdh-donation-poc`

Latest focused ordering run: `31261693979` (job `93113404828`) — **PASS**.
Earlier full exploit run `31251184001` (job `93087699646`) — **PASS**.
Historical migration snapshot run `31261478319` (job `93112871251`) — **PASS**.

The exploit tests use a local Clarinet/Simnet manifest that points directly to unchanged production source files under `mainnet/contracts/`. No exploit transaction was sent to mainnet or public testnet. Historical/current mainnet evidence was gathered read-only through public Hiro API endpoints.

## Finding #3 — sUSDh reserve donation / share-price inflation

**Technical disposition: dynamically confirmed. Distinct direct-donation root cause remains present; meaningful current-mainnet impact has not been established.**

Production behavior exercised:

1. `staking-v1-1.stake()` calculates `amount-susdh = floor(amount-usdh * 1e8 / ratio)` with no `minSharesOut` check.
2. `get-usdh-per-susdh()` derives the ratio from the raw USDh token balance of `staking-reserve-v1` divided by total sUSDh supply.
3. USDh can be transferred directly to the staking-reserve principal without going through `stake()`, increasing backing without increasing sUSDh supply.
4. `unstake()` fixes the USDh amount in a claim and immediately transfers that amount from staking-reserve to staking-silo; the cooldown delays final withdrawal but does not undo the captured exchange rate.

Exact successful PoC sequence (8-decimal token units):

- attacker initial stake: `u1` raw USDh -> `u1` raw sUSDh
- attacker direct donation: `u50000000000` = 500 USDh
- ratio after donation: `u5000000000100000000`
- victim stake: `u100000000000` = 1000 USDh
- victim receives only `u1` raw sUSDh
- ratio after victim stake: `u7500000000050000000`
- attacker unstake claim: `u75000000000` = 750 USDh
- victim unstake claim: `u75000000001` = 750.00000001 USDh
- attacker cost: `u50000000001` = 500.00000001 USDh
- attacker payout: `u75000000000` = 750 USDh
- **attacker profit: `u24999999999` = 249.99999999 USDh**
- victim deposit: `u100000000000` = 1000 USDh
- victim payout: `u75000000001` = 750.00000001 USDh
- **victim loss: `u24999999999` = 249.99999999 USDh**
- exact invariant: `attackerProfit == victimLoss`

Runner final assertion:

`PASS: donation inflation transfers exactly 249.99999999 USDh from later staker to attacker.`

### Current mainnet feasibility check

Read-only state captured on 2026-08-08:

- staking reserve: `SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.staking-reserve-v1`
- USDh reserve balance raw: `134202105895456` = **1,342,021.05895456 USDh**
- sUSDh total supply raw: `107110364114752` = **1,071,103.64114752 sUSDh**
- current `get-usdh-per-susdh`: `u125293296` = approximately **1.25293296 USDh/sUSDh**

At this state, ordinary integer-rounding loss is less than the value of one raw sUSDh unit, roughly `1.25293296e-8 USDh`. Inflating one raw share enough to remove material value from a later deposit requires an enormous increase in total reserve backing because the ratio is global over more than 1.071 million whole sUSDh. The low-liquidity 250 USDh PoC therefore does not establish a presently economical mainnet attack.

### Historical v1 -> v1.1 migration reconstruction

The historical on-chain sequence was reconstructed read-only to test whether the near-empty-reserve PoC corresponded to an actual public migration window.

Immediately before and at deployment of `staking-v1-1`:

- block `3567257`: old staking backing `251323307744674` raw = **2,513,233.07744674 USDh**; new reserve `0`; global sUSDh supply `212209174140002` raw = **2,122,091.74140002 sUSDh**; old ratio `1.18431876`; hypothetical empty-reserve fallback ratio `1.0`.
- block `3567258`: `staking-v1-1` deployed; balances/supply unchanged and new reserve still `0`.
- through block `3567400`: new reserve still `0` while all backing remained in old staking.

The actual migration transaction was then identified exactly:

- block `3567404`, tx `0xe318c9...`: `emergency-recover-v1.recover-usdh(staking-v1, staking-reserve-v1)`.
- event 0 burns **exactly `251323307744674` raw USDh** from old `staking-v1`.
- event 1 mints **exactly `251323307744674` raw USDh** to new `staking-reserve-v1`.

Only after that full backing migration:

- block `3567458`: `hq-v1.activate-minting-contract(staking-v1-1)` succeeds.
- block `3567490`: new `staking-silo-v1-1` is activated as protocol.
- block `3567765`: first observed successful public v1.1 stake, 10 USDh, executes at the restored ratio `u118431876` = **1.18431876**.
- block `3567784`: second observed public stake, 3 USDh, also uses `1.18431876`.

Therefore **the new v1.1 staking contract was not capable of minting sUSDh before the backing migration**. The specific historical scenario “new public staking opens with an empty reserve” is disproven.

There was, however, a separate window where the *old* `staking-v1` remained a registered minting contract until block `3567908`, after backing had already been moved and after v1.1 was activated. That is exactly the separate-version/shared-supply class covered by the September 2025 audit H-01. It must not be presented as a new finding.

### Audit / duplicate separation

The September 2025 USDh Upgrade audit H-01 concerned **two staking contract versions sharing one global sUSDh supply while using separate backing balances** and prescribed a migration/activation sequence. That is a different source from this finding.

The current direct-donation source is:

`ordinary permissionless USDh SIP-010 transfer -> staking-reserve raw balance increases -> get-usdh-per-susdh increases -> later stake floors shares`.

The audit report does not describe a donation/inflation/direct-transfer attack into the reserve. Upstream searches also found no PR/commit dedicated to donation inflation. PR #36 only hardened **outgoing** `staking-reserve.transfer()` authorization; it cannot prevent an ordinary holder from transferring USDh **into** the reserve principal through `usdh-token.transfer()`.

So the donation primitive is not an obvious duplicate of H-01 or PR #36. The remaining weakness is impact/feasibility at the current large supply, not technical existence or deduplication.

## Finding #5 — pending-admin `tx-sender` confused deputy -> reserve drain

**Technical disposition: dynamically confirmed for the USDh governance contracts, but not reproduced against hBTC HQ.**

Sequence on unchanged USDh `hq-v1.clar` + `redeeming-reserve-v1-2.clar`:

1. A legitimate owner calls `request-admin-update(pendingAdmin)`.
2. The PoC mines past the production `u1008` activation delay.
3. The pending admin invokes only an attacker-controlled contract.
4. Preserved `tx-sender` lets the attacker contract call `hq.activate-admin(tx-sender)`.
5. In the same transaction, the now-active admin identity preserved in `tx-sender` lets the attacker contract call `hq.set-contract-active(evilContract, true)`.
6. `redeeming-reserve.transfer()` trusts an active protocol `contract-caller`; the attacker contract sends reserve USDh to an arbitrary recipient.

Exact runtime result:

- redeeming reserve before: `u100000000000` = 1000 USDh
- malicious contract deployment: success
- legitimate owner nomination: `(ok true)`
- nested malicious call by pending admin: `(ok true)`
- `hq.get-contract-active(evil)`: `true`
- redeeming reserve after: `u0`
- attacker balance after: `u100000000000` = **1000 USDh**

Runner final assertion:

`PASS #5: nominated admin calling malicious contract activates itself, authorizes attacker contract, and drains 1000 USDh reserve in one transaction.`

### hBTC counter-check

Current production `mainnet/contracts/hbtc/protocol/hq-v1.clar` authenticates privileged setters through `contract-caller` rather than the USDh HQ's preserved `tx-sender` pattern. Therefore this exact privilege-escalation chain does **not** transfer to the current hBTC HQ.

**Bounty caveat:** exploitation requires a legitimately nominated pending admin to invoke an attacker-controlled contract after the activation delay. The current Immunefi program describes hBTC as its single product in scope and excludes impacts requiring privileged-address access and phishing/social engineering. Treat #5 as a technically valid USDh issue but not a good current Hermetica bounty submission.

## Finding #6 — `tx-sender` token theft through nested contract

**Technical disposition: dynamically confirmed on USDh, sUSDh, and directly on production hBTC token; not upgraded to a non-phishing Hermetica exploit path.**

The production token transfers authorize a transfer when supplied `sender` equals either `tx-sender` or `contract-caller`. A malicious contract invoked by a token holder can preserve the holder as `tx-sender` and call the token contract with the victim as `sender`, without any allowance.

### USDh + sUSDh runtime

- victim initially: 100 USDh + 100 sUSDh
- victim calls only `evil-token-router.steal-both`
- victim final USDh: `u0`
- victim final sUSDh: `u0`
- attacker final USDh: `u10000000000` = 100 USDh
- attacker final sUSDh: `u10000000000` = 100 sUSDh

### In-scope hBTC token runtime

A second PoC uses unchanged production hBTC contracts (`hq-v1.clar`, `blacklist-v1.clar`, `token-hbtc.clar`). Local funding is established through the real timelocked hBTC PROTOCOL-role flow, then the victim holds exactly 1 hBTC.

- victim hBTC before: `u100000000` = 1.00000000 hBTC
- attacker hBTC before: `u0`
- victim invokes only `evil-hbtc-router.steal-hbtc`
- nested `token-hbtc.transfer(amount, tx-sender, attacker, none)` succeeds
- victim hBTC after: `u0`
- attacker hBTC after: `u100000000` = **1.00000000 hBTC**

Runner final assertion:

`PASS hBTC: victim calling one malicious contract loses 1.00000000 hBTC to attacker without allowance.`

### Normal-protocol-path counter-check

A repository-wide call-path review did **not** find a normal hBTC user flow that injects an attacker-controlled callback without the user choosing the malicious contract:

- `vault-v1-2` uses fixed token/reserve contracts for deposit/redeem flows.
- arbitrary assets/externals in `state-v1` are owner-controlled and timelocked.
- `trading-v1` and integration interfaces are role-gated and validate registered externals.
- some interface `let` expressions evaluate trait read calls before authorization, but state changes are rolled back on later auth failure and the observed pre-auth callbacks do not create a theft path.

In addition, SIP-010 itself permits the `tx-sender` authorization pattern for `transfer`, with wallet post-conditions as an important safety boundary. A prior public Clarity Alliance audit also discussed the general `tx-sender` confused-deputy/phishing class and explicitly did not recommend removing `tx-sender` from SIP-010 transfer.

Thus #6 demonstrates real nested-call transfer semantics and direct loss in a malicious-contract transaction, but it currently looks like a standard/phishing-adjacent Stacks interaction rather than a Hermetica-specific Critical exploit. Under the bounty's phishing/social-engineering exclusion it should not be submitted without a normal Hermetica call path that removes that user-interaction prerequisite.

## Finding #4 — negative PnL accounting

**Disposition: not confirmed.**

The current hBTC controller contains explicit negative-reward/loss handling and tests for reserve-fund coverage / total-assets reduction. No complete permissionless source -> missing accounting -> attacker profit or user loss chain was established for the separate USDh reward controller. It should not be represented as a validated High/Critical finding.

## Final submission ranking after adversarial validation

1. **#3 — only clearly distinct protocol logic primitive:** executable and apparently non-duplicate, but meaningful current-mainnet impact is not established because of the large live sUSDh supply. Historical empty-new-reserve exploitability was specifically disproven; the separate dual-version window belongs to known H-01.
2. **#6 — strongest raw hBTC asset impact:** executable 1 hBTC nested-call theft, but the required malicious-contract interaction and SIP-010/audit precedent make a bounty rejection likely.
3. **#5 — strong technical USDh reserve drain:** fully executable, but wrong current product/governance model and privileged/social prerequisite.
4. **#4 — do not submit.**

If optimizing strictly for expected current Hermetica bounty payout, none of #3/#5/#6 is yet a clean High/Critical submission. #3 is the best candidate to continue researching because its root cause is distinct and permissionless; the missing element is a currently reachable way to make the global sUSDh ratio manipulation economically material without requiring impossible USDh amounts or a state already covered by audit H-01.
