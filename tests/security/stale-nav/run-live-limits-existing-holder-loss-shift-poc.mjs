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
const STRATEGY_DEPLOYMENT = 50_000_000n;
const LOSS = 60_000n; // 6 bps of pre-loss NAV
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const c = n => `${deployer}.${n}`;
const reserve = c('reserve');
const helper = c('strategy-loss-helper');

const text = r => cvToString(r.result);
const pub = (n, fn, args, sender) => simnet.callPublicFn(c(n), fn, args, sender);
const ro = (n, fn, args = [], sender = deployer) => simnet.callReadOnlyFn(c(n), fn, args, sender);
function expect(label, r, wanted) {
  const got = text(r);
  console.log(`${label}: ${got}`);
  assert.equal(got, wanted, `${label}: expected ${wanted}, got ${got}`);
}
function u(r) {
  const m = text(r).match(/(?:\(ok )?u(\d+)\)?/);
  if (!m) throw new Error(text(r));
  return BigInt(m[1]);
}
function sbtc(who) {
  return u(simnet.callReadOnlyFn(SBTC, 'get-balance-available', [Cl.principal(who)], deployer));
}
function hbtc(who) { return u(ro('token-hbtc', 'get-balance', [Cl.principal(who)], who)); }
function price() { return u(ro('state', 'get-share-price')); }
function totalAssets() { return u(ro('state', 'get-total-assets')); }
function supply() { return u(ro('token-hbtc', 'get-total-supply')); }
function assetsForShares(shares, sender = deployer) {
  return u(ro('state', 'convert-to-assets', [Cl.uint(shares)], sender));
}
function requestRole(fn, address) {
  expect(fn, pub('hq-hbtc', fn, [Cl.principal(address), Cl.bool(true)], deployer), '(ok true)');
}
function confirmRole(fn, address) {
  expect(fn, pub('hq-hbtc', fn, [Cl.principal(address)], deployer), '(ok true)');
}

const state = c('state');
const vault = c('vault');
const controller = c('controller-hbtc');
for (const address of [state, vault, controller, helper]) requestRole('request-protocol-update', address);
requestRole('request-rewarder-update', rewarder);
expect('request sBTC asset', pub('state', 'request-asset-add', [
  Cl.principal(SBTC), Cl.buffer(new Uint8Array(32)), Cl.uint(8), Cl.uint(500), Cl.bool(false),
], deployer), '(ok true)');
simnet.mineEmptyBlocks(200);
for (const address of [state, vault, controller, helper]) confirmRole('confirm-protocol-request', address);
confirmRole('confirm-rewarder-request', rewarder);
expect('confirm sBTC asset', pub('state', 'confirm-asset-request', [Cl.principal(SBTC)], deployer), '(ok true)');
expect('deposit cap', pub('state', 'set-deposit-cap', [Cl.uint(2n * BASE)], deployer), '(ok true)');

expect('default max-reward', ro('state', 'get-max-reward'), 'u5');
expect('default max-deviation', ro('state', 'get-max-deviation'), 'u7');
expect('default update-window', ro('state', 'get-update-window'), 'u86340');

for (const [who, amount] of [[attacker, ATTACKER_SHARES], [victim, VICTIM_SHARES]]) {
  const r = simnet.callPrivateFn(
    SBTC,
    'protocol-mint-many-iter',
    [Cl.tuple({ amount: Cl.uint(amount), recipient: Cl.principal(who) })],
    deployer,
  );
  assert.equal(text(r), '(ok true)');
}

console.log('=== both attacker and victim are holders before the loss ===');
expect('attacker deposit 0.40', pub('vault', 'deposit', [Cl.uint(ATTACKER_SHARES), Cl.none()], attacker), '(ok u40000000)');
expect('victim deposit 0.60', pub('vault', 'deposit', [Cl.uint(VICTIM_SHARES), Cl.none()], victim), '(ok u60000000)');
expect('attacker pre-positions standard redeem', pub('vault', 'request-redeem', [Cl.uint(ATTACKER_SHARES), Cl.bool(false)], attacker), '(ok u1)');
simnet.mineEmptyBlocks(500);
assert.equal(totalAssets(), BASE);
assert.equal(supply(), BASE);
assert.equal(price(), BASE);
assert.equal(hbtc(victim), VICTIM_SHARES);

console.log('=== normal mixed-liquidity state: half reserve, half external strategy ===');
expect('deploy 0.50 sBTC to strategy', pub('strategy-loss-helper', 'pull-from-reserve', [Cl.uint(STRATEGY_DEPLOYMENT)], deployer), '(ok true)');
assert.equal(sbtc(reserve), BASE - STRATEGY_DEPLOYMENT);
assert.equal(sbtc(helper), STRATEGY_DEPLOYMENT);

