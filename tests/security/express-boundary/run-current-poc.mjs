import assert from 'node:assert/strict';
import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

// Reuse the exact-current minimal hBTC harness: all contract files are unchanged
// production sources from mainnet/contracts/.
const simnet = await initSimnet('tests/security/pause-force-fund/Clarinet.toml');
const accounts = simnet.getAccounts();
const deployer = accounts.get('deployer');
const user1 = accounts.get('wallet_2');
const user2 = accounts.get('wallet_3');
if (!deployer || !user1 || !user2) throw new Error('missing accounts');

const BASE = 100_000_000n;
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
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
function mintSbtc(amount, recipient) {
  const r = simnet.callPrivateFn(
    SBTC,
    'protocol-mint-many-iter',
    [Cl.tuple({ amount: Cl.uint(amount), recipient: Cl.principal(recipient) })],
    deployer,
  );
  expectResult(`fund ${recipient}`, r, '(ok true)');
}
function requestExpress(shares, sender, expectedId) {
  expectResult(
    `express request ${shares}`,
    pub('vault', 'request-redeem', [Cl.uint(shares), Cl.bool(true)], sender),
    `(ok u${expectedId})`,
  );
}

console.log('=== setup exact-current hBTC State/Vault ===');
for (const address of [c('state'), c('vault')]) {
  expectResult(`request protocol ${address}`, pub('hq-hbtc', 'request-protocol-update', [Cl.principal(address), Cl.bool(true)], deployer), '(ok true)');
}
simnet.mineEmptyBlocks(200);
for (const address of [c('state'), c('vault')]) {
  expectResult(`confirm protocol ${address}`, pub('hq-hbtc', 'confirm-protocol-request', [Cl.principal(address)], deployer), '(ok true)');
}
expectResult('set deposit cap', pub('state', 'set-deposit-cap', [Cl.uint(1000n * BASE)], deployer), '(ok true)');
expectResult('enable express', pub('state', 'set-express-enabled', [Cl.bool(true)], deployer), '(ok true)');
expectResult('enable express limiter', pub('state', 'set-express-limit-enabled', [Cl.bool(true)], deployer), '(ok true)');

mintSbtc(100n * BASE, user1);
mintSbtc(100n * BASE, user2);
expectResult('user1 deposit', pub('vault', 'deposit', [Cl.uint(100n * BASE), Cl.none()], user1), `(ok u${100n * BASE})`);
expectResult('user2 deposit', pub('vault', 'deposit', [Cl.uint(100n * BASE), Cl.none()], user2), `(ok u${100n * BASE})`);

const supply = uintFrom(ro('token-hbtc', 'get-total-supply'));
assert.equal(supply, 200n * BASE);
const quota = supply * 250n / 10_000n; // 5 hBTC = 2.5%
assert.equal(quota, 5n * BASE);
console.log(`SUPPLY=${supply} QUOTA=${quota}`);

// Claim #1 anchors the fixed window with the minimum request.
const anchor = 100n;
requestExpress(anchor, user1, 1);
assert.equal(uintFrom(ro('state', 'get-current-express-limit')), quota - anchor);
const anchorReset = uintFrom(ro('state', 'get-last-express-ts')) + 86_400n;
console.log(`RESET_TS=${anchorReset}`);

// In this simnet an empty block advances ~600s. 143 blocks stay just inside
// the 24h boundary; the request transaction itself then consumes the remainder.
simnet.mineEmptyBlocks(143);
const oldBurst = quota - anchor;
requestExpress(oldBurst, user1, 2);
assert.equal(uintFrom(ro('state', 'get-current-express-limit')), 0n);
console.log('OLD_WINDOW_EXHAUSTED');

// Cross the reset boundary. A fresh 2.5% quota becomes available even though
// the previous 2.5% was consumed only moments earlier.
simnet.mineEmptyBlocks(2);
const newBurst = quota;
requestExpress(newBurst, user2, 3);

const burst = oldBurst + newBurst;
console.log(`BURST_SHARES=${burst} BPS_OF_SUPPLY=${(burst * 10_000n) / supply}`);
assert(burst * 10_000n > supply * 499n); // >4.99% in the boundary burst

console.log('POC_PASS: fixed-window reset permits nearly 5% of share supply in express requests around a single 24h boundary, despite a nominal 2.5% per-window safety limit.');
