import assert from 'node:assert/strict';
import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

const simnet = await initSimnet('tests/security/stale-nav/Clarinet.toml');
const accounts = simnet.getAccounts();
const deployer = accounts.get('deployer');
const rewarder = accounts.get('wallet_1');
const attacker = accounts.get('wallet_2');
const victim = accounts.get('wallet_3');
if (!deployer || !rewarder || !attacker || !victim) throw new Error('missing simnet accounts');

const BASE = 100_000_000n;
const ATTACKER_DEPOSIT = 40_000_000n;
const LEGACY_DEPOSIT = 60_000_000n;
const LOSS = 10_000_000n;
const VICTIM_DEPOSIT = 40_000_000n;
const FAIR_ATTACKER_PAYOUT = 36_000_000n;
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const c = n => `${deployer}.${n}`;
const state = c('state');
const vault = c('vault');
const controller = c('controller-hbtc');
const reserve = c('reserve');
const helper = c('strategy-loss-helper');

const text = r => cvToString(r.result);
const pub = (n, fn, args, sender) => simnet.callPublicFn(c(n), fn, args, sender);
const ro = (n, fn, args = [], sender = deployer) => simnet.callReadOnlyFn(c(n), fn, args, sender);
function expect(label, r, wanted) { const got = text(r); console.log(`${label}: ${got}`); assert.equal(got, wanted); }
function u(r) { const m = text(r).match(/(?:\(ok )?u(\d+)\)?/); if (!m) throw new Error(text(r)); return BigInt(m[1]); }
function sbtc(who) { return u(simnet.callReadOnlyFn(SBTC, 'get-balance-available', [Cl.principal(who)], deployer)); }
function hbtc(who) { return u(ro('token-hbtc', 'get-balance', [Cl.principal(who)])); }
function price() { return u(ro('state', 'get-share-price')); }
function assets() { return u(ro('state', 'get-total-assets')); }

function requestRole(fn, address) { expect(fn, pub('hq-hbtc', fn, [Cl.principal(address), Cl.bool(true)], deployer), '(ok true)'); }
function confirmRole(fn, address) { expect(fn, pub('hq-hbtc', fn, [Cl.principal(address)], deployer), '(ok true)'); }

console.log('=== control setup: same production hBTC flow, same claim, same loss ===');
for (const address of [state, vault, controller, helper]) requestRole('request-protocol-update', address);
requestRole('request-rewarder-update', rewarder);
expect('request sBTC asset', pub('state', 'request-asset-add', [Cl.principal(SBTC), Cl.buffer(new Uint8Array(32)), Cl.uint(8), Cl.uint(500), Cl.bool(false)], deployer), '(ok true)');
expect('request max reward 1000', pub('state', 'request-max-reward-update', [Cl.uint(1000)], deployer), '(ok true)');
expect('request max deviation 2000', pub('state', 'request-max-deviation-update', [Cl.uint(2000)], deployer), '(ok true)');

simnet.mineEmptyBlocks(200);
for (const address of [state, vault, controller, helper]) confirmRole('confirm-protocol-request', address);
confirmRole('confirm-rewarder-request', rewarder);
expect('confirm sBTC asset', pub('state', 'confirm-asset-request', [Cl.principal(SBTC)], deployer), '(ok true)');
expect('confirm max reward', pub('state', 'confirm-max-reward-request', [], deployer), '(ok true)');
expect('confirm max deviation', pub('state', 'confirm-max-deviation-request', [], deployer), '(ok true)');
expect('deposit cap', pub('state', 'set-deposit-cap', [Cl.uint(2n * BASE)], deployer), '(ok true)');

for (const [who, amount] of [[attacker, ATTACKER_DEPOSIT], [deployer, LEGACY_DEPOSIT], [victim, VICTIM_DEPOSIT]]) {
  const r = simnet.callPrivateFn(SBTC, 'protocol-mint-many-iter', [Cl.tuple({ amount: Cl.uint(amount), recipient: Cl.principal(who) })], deployer);
  assert.equal(text(r), '(ok true)');
}

expect('attacker deposit', pub('vault', 'deposit', [Cl.uint(ATTACKER_DEPOSIT), Cl.none()], attacker), '(ok u40000000)');
expect('legacy deposit', pub('vault', 'deposit', [Cl.uint(LEGACY_DEPOSIT), Cl.none()], deployer), '(ok u60000000)');
expect('attacker mature claim', pub('vault', 'request-redeem', [Cl.uint(ATTACKER_DEPOSIT), Cl.bool(false)], attacker), '(ok u1)');
simnet.mineEmptyBlocks(500);

expect('deploy 1.00 sBTC to strategy', pub('strategy-loss-helper', 'pull-from-reserve', [Cl.uint(BASE)], deployer), '(ok true)');
expect('fresh NAV log', pub('controller-hbtc', 'log-reward', [Cl.uint(0), Cl.bool(true)], rewarder), '(ok true)');
expect('realize 0.10 sBTC loss', pub('strategy-loss-helper', 'realize-loss', [Cl.uint(LOSS), Cl.principal(deployer)], deployer), '(ok true)');
expect('immediate loss log blocked', pub('controller-hbtc', 'log-reward', [Cl.uint(LOSS), Cl.bool(false)], rewarder), '(err u102011)');

console.log('=== negative control: reconcile the realized loss BEFORE later deposit/funding ===');
simnet.mineEmptyBlocks(200);
expect('reconcile loss before victim enters', pub('controller-hbtc', 'log-reward', [Cl.uint(LOSS), Cl.bool(false)], rewarder), '(ok true)');
assert.equal(assets(), 90_000_000n);
assert.equal(price(), 90_000_000n);

const attackerLiquidBaseline = sbtc(attacker);
expect('victim deposit after reconciliation', pub('vault', 'deposit', [Cl.uint(VICTIM_DEPOSIT), Cl.none()], victim), '(ok u44444444)');
const victimShares = hbtc(victim);
assert.equal(victimShares, 44_444_444n);
assert.equal(sbtc(reserve), VICTIM_DEPOSIT);

expect('fund old claim at reconciled NAV', pub('vault', 'fund-claim', [Cl.uint(1)], attacker), '(ok u36000000)');
expect('redeem old claim at fair value', pub('vault', 'redeem', [Cl.uint(1)], attacker), '(ok u36000000)');
const attackerPayout = sbtc(attacker) - attackerLiquidBaseline;
assert.equal(attackerPayout, FAIR_ATTACKER_PAYOUT);

const victimValue = u(ro('state', 'convert-to-assets', [Cl.uint(victimShares)], victim));
const victimRoundingLoss = VICTIM_DEPOSIT - victimValue;
console.log(`control attacker payout raw:        ${attackerPayout}`);
console.log(`control victim deposit raw:         ${VICTIM_DEPOSIT}`);
console.log(`control victim post-funding value:  ${victimValue}`);
console.log(`control victim rounding loss raw:   ${victimRoundingLoss}`);

assert.ok(victimValue >= 39_999_999n, 'victim retains essentially the full 0.40 sBTC value; at most one sat rounding');
assert.ok(victimRoundingLoss <= 1n, 'only integer rounding may remain in the control');
assert.equal(sbtc(reserve), VICTIM_DEPOSIT - FAIR_ATTACKER_PAYOUT, 'reserve retains the 0.04 sBTC that was stolen in the attack ordering');

console.log('PASS CONTROL: with identical realized loss and claim, reconciling NAV first reduces claimant payout to 0.36 sBTC and prevents the 0.04 sBTC transfer from the later depositor.');
