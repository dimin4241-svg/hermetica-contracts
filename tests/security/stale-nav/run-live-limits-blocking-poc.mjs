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
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const c = n => `${deployer}.${n}`;
const reserve = c('reserve');
const helper = c('strategy-loss-helper');

const text = r => cvToString(r.result);
const pub = (n, fn, args, sender) => simnet.callPublicFn(c(n), fn, args, sender);
const ro = (n, fn, args = [], sender = deployer) => simnet.callReadOnlyFn(c(n), fn, args, sender);
function expect(label, r, wanted) {
  const got = text(r); console.log(`${label}: ${got}`); assert.equal(got, wanted);
}
function u(r) { const m = text(r).match(/(?:\(ok )?u(\d+)\)?/); if (!m) throw new Error(text(r)); return BigInt(m[1]); }
function sbtc(who) { return u(simnet.callReadOnlyFn(SBTC, 'get-balance-available', [Cl.principal(who)], deployer)); }
function price() { return u(ro('state', 'get-share-price')); }

function requestRole(fn, address) { expect(fn, pub('hq-hbtc', fn, [Cl.principal(address), Cl.bool(true)], deployer), '(ok true)'); }
function confirmRole(fn, address) { expect(fn, pub('hq-hbtc', fn, [Cl.principal(address)], deployer), '(ok true)'); }

const state = c('state'), vault = c('vault'), controller = c('controller-hbtc');
for (const address of [state, vault, controller, helper]) requestRole('request-protocol-update', address);
requestRole('request-rewarder-update', rewarder);
expect('request sBTC asset', pub('state', 'request-asset-add', [Cl.principal(SBTC), Cl.buffer(new Uint8Array(32)), Cl.uint(8), Cl.uint(500), Cl.bool(false)], deployer), '(ok true)');

simnet.mineEmptyBlocks(200);
for (const address of [state, vault, controller, helper]) confirmRole('confirm-protocol-request', address);
confirmRole('confirm-rewarder-request', rewarder);
expect('confirm sBTC asset', pub('state', 'confirm-asset-request', [Cl.principal(SBTC)], deployer), '(ok true)');
expect('deposit cap', pub('state', 'set-deposit-cap', [Cl.uint(2n * BASE)], deployer), '(ok true)');

// Prove the production defaults represented by the unchanged source.
expect('default max-reward', ro('state', 'get-max-reward'), 'u5');
expect('default max-deviation', ro('state', 'get-max-deviation'), 'u7');
expect('default update-window', ro('state', 'get-update-window'), 'u86340');

for (const [who, amount] of [[attacker, ATTACKER_SHARES], [deployer, LEGACY], [victim, VICTIM_DEPOSIT]]) {
  const r = simnet.callPrivateFn(SBTC, 'protocol-mint-many-iter', [Cl.tuple({ amount: Cl.uint(amount), recipient: Cl.principal(who) })], deployer);
  assert.equal(text(r), '(ok true)');
}

expect('attacker deposit', pub('vault', 'deposit', [Cl.uint(ATTACKER_SHARES), Cl.none()], attacker), '(ok u40000000)');
expect('legacy deposit', pub('vault', 'deposit', [Cl.uint(LEGACY), Cl.none()], deployer), '(ok u60000000)');
expect('matured claim request', pub('vault', 'request-redeem', [Cl.uint(ATTACKER_SHARES), Cl.bool(false)], attacker), '(ok u1)');
simnet.mineEmptyBlocks(500);

expect('deploy 1 sBTC to external strategy', pub('strategy-loss-helper', 'pull-from-reserve', [Cl.uint(BASE)], deployer), '(ok true)');
expect('fresh NAV log', pub('controller-hbtc', 'log-reward', [Cl.uint(0), Cl.bool(true)], rewarder), '(ok true)');
expect('realize 6bps loss', pub('strategy-loss-helper', 'realize-loss', [Cl.uint(LOSS), Cl.principal(deployer)], deployer), '(ok true)');
assert.equal(sbtc(helper), BASE - LOSS);

// First barrier: a real loss cannot be reflected until the daily window opens.
expect('immediate negative update', pub('controller-hbtc', 'log-reward', [Cl.uint(LOSS), Cl.bool(false)], rewarder), '(err u102011)');
assert.equal(price(), BASE);

// A normal depositor still enters at the stale price and supplies real reserve liquidity.
expect('victim stale deposit', pub('vault', 'deposit', [Cl.uint(VICTIM_DEPOSIT), Cl.none()], victim), '(ok u40000000)');
assert.equal(sbtc(reserve), VICTIM_DEPOSIT);
expect('fund old matured claim', pub('vault', 'fund-claim', [Cl.uint(1)], attacker), '(ok u40000000)');
assert.equal(sbtc(reserve), 0n);
expect('redeem old claim', pub('vault', 'redeem', [Cl.uint(1)], attacker), '(ok u40000000)');

// Second barrier: even after the time window opens, the unchanged 5bps max-reward
// cap rejects this already-realized 6bps loss in one reconciliation transaction.
simnet.mineEmptyBlocks(200);
expect('post-window 6bps negative update remains blocked', pub('controller-hbtc', 'log-reward', [Cl.uint(LOSS), Cl.bool(false)], rewarder), '(err u102009)');
assert.equal(price(), BASE, 'share price remains stale even after the daily window opens');

// At most 5bps can be recognized in this window. Doing so starts a new daily window,
// leaving the final 1bp stale until another window (absent governance intervention).
const FIVE_BPS = 50_000n;
expect('recognize only 5bps', pub('controller-hbtc', 'log-reward', [Cl.uint(FIVE_BPS), Cl.bool(false)], rewarder), '(ok true)');
assert.equal(price(), 99_950_000n);
expect('remaining 1bp immediately blocked by new window', pub('controller-hbtc', 'log-reward', [Cl.uint(LOSS - FIVE_BPS), Cl.bool(false)], rewarder), '(err u102011)');

console.log('PASS LIVE-LIMITS: a realized 6bps loss cannot be fully reconciled in one daily window under the unchanged 5bps cap, while stale-price deposits and matured claim funding remain enabled.');
