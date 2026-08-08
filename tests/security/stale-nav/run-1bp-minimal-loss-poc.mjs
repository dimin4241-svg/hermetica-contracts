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
const LOSS = 10_000n; // exactly 1 bp of a 1.00 sBTC vault
const EXPECTED_EXCESS = 4_000n; // attacker owns 40% of pre-loss supply
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const c = n => `${deployer}.${n}`;
const reserve = c('reserve');
const helper = c('strategy-loss-helper');

const text = r => cvToString(r.result);
const pub = (n, fn, args, sender) => simnet.callPublicFn(c(n), fn, args, sender);
const ro = (n, fn, args = [], sender = deployer) => simnet.callReadOnlyFn(c(n), fn, args, sender);
function expect(label, r, wanted) { const got = text(r); console.log(`${label}: ${got}`); assert.equal(got, wanted, `${label}: expected ${wanted}, got ${got}`); }
function u(r) { const m = text(r).match(/(?:\(ok )?u(\d+)\)?/); if (!m) throw new Error(text(r)); return BigInt(m[1]); }
function sbtc(who) { return u(simnet.callReadOnlyFn(SBTC, 'get-balance-available', [Cl.principal(who)], deployer)); }
function hbtc(who) { return u(ro('token-hbtc', 'get-balance', [Cl.principal(who)], who)); }
function price() { return u(ro('state', 'get-share-price')); }
function assetsForShares(shares, sender = deployer) { return u(ro('state', 'convert-to-assets', [Cl.uint(shares)], sender)); }

function requestRole(fn, address) { expect(fn, pub('hq-hbtc', fn, [Cl.principal(address), Cl.bool(true)], deployer), '(ok true)'); }
function confirmRole(fn, address) { expect(fn, pub('hq-hbtc', fn, [Cl.principal(address)], deployer), '(ok true)'); }

const state = c('state');
const vault = c('vault');
const controller = c('controller-hbtc');
for (const address of [state, vault, controller, helper]) requestRole('request-protocol-update', address);
requestRole('request-rewarder-update', rewarder);
expect('request sBTC asset', pub('state', 'request-asset-add', [Cl.principal(SBTC), Cl.buffer(new Uint8Array(32)), Cl.uint(8), Cl.uint(500), Cl.bool(false)], deployer), '(ok true)');

simnet.mineEmptyBlocks(200);
for (const address of [state, vault, controller, helper]) confirmRole('confirm-protocol-request', address);
confirmRole('confirm-rewarder-request', rewarder);
expect('confirm sBTC asset', pub('state', 'confirm-asset-request', [Cl.principal(SBTC)], deployer), '(ok true)');
expect('deposit cap', pub('state', 'set-deposit-cap', [Cl.uint(2n * BASE)], deployer), '(ok true)');

// No accounting guard is relaxed. 1 bp is safely below both unchanged limits.
expect('default max-reward', ro('state', 'get-max-reward'), 'u5');
expect('default max-deviation', ro('state', 'get-max-deviation'), 'u7');

for (const [who, amount] of [[attacker, ATTACKER_SHARES], [deployer, LEGACY], [victim, VICTIM_DEPOSIT]]) {
  const r = simnet.callPrivateFn(SBTC, 'protocol-mint-many-iter', [Cl.tuple({ amount: Cl.uint(amount), recipient: Cl.principal(who) })], deployer);
  assert.equal(text(r), '(ok true)');
}

console.log('=== establish 1.00 sBTC vault and mature 40% claim ===');
expect('attacker deposit', pub('vault', 'deposit', [Cl.uint(ATTACKER_SHARES), Cl.none()], attacker), '(ok u40000000)');
expect('legacy deposit', pub('vault', 'deposit', [Cl.uint(LEGACY), Cl.none()], deployer), '(ok u60000000)');
expect('mature claim request', pub('vault', 'request-redeem', [Cl.uint(ATTACKER_SHARES), Cl.bool(false)], attacker), '(ok u1)');
simnet.mineEmptyBlocks(500);

console.log('=== fresh NAV, then only 1bp realized loss ===');
expect('deploy all assets to strategy', pub('strategy-loss-helper', 'pull-from-reserve', [Cl.uint(BASE)], deployer), '(ok true)');
expect('fresh NAV log', pub('controller-hbtc', 'log-reward', [Cl.uint(0), Cl.bool(true)], rewarder), '(ok true)');
const freshLastLogTs = u(ro('state', 'get-last-log-ts'));
expect('PR137 guard fresh', ro('pr137-shadow', 'is-sp-stale', [Cl.uint(freshLastLogTs)]), 'false');
expect('realize 1bp loss', pub('strategy-loss-helper', 'realize-loss', [Cl.uint(LOSS), Cl.principal(deployer)], deployer), '(ok true)');
assert.equal(sbtc(helper), BASE - LOSS);
expect('PR137 guard after 1bp realized loss', ro('pr137-shadow', 'is-sp-stale', [Cl.uint(freshLastLogTs)]), 'false');

// 1bp is below max-reward=5 and max-deviation=7. The only blocker is the normal update window.
expect('immediate 1bp correction blocked only by update-window', pub('controller-hbtc', 'log-reward', [Cl.uint(LOSS), Cl.bool(false)], rewarder), '(err u102011)');
assert.equal(price(), BASE);

console.log('=== later depositor and mature claim execute during forced stale interval ===');
expect('victim stale deposit', pub('vault', 'deposit', [Cl.uint(VICTIM_DEPOSIT), Cl.none()], victim), '(ok u40000000)');
assert.equal(sbtc(reserve), VICTIM_DEPOSIT);
expect('fund mature claim at stale NAV', pub('vault', 'fund-claim', [Cl.uint(1)], attacker), '(ok u40000000)');
assert.equal(sbtc(reserve), 0n);
expect('attacker redeem stale claim', pub('vault', 'redeem', [Cl.uint(1)], attacker), '(ok u40000000)');

console.log('=== same 1bp loss becomes legal after the ordinary accounting window ===');
simnet.mineEmptyBlocks(200);
expect('delayed 1bp correction', pub('controller-hbtc', 'log-reward', [Cl.uint(LOSS), Cl.bool(false)], rewarder), '(ok true)');
assert.equal(price(), 99_990_000n);

const victimShares = hbtc(victim);
const victimValue = assetsForShares(victimShares, victim);
const attackerFairValue = ATTACKER_SHARES * (BASE - LOSS) / BASE;
const attackerExcess = ATTACKER_SHARES - attackerFairValue;
const victimLoss = VICTIM_DEPOSIT - victimValue;

console.log(`attacker stale payout raw:       ${ATTACKER_SHARES}`);
console.log(`attacker fair post-loss raw:     ${attackerFairValue}`);
console.log(`attacker excess exit raw:        ${attackerExcess}`);
console.log(`victim post-reconciliation raw:  ${victimValue}`);
console.log(`victim loss raw:                 ${victimLoss}`);

assert.equal(attackerFairValue, 39_996_000n);
assert.equal(attackerExcess, EXPECTED_EXCESS);
assert.equal(victimValue, 39_996_000n);
assert.equal(victimLoss, EXPECTED_EXCESS);
assert.equal(attackerExcess, victimLoss);

console.log('PASS 1BP MINIMAL LOSS: with max-reward=5bps and max-deviation=7bps unchanged, a realized loss of only 1bp is forced stale by update-window, letting a 40% matured claimant avoid exactly 4,000 sats of loss and shifting exactly 4,000 sats to the later depositor. PR #137 timestamp guard remains false.');
