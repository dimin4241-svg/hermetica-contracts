# Hermetica security validation results

Validation branch: `validation-susdh-donation-poc`

Latest complete GitHub Actions run: `31250906246` (job `93087014696`) — **PASS**.

The exploit tests use a local Clarinet/Simnet manifest that points directly to the unchanged production source files under `mainnet/contracts/usdh/`. No exploit transaction was sent to mainnet or public testnet. The final workflow also performs a read-only API query to record the current public staking state.

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

Read-only state captured by the same successful workflow at `2026-08-08T09:35:39.070Z`:

- staking reserve: `SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.staking-reserve-v1`
- USDh reserve balance raw: `134202105895456` = **1,342,021.05895456 USDh**
- sUSDh total supply raw: `107110364114752` = **1,071,103.64114752 sUSDh**
- current `get-usdh-per-susdh`: `u125293296` = approximately **1.25293296 USDh/sUSDh**

At this state, ordinary integer-rounding loss is less than the value of one raw sUSDh unit, roughly `1.25293296e-8 USDh`. Inflating one raw share so that rounding alone can remove even 1 USDh from a later deposit would require an exchange rate around `1e8 USDh/sUSDh`, implying a donation on the order of `1.071e14 USDh` at the observed supply. Reproducing the 250 USDh rounding loss from the low-liquidity PoC at the current supply would require a donation on the order of `2.678e16 USDh`.

Therefore the vulnerable primitive is real and executable, but the demonstrated profit path is a **low-liquidity / near-empty-pool state attack**, not a presently economical mainnet exploit at the observed state.

## Finding #5 — pending-admin `tx-sender` confused deputy -> reserve drain

**Technical disposition: dynamically confirmed.**

The PoC uses the unchanged production `hq-v1.clar` and `redeeming-reserve-v1-2.clar` logic.

Sequence:

1. A legitimate owner calls `request-admin-update(pendingAdmin)`.
2. The PoC mines past the production `u1008` activation delay.
3. The pending admin invokes only an attacker-controlled contract.
4. In the nested call, preserved `tx-sender` lets the attacker contract call `hq.activate-admin(tx-sender)`.
5. In the same transaction, the now-active admin identity preserved in `tx-sender` lets the attacker contract call `hq.set-contract-active(evilContract, true)`.
6. `redeeming-reserve.transfer()` trusts an active protocol `contract-caller`; the attacker contract can therefore send reserve USDh to an arbitrary recipient.

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

**Bounty caveat:** exploitation requires a legitimately nominated pending admin to invoke an attacker-controlled contract after the activation delay. This is a real same-transaction privilege-escalation primitive, but that prerequisite overlaps strongly with social-engineering / privileged-actor exclusions.

## Finding #6 — USDh/sUSDh `tx-sender` token theft through nested contract

**Technical disposition: dynamically confirmed.**

Both production token transfers authorize a transfer when the supplied `sender` equals either `tx-sender` or `contract-caller`. A malicious contract invoked by a token holder can therefore preserve the holder as `tx-sender` and call the token contracts with the victim as `sender`, without any allowance.

Exact runtime result:

- victim initially: 100 USDh + 100 sUSDh
- attacker deploys `evil-token-router`
- victim calls only `evil-token-router.steal-both`
- nested USDh transfer succeeds
- nested sUSDh transfer succeeds
- victim final USDh: `u0`
- victim final sUSDh: `u0`
- attacker final USDh: `u10000000000` = 100 USDh
- attacker final sUSDh: `u10000000000` = 100 sUSDh

Runner final assertion:

`PASS #6: victim calling one malicious contract transfers 100 USDh + 100 sUSDh to attacker without allowance.`

**Bounty caveat:** the victim must invoke an attacker-controlled contract. In addition, a prior public Clarity Alliance USDh audit explicitly discussed the general `tx-sender` confused-deputy class and recommended replacing `tx-sender` with `contract-caller` except in SIP-010 `transfer`; therefore the token-transfer behavior has a significant known-design / known-issue risk even though the demonstrated theft primitive is technically real.

## Finding #4 — negative PnL accounting

**Disposition: not confirmed.**

The current hBTC controller contains explicit negative-reward/loss handling and tests for reserve-fund coverage / total-assets reduction. No complete permissionless source -> missing accounting -> attacker profit or user loss chain was established for the separate USDh reward controller. It should not be represented as a validated High/Critical finding.

## Submission ranking after validation

1. **#3:** strongest independent technical vulnerability, but current mainnet economics currently defeat the demonstrated profitable attack. Keep as a latent/low-liquidity finding unless a currently reachable low-supply state is established.
2. **#5:** strongest raw impact (same-transaction privilege escalation into reserve theft), but the pending-admin malicious-call prerequisite is a major scope obstacle.
3. **#6:** direct token-theft primitive is proven, but malicious-contract user interaction plus prior audit treatment make bounty acceptance unlikely.
4. **#4:** do not submit in its current form.