expect('fresh NAV log', pub('controller-hbtc', 'log-reward', [Cl.uint(0), Cl.bool(true)], rewarder), '(ok true)');
const freshLastLogTs = u(ro('state', 'get-last-log-ts'));
expect('PR137 guard after fresh log', ro('pr137-shadow', 'is-sp-stale', [Cl.uint(freshLastLogTs)]), 'false');

console.log('=== strategy realizes a 6bps loss while accounting remains fresh-by-timestamp ===');
expect('realize 6bps external loss', pub('strategy-loss-helper', 'realize-loss', [Cl.uint(LOSS), Cl.principal(deployer)], deployer), '(ok true)');
assert.equal(sbtc(helper), STRATEGY_DEPLOYMENT - LOSS);
expect('PR137 guard after realized loss', ro('pr137-shadow', 'is-sp-stale', [Cl.uint(freshLastLogTs)]), 'false');
expect('full loss update exceeds 5bps cap', pub('controller-hbtc', 'log-reward', [Cl.uint(LOSS), Cl.bool(false)], rewarder), '(err u102009)');
assert.equal(price(), BASE);

console.log('=== attacker exits from pre-existing reserve at stale pre-loss NAV ===');
expect('permissionless fund matured claim', pub('vault', 'fund-claim', [Cl.uint(1)], attacker), '(ok u40000000)');
assert.equal(sbtc(reserve), 10_000_000n);
expect('attacker redeem', pub('vault', 'redeem', [Cl.uint(1)], attacker), '(ok u40000000)');
assert.equal(totalAssets(), VICTIM_SHARES);
assert.equal(supply(), VICTIM_SHARES);
assert.equal(price(), BASE);
assert.equal(hbtc(victim), VICTIM_SHARES);

console.log('=== reconcile the already-realized loss under unchanged 5bps cap ===');
let remainingLoss = LOSS;
let windows = 0;
while (remainingLoss > 0n) {
  simnet.mineEmptyBlocks(200);
  const currentAssets = totalAssets();
  const cap = 5n * currentAssets / 10_000n;
  const step = remainingLoss < cap ? remainingLoss : cap;
  expect(`recognize loss window ${windows + 1}`, pub('controller-hbtc', 'log-reward', [Cl.uint(step), Cl.bool(false)], rewarder), '(ok true)');
  remainingLoss -= step;
  windows++;
  assert.ok(windows <= 5, 'unexpected reconciliation loop');
}

assert.equal(totalAssets(), 59_940_000n);
assert.equal(supply(), VICTIM_SHARES);
assert.equal(price(), 99_900_000n);

console.log('=== exact loss-shift invariant ===');
const attackerStalePayout = ATTACKER_SHARES;
const attackerFairPayout = ATTACKER_SHARES * (BASE - LOSS) / BASE;
const attackerAvoidedLoss = attackerStalePayout - attackerFairPayout;
const victimFinalValue = assetsForShares(VICTIM_SHARES, victim);
const victimActualLoss = VICTIM_SHARES - victimFinalValue;
const victimFairLoss = VICTIM_SHARES * LOSS / BASE;
const victimIncrementalLoss = victimActualLoss - victimFairLoss;

console.log(`attacker stale payout raw:       ${attackerStalePayout}`);
console.log(`attacker fair post-loss raw:     ${attackerFairPayout}`);
console.log(`attacker avoided loss raw:       ${attackerAvoidedLoss}`);
console.log(`victim fair loss raw:            ${victimFairLoss}`);
console.log(`victim actual loss raw:          ${victimActualLoss}`);
console.log(`victim incremental loss raw:     ${victimIncrementalLoss}`);
console.log(`reconciliation windows:          ${windows}`);

assert.equal(attackerFairPayout, 39_976_000n);
assert.equal(attackerAvoidedLoss, 24_000n);
assert.equal(victimFinalValue, 59_940_000n);
assert.equal(victimFairLoss, 36_000n);
assert.equal(victimActualLoss, 60_000n);
assert.equal(victimIncrementalLoss, 24_000n);
assert.equal(attackerAvoidedLoss, victimIncrementalLoss);

console.log('PASS EXISTING-HOLDER LOSS SHIFT: no post-loss depositor is required. With max-reward=5bps and max-deviation=7bps unchanged, a matured claimant exits from pre-existing reserve at stale NAV after a 6bps realized strategy loss, avoids exactly 24,000 sats of loss, and an already-existing holder absorbs exactly 24,000 sats of incremental loss after reconciliation. PR #137 timestamp-only staleness remains false during the exploit window.');
