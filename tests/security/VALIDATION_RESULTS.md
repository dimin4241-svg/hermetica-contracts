# Hermetica security validation results

Validation branch: `validation-susdh-donation-poc`

Latest complete GitHub Actions run: `31251184001` (job `93087699646`) — **PASS**.

The exploit tests use a local Clarinet/Simnet manifest that points directly to unchanged production source files under `mainnet/contracts/`. No exploit transaction was sent to mainnet or public testnet. The workflow also performs a read-only API query to record current public staking state.

## Finding #3 — sUSDh reserve donation / share-price inflation

**Technical disposition: dynamically confirmed.**

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

Read-only state captured by the same successful workflow at `2026-08-08T09:43:24.244Z`:

- staking reserve: `SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.staking-reserve-v1`
- USDh reserve balance raw: `134202105895456` = **1,342,021.05895456 USDh**
- sUSDh total supply raw: `107110364114752` = **1,071,103.64114752 sUSDh**
- current `get-usdh-per-susdh`: `u125293296` = approximately **1.25293296 USDh/sUSDh**

At this state, ordinary integer-rounding loss is less than the value of one raw sUSDh unit, roughly `1.25293296e-8 USDh`. Inflating one raw share so that rounding alone can remove even 1 USDh from a later deposit would require an exchange rate around `1e8 USDh/sUSDh`, implying a donation on the order of `1.071e14 USDh` at the observed supply. Reproducing the 250 USDh rounding loss from the low-liquidity PoC at the current supply would require a donation on the order of `2.678e16 USDh`.

Therefore the vulnerable primitive is real and executable, but the demonstrated profit path is a **low-liquidity / near-empty-pool state attack**, not a presently economical mainnet exploit at the observed state.

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

**Bounty caveat:** exploitation requires a legitimately nominated pending admin to invoke an attacker-controlled contract after the activation delay; the current Hermetica bounty is specifically presented as an hBTC product bounty and excludes phishing/social-engineering impacts. Treat #5 as a technically valid USDh issue but a poor current bounty submission.

## Finding #6 — `tx-sender` token theft through nested contract

**Technical disposition: dynamically confirmed on USDh, sUSDh, and now directly on the production hBTC token that is part of the hBTC codebase.**

The production token transfers authorize a transfer when supplied `sender` equals either `tx-sender` or `contract-caller`. A malicious contract invoked by a token holder can preserve the holder as `tx-sender` and call the token contract with the victim as `sender`, without any allowance.

### USDh + sUSDh runtime

- victim initially: 100 USDh + 100 sUSDh
- victim calls only `evil-token-router.steal-both`
- victim final USDh: `u0`
- victim final sUSDh: `u0`
- attacker final USDh: `u10000000000` = 100 USDh
- attacker final sUSDh: `u10000000000` = 100 sUSDh

Runner assertion:

`PASS #6: victim calling one malicious contract transfers 100 USDh + 100 sUSDh to attacker without allowance.`

### In-scope hBTC token runtime

A second PoC uses unchanged production hBTC contracts (`hq-v1.clar`, `blacklist-v1.clar`, `token-hbtc.clar`). Local funding is established through the real timelocked hBTC PROTOCOL-role flow, then the victim holds exactly 1 hBTC.

- victim hBTC before: `u100000000` = 1.00000000 hBTC
- attacker hBTC before: `u0`
- attacker deploys `evil-hbtc-router`: success
- victim invokes only `evil-hbtc-router.steal-hbtc`
- nested `token-hbtc.transfer(amount, tx-sender, attacker, none)` returns `(ok true)`
- victim hBTC after: `u0`
- attacker hBTC after: `u100000000` = **1.00000000 hBTC**

Runner final assertion:

`PASS hBTC: victim calling one malicious contract loses 1.00000000 hBTC to attacker without allowance.`

### Known-design / scope counterevidence

A prior public Clarity Alliance USDh audit explicitly described the general `tx-sender` confused-deputy/phishing class and recommended replacing `tx-sender` with `contract-caller` **except within SIP-010 `transfer`**. Thus the exact transfer authorization pattern has substantial known-design risk rather than being a clean undisclosed access-control bug. In addition, the exploit requires the victim to invoke an attacker-controlled contract, which strongly overlaps with the bounty's phishing/social-engineering exclusion.

So #6 is now proven even on hBTC itself, but the new proof strengthens **impact and asset scope**, not the weak exploit precondition. Bounty acceptance remains unlikely unless a normal Hermetica workflow can be shown to route an unsuspecting user's transaction through an attacker-controlled nested contract without phishing/social engineering.

## Finding #4 — negative PnL accounting

**Disposition: not confirmed.**

The current hBTC controller contains explicit negative-reward/loss handling and tests for reserve-fund coverage / total-assets reduction. No complete permissionless source -> missing accounting -> attacker profit or user loss chain was established for the separate USDh reward controller. It should not be represented as a validated High/Critical finding.

## Final submission ranking after validation

1. **#6 — strongest raw proof on an hBTC asset:** direct 1 hBTC theft is executable, but malicious-contract victim interaction + prior audit treatment make acceptance unlikely under current rules.
2. **#3 — strongest independent logic flaw:** exact profitable theft is executable in a near-empty pool, but current live supply makes the attack economically theoretical now.
3. **#5 — strongest privilege-escalation chain:** executable USDh reserve drain, but current hBTC HQ uses safer `contract-caller`, and the attack requires a pending admin to invoke malicious code.
4. **#4 — do not submit in its current form.**

If optimizing strictly for expected bounty payout rather than technical correctness, none of #3/#5/#6 is a clean submission yet. The remaining work that could materially change that verdict is to find a normal, intended Hermetica call path that removes the malicious-user/admin-interaction prerequisite from #6/#5, or a currently reachable low-supply staking state for #3.
