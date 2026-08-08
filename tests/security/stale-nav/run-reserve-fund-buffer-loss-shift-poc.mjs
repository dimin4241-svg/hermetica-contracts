import assert from 'node:assert/strict';
import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

const simnet = await initSimnet('tests/security/stale-nav/Clarinet.toml');
const accounts = simnet.getAccounts();
const deployer = accounts.get('deployer');
const rewarder = accounts.get('wallet_1');
const attacker = accounts.get('wallet_2');
const victim = accounts.get('wallet_3');
if (!deployer || !rewarder || !attacker || !victim) throw new Error('missing accounts');

const BASE = 100_000_000n;
const ATTACKER_SHARES = 40_000_000n;
const VICTIM_SHARES = 60_000_000n;
const STRATEGY_CAPITAL = 50_000_000n;
const RF_BUFFER = 250_000n;
const GROSS_LOSS = 300_000n;
const UNCOVERED_LOSS = 50_000n;
const ATTACKER_FAIR_LOSS = 20_000n;
const VICTIM_FAIR_LOSS = 30_000n;
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const c = n => `${deployer}.${n}`;
const state = c('state');
const vault = c('vault');
const controller = c('controller-hbtc');
const reserve = c('reserve');
const reserveFund = c('reserve-fund');
const helper = c('strategy-loss-helper');

const text = r => cvToString(r.result);
const pub = (n, fn, args, sender) => simnet.callPublicFn(c(n), fn, args, sender);
const ro = (n, fn, args = [], sender = deployer) => simnet.callReadOnlyFn(c(n), fn, args, sender);
function expect(label, r, wanted) { const got = text(r); console.log(`${label}: ${got}`); assert.equal(got, wanted, `${label}: expected ${wanted}, got ${got}`); }
function u(r) { const m = text(r).match(/(?:\(ok )?u(\d+)\)?/); if (!m) throw new Error(text(r)); return BigInt(m[1]); }
function sbtc(who) { return u(simnet.callReadOnlyFn(SBTC, 'get-balance-available', [Cl.principal(who)], deployer)); }
function hbtc(who) { return u(ro('token-hbtc', 'get-balance', [Cl.principal(who)], who)); }
function assetsForShares(shares, sender = deployer) { return u(ro('state', 'convert-to-assets', [Cl.uint(shares)], sender)); }

function requestRole(fn, address) { expect(fn, pub('hq-hbtc', fn, [Cl.principal(address), Cl.bool(true)], deployer), '(ok true)'); }
function confirmRole(fn, address) { expect(fn, pub('hq-hbtc', fn, [Cl.principal(address)], deployer), '(ok true)'); }

console.log('=== setup unchanged production accounting limits and production RF topology ===');
// reserve is deliberately included: reserve-fund.transfer() requires both the controller caller
// and the reserve recipient to hold the HQ PROTOCOL role, exactly as in production topology.
for (const address of [state, vault, controller, reserve, helper]) requestRole('request-protocol-update', address);
requestRole('request-rewarder-update', rewarder);
expect('request sBTC asset', pub('state', 'request-asset-add', [Cl.principal(SBTC), Cl.buffer(new Uint8Array(32)), Cl.uint(8), Cl.uint(500), Cl.bool(false)], deployer), '(ok true)');

simnet.mineEmptyBlocks(200);
for (const address of [state, vault, controller, reserve, helper]) confirmRole('confirm-protocol-request', address);
confirmRole('confirm-rewarder-request', rewarder);
expect('confirm sBTC asset', pub('state', 'confirm-asset-request', [Cl.principal(SBTC)], deployer), '(ok true)');
expect('deposit cap', pub('state', 'set-deposit-cap', [Cl.uint(2n * BASE)], deployer), '(ok true)');
expect('default max-reward', ro('state', 'get-max-reward'), 'u5');
expect('default max-deviation', ro('state', 'get-max-deviation'), 'u7');

