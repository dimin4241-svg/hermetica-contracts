import assert from 'node:assert/strict';
import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

const manifest = 'tests/security/stale-nav/Clarinet.toml';
const simnet = await initSimnet(manifest);
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
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const c = (name) => `${deployer}.${name}`;
const vault = c('vault');
const state = c('state');
const reserve = c('reserve');
const controller = c('controller-hbtc');
const helper = c('strategy-loss-helper');

function text(r) { return cvToString(r.result); }
function pub(name, fn, args, sender) { return simnet.callPublicFn(c(name), fn, args, sender); }
function ro(name, fn, args = [], sender = deployer) { return simnet.callReadOnlyFn(c(name), fn, args, sender); }
function expectCv(label, r, expected) {
  const actual = text(r);
  console.log(`${label}: ${actual}`);
  assert.equal(actual, expected, `${label}: expected ${expected}, got ${actual}`);
}
function uintFrom(r) {
  const s = text(r);
  const m = s.match(/(?:\(ok )?u(\d+)\)?/);
  if (!m) throw new Error(`not uint: ${s}`);
  return BigInt(m[1]);
}
function sbtcBalance(who) {
  const r = simnet.callReadOnlyFn(SBTC, 'get-balance-available', [Cl.principal(who)], deployer);
  const v = uintFrom(r);
  console.log(`sBTC.available(${who}) = ${v}`);
  return v;
}
function hbtcBalance(who) {
  const r = ro('token-hbtc', 'get-balance', [Cl.principal(who)]);
  const v = uintFrom(r);
  console.log(`hBTC(${who}) = ${v}`);
  return v;
}
function sharePrice() { return uintFrom(ro('state', 'get-share-price')); }
function totalAssets() { return uintFrom(ro('state', 'get-total-assets')); }
function supply() { return uintFrom(ro('token-hbtc', 'get-total-supply')); }

function requestRole(fn, address) {
  expectCv(`hq.${fn}(${address})`, pub('hq-hbtc', fn, [Cl.principal(address), Cl.bool(true)], deployer), '(ok true)');
}
function confirmRole(fn, address) {
  expectCv(`hq.${fn}(${address})`, pub('hq-hbtc', fn, [Cl.principal(address)], deployer), '(ok true)');
}

console.log('=== governance/setup using production hBTC contracts ===');
for (const address of [state, vault, controller, helper]) requestRole('request-protocol-update', address);
requestRole('request-rewarder-update', rewarder);

expectCv('state.request-asset-add(sBTC)', pub('state', 'request-asset-add', [
  Cl.principal(SBTC), Cl.buffer(new Uint8Array(32)), Cl.uint(8), Cl.uint(500), Cl.bool(false),
], deployer), '(ok true)');

// Relax only magnitude guards so a 10% realized loss can eventually be logged
// in one transaction. The daily update-window guard under test remains intact.
expectCv('state.request-max-reward-update(1000)', pub('state', 'request-max-reward-update', [Cl.uint(1000)], deployer), '(ok true)');
expectCv('state.request-max-deviation-update(2000)', pub('state', 'request-max-deviation-update', [Cl.uint(2000)], deployer), '(ok true)');

simnet.mineEmptyBlocks(200);
for (const address of [state, vault, controller, helper]) confirmRole('confirm-protocol-request', address);
confirmRole('confirm-rewarder-request', rewarder);
expectCv('state.confirm-asset-request(sBTC)', pub('state', 'confirm-asset-request', [Cl.principal(SBTC)], deployer), '(ok true)');
expectCv('state.confirm-max-reward-request', pub('state', 'confirm-max-reward-request', [], deployer), '(ok true)');
expectCv('state.confirm-max-deviation-request', pub('state', 'confirm-max-deviation-request', [], deployer), '(ok true)');
expectCv('state.set-deposit-cap(2 BTC)', pub('state', 'set-deposit-cap', [Cl.uint(2n * BASE)], deployer), '(ok true)');

// Local test funding only. The imported real sBTC contract already contains
// Simnet fixture balances; we assert later on deltas rather than absolutes.
for (const [who, amount] of [[attacker, ATTACKER_DEPOSIT], [deployer, LEGACY_DEPOSIT], [victim, VICTIM_DEPOSIT]]) {
  const r = simnet.callPrivateFn(SBTC, 'protocol-mint-many-iter', [Cl.tuple({ amount: Cl.uint(amount), recipient: Cl.principal(who) })], deployer);
  console.log(`test-fund sBTC ${who}: ${text(r)}`);
  assert.match(text(r), /^\(ok true\)$/);
}

console.log('=== establish 1.00 sBTC vault and a cancellable matured claim ===');
expectCv('attacker deposit 0.40', pub('vault', 'deposit', [Cl.uint(ATTACKER_DEPOSIT), Cl.none()], attacker), '(ok u40000000)');
expectCv('legacy deposit 0.60', pub('vault', 'deposit', [Cl.uint(LEGACY_DEPOSIT), Cl.none()], deployer), '(ok u60000000)');
assert.equal(totalAssets(), BASE);
assert.equal(supply(), BASE);
assert.equal(sharePrice(), BASE);
assert.equal(sbtcBalance(reserve), BASE);
const attackerLiquidBaseline = sbtcBalance(attacker);