for (const [who, amount] of [[attacker, ATTACKER_SHARES], [victim, VICTIM_SHARES], [reserveFund, RF_BUFFER]]) {
  const r = simnet.callPrivateFn(SBTC, 'protocol-mint-many-iter', [Cl.tuple({ amount: Cl.uint(amount), recipient: Cl.principal(who) })], deployer);
  assert.equal(text(r), '(ok true)');
}
assert.equal(sbtc(reserveFund), RF_BUFFER);

console.log('=== two pre-loss holders; attacker pre-positions a mature standard claim ===');
expect('attacker deposit 0.40', pub('vault', 'deposit', [Cl.uint(ATTACKER_SHARES), Cl.none()], attacker), '(ok u40000000)');
expect('victim deposit 0.60', pub('vault', 'deposit', [Cl.uint(VICTIM_SHARES), Cl.none()], victim), '(ok u60000000)');
expect('attacker request redeem', pub('vault', 'request-redeem', [Cl.uint(ATTACKER_SHARES), Cl.bool(false)], attacker), '(ok u1)');
simnet.mineEmptyBlocks(500);

console.log('=== mixed liquidity + fresh NAV ===');
expect('deploy 0.50 sBTC to strategy', pub('strategy-loss-helper', 'pull-from-reserve', [Cl.uint(STRATEGY_CAPITAL)], deployer), '(ok true)');
assert.equal(sbtc(reserve), BASE - STRATEGY_CAPITAL);
expect('fresh NAV log', pub('controller-hbtc', 'log-reward', [Cl.uint(0), Cl.bool(true)], rewarder), '(ok true)');
const freshLogTs = u(ro('state', 'get-last-log-ts'));
expect('PR137 guard after fresh log', ro('pr137-shadow', 'is-sp-stale', [Cl.uint(freshLogTs)]), 'false');

console.log('=== 30bps gross strategy loss with a 25bps Reserve Fund ===');
expect('realize 30bps external loss', pub('strategy-loss-helper', 'realize-loss', [Cl.uint(GROSS_LOSS), Cl.principal(deployer)], deployer), '(ok true)');
assert.equal(sbtc(helper), STRATEGY_CAPITAL - GROSS_LOSS);
expect('PR137 guard after realized loss', ro('pr137-shadow', 'is-sp-stale', [Cl.uint(freshLogTs)]), 'false');

// Gross loss is checked against max-reward before Reserve Fund handling.
expect('full 30bps loss rejected before RF coverage', pub('controller-hbtc', 'log-reward', [Cl.uint(GROSS_LOSS), Cl.bool(false)], rewarder), '(err u102009)');
assert.equal(sbtc(reserveFund), RF_BUFFER);
assert.equal(sbtc(reserve), BASE - STRATEGY_CAPITAL);

console.log('=== attacker exits from pre-existing reserve while NAV still ignores the realized loss ===');
const attackerLiquidBaseline = sbtc(attacker);
expect('fund mature attacker claim', pub('vault', 'fund-claim', [Cl.uint(1)], attacker), '(ok u40000000)');
expect('attacker redeem stale claim', pub('vault', 'redeem', [Cl.uint(1)], attacker), '(ok u40000000)');
const attackerPayout = sbtc(attacker) - attackerLiquidBaseline;
assert.equal(attackerPayout, ATTACKER_SHARES);
assert.equal(sbtc(reserve), 10_000_000n);

console.log('=== governance recovery barrier #1: stale exit shrinks the max-reward denominator ===');
// After the stale 0.40 exit, total-assets is 0.60 sBTC, so the same 300,000-sat gross loss
// is now 50bps of accounting total-assets. A 30bps setting would still be insufficient.
expect('request max-reward 50bps', pub('state', 'request-max-reward-update', [Cl.uint(50)], deployer), '(ok true)');
simnet.mineEmptyBlocks(200);
expect('confirm max-reward 50bps', pub('state', 'confirm-max-reward-request', [], deployer), '(ok true)');
expect('max-reward now 50bps', ro('state', 'get-max-reward'), 'u50');

console.log('=== governance recovery barrier #2: RF-covered gross loss still exceeds share-price deviation ===');
// RF covers 250,000 sats, leaving only 50,000 sats to holders. After attacker burned 40% of supply,
// 50,000 / 60,000,000 ~= 8.33bps of share-price movement, above max-deviation=7bps.
expect('max-reward-only recovery blocked by max-deviation', pub('controller-hbtc', 'log-reward', [Cl.uint(GROSS_LOSS), Cl.bool(false)], rewarder), '(err u102014)');
assert.equal(sbtc(reserveFund), RF_BUFFER, 'deviation failure rolls back attempted RF transfer');
expect('request max-deviation 9bps', pub('state', 'request-max-deviation-update', [Cl.uint(9)], deployer), '(ok true)');
simnet.mineEmptyBlocks(200);
expect('confirm max-deviation 9bps', pub('state', 'confirm-max-deviation-request', [], deployer), '(ok true)');
expect('max-deviation now 9bps', ro('state', 'get-max-deviation'), 'u9');

console.log('=== only after both timelocked recovery changes can RF + loss accounting execute ===');
expect('reconcile 30bps gross loss after governance recovery', pub('controller-hbtc', 'log-reward', [Cl.uint(GROSS_LOSS), Cl.bool(false)], rewarder), '(ok true)');
assert.equal(sbtc(reserveFund), 0n);
assert.equal(sbtc(reserve), 10_000_000n + RF_BUFFER);

console.log('=== exact uncovered-loss shift after RF protection ===');
const victimShares = hbtc(victim);
assert.equal(victimShares, VICTIM_SHARES);
const victimFinalValue = assetsForShares(victimShares, victim);
const victimActualLoss = VICTIM_SHARES - victimFinalValue;
const attackerFairPayout = ATTACKER_SHARES - ATTACKER_FAIR_LOSS;
const attackerAvoidedLoss = attackerPayout - attackerFairPayout;
const victimIncrementalLoss = victimActualLoss - VICTIM_FAIR_LOSS;

console.log(`RF buffer raw:                  ${RF_BUFFER}`);
console.log(`gross realized loss raw:        ${GROSS_LOSS}`);
console.log(`uncovered holder loss raw:      ${UNCOVERED_LOSS}`);
console.log(`attacker stale payout raw:      ${attackerPayout}`);
console.log(`attacker fair payout raw:       ${attackerFairPayout}`);
console.log(`attacker avoided loss raw:      ${attackerAvoidedLoss}`);
console.log(`victim fair loss raw:           ${VICTIM_FAIR_LOSS}`);
console.log(`victim actual loss raw:         ${victimActualLoss}`);
console.log(`victim incremental loss raw:    ${victimIncrementalLoss}`);

assert.equal(attackerFairPayout, 39_980_000n);
assert.equal(attackerAvoidedLoss, ATTACKER_FAIR_LOSS);
assert.equal(victimActualLoss, UNCOVERED_LOSS);
assert.equal(victimIncrementalLoss, ATTACKER_FAIR_LOSS);
assert.equal(attackerAvoidedLoss, victimIncrementalLoss);

console.log('PASS RF-BUFFER LOSS SHIFT: a 25bps Reserve Fund does not prevent the stale-NAV loss shift. A 30bps gross loss is rejected before RF can be applied at max-reward=5bps. The claimant exits at stale NAV from existing reserve. That exit reduces total-assets/supply and makes recovery require both timelocked max-reward=50bps and max-deviation>=9bps. Once RF finally covers 25bps, only 5bps remains as holder loss, yet the claimant avoided exactly 20,000 sats and the existing victim absorbed exactly 20,000 sats of incremental loss.');