expectCv('attacker request standard redeem 0.40', pub('vault', 'request-redeem', [Cl.uint(ATTACKER_DEPOSIT), Cl.bool(false)], attacker), '(ok u1)');
assert.equal(hbtcBalance(attacker), 0n);
simnet.mineEmptyBlocks(500);

console.log('=== deploy capital to external strategy, then mark NAV ===');
expectCv('strategy pulls 1.00 sBTC from reserve', pub('strategy-loss-helper', 'pull-from-reserve', [Cl.uint(BASE)], deployer), '(ok true)');
assert.equal(sbtcBalance(reserve), 0n);
assert.equal(sbtcBalance(helper), BASE);
expectCv('fresh NAV log', pub('controller-hbtc', 'log-reward', [Cl.uint(0), Cl.bool(true)], rewarder), '(ok true)');
assert.equal(sharePrice(), BASE);

console.log('=== realized external loss while hBTC accounting remains stale ===');
expectCv('external strategy realizes 0.10 sBTC loss', pub('strategy-loss-helper', 'realize-loss', [Cl.uint(LOSS), Cl.principal(deployer)], deployer), '(ok true)');
assert.equal(sbtcBalance(helper), 90_000_000n);
expectCv('immediate negative NAV update is blocked', pub('controller-hbtc', 'log-reward', [Cl.uint(LOSS), Cl.bool(false)], rewarder), '(err u102011)');
assert.equal(totalAssets(), BASE);
assert.equal(sharePrice(), BASE);

console.log('=== normal third-party deposit supplies fresh reserve liquidity at stale NAV ===');
expectCv('victim deposits 0.40 after loss', pub('vault', 'deposit', [Cl.uint(VICTIM_DEPOSIT), Cl.none()], victim), '(ok u40000000)');
assert.equal(sbtcBalance(reserve), VICTIM_DEPOSIT);
assert.equal(hbtcBalance(victim), VICTIM_DEPOSIT);
assert.equal(totalAssets(), 140_000_000n);
assert.equal(supply(), 140_000_000n);
assert.equal(sharePrice(), BASE);

console.log('=== matured claimant captures the new deposit at stale pre-loss NAV ===');
expectCv('permissionless fund matured claim', pub('vault', 'fund-claim', [Cl.uint(1)], attacker), '(ok u40000000)');
assert.equal(sbtcBalance(reserve), 0n, 'new depositor liquidity has been moved into old claimant escrow');
expectCv('attacker redeems funded claim', pub('vault', 'redeem', [Cl.uint(1)], attacker), '(ok u40000000)');
const attackerAfterExit = sbtcBalance(attacker);
assert.equal(attackerAfterExit - attackerLiquidBaseline, ATTACKER_DEPOSIT, 'claimant receives the full stale 0.40 sBTC payout');
assert.equal(totalAssets(), BASE);
assert.equal(supply(), BASE);
assert.equal(sharePrice(), BASE);

console.log('=== when loss accounting finally becomes legal, remaining holders absorb it ===');
simnet.mineEmptyBlocks(200);
expectCv('delayed negative NAV update', pub('controller-hbtc', 'log-reward', [Cl.uint(LOSS), Cl.bool(false)], rewarder), '(ok true)');
assert.equal(totalAssets(), 90_000_000n);
assert.equal(supply(), BASE);
assert.equal(sharePrice(), 90_000_000n);

const victimShares = hbtcBalance(victim);
const victimValue = uintFrom(ro('state', 'convert-to-assets', [Cl.uint(victimShares)], victim));
const fairAttackerClaimAfterLoss = ATTACKER_DEPOSIT * (BASE - LOSS) / BASE;
const attackerExcess = ATTACKER_DEPOSIT - fairAttackerClaimAfterLoss;
const victimLoss = VICTIM_DEPOSIT - victimValue;

console.log('=== economic delta ===');
console.log(`attacker stale payout raw:       ${ATTACKER_DEPOSIT}`);
console.log(`attacker fair post-loss raw:     ${fairAttackerClaimAfterLoss}`);
console.log(`attacker excess exit raw:        ${attackerExcess}`);
console.log(`victim deposit raw:              ${VICTIM_DEPOSIT}`);
console.log(`victim post-correction value:    ${victimValue}`);
console.log(`victim loss raw:                 ${victimLoss}`);

assert.equal(fairAttackerClaimAfterLoss, 36_000_000n);
assert.equal(attackerExcess, 4_000_000n);
assert.equal(victimValue, 36_000_000n);
assert.equal(victimLoss, 4_000_000n);
assert.equal(attackerExcess, victimLoss);

console.log('PASS: a realized external loss + time-gated NAV update lets a matured claimant capture 0.04 sBTC of a later depositor value at stale NAV.');
