import assert from 'node:assert/strict';
import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

const MANIFEST = 'tests/security/stale-nav/Clarinet.toml';
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const BURN = 'SP000000000000000000002Q6VF78';
const BASE = 100_000_000n;
const BURN_SHARES = 1_000n;
const REWARD = 1n;

const text = r => cvToString(r.result);
const u = r => {
  const m = text(r).match(/(?:\(ok )?u(\d+)\)?/);
  if (!m) throw new Error(text(r));
  return BigInt(m[1]);
};

async function setup() {
  const simnet = await initSimnet(MANIFEST);
  const accounts = simnet.getAccounts();
  const deployer = accounts.get('deployer');
  const rewarder = accounts.get('wallet_1');
  const user = accounts.get('wallet_2');
  if (!deployer || !rewarder || !user) throw new Error('missing accounts');

  const c = n => `${deployer}.${n}`;
  const state = c('state');
  const vault = c('vault');
  const controller = c('controller-hbtc');
  const reserve = c('reserve');
  const pub = (n, fn, args, sender) => simnet.callPublicFn(c(n), fn, args, sender);
  const ro = (n, fn, args = [], sender = deployer) => simnet.callReadOnlyFn(c(n), fn, args, sender);
  const expect = (label, result, wanted) => {
    const got = text(result);
    console.log(`${label}: ${got}`);
    assert.equal(got, wanted, `${label}: expected ${wanted}, got ${got}`);
  };

  for (const address of [state, vault, controller, reserve]) {
    expect('request protocol role', pub('hq-hbtc', 'request-protocol-update', [Cl.principal(address), Cl.bool(true)], deployer), '(ok true)');
  }
  expect('request rewarder role', pub('hq-hbtc', 'request-rewarder-update', [Cl.principal(rewarder), Cl.bool(true)], deployer), '(ok true)');
  expect('request sBTC asset', pub('state', 'request-asset-add', [
    Cl.principal(SBTC), Cl.buffer(new Uint8Array(32)), Cl.uint(8), Cl.uint(500), Cl.bool(false),
  ], deployer), '(ok true)');

  simnet.mineEmptyBlocks(200);
  for (const address of [state, vault, controller, reserve]) {
    expect('confirm protocol role', pub('hq-hbtc', 'confirm-protocol-request', [Cl.principal(address)], deployer), '(ok true)');
  }
  expect('confirm rewarder role', pub('hq-hbtc', 'confirm-rewarder-request', [Cl.principal(rewarder)], deployer), '(ok true)');
  expect('confirm sBTC asset', pub('state', 'confirm-asset-request', [Cl.principal(SBTC)], deployer), '(ok true)');
  expect('deposit cap', pub('state', 'set-deposit-cap', [Cl.uint(BASE * 2n)], deployer), '(ok true)');

  // Physical backing: 1 BTC deposited by the user plus exactly 1 sat of yield.
  for (const [recipient, amount] of [[user, BASE], [reserve, REWARD]]) {
    const r = simnet.callPrivateFn(
      SBTC,
      'protocol-mint-many-iter',
      [Cl.tuple({ amount: Cl.uint(amount), recipient: Cl.principal(recipient) })],
      deployer,
    );
    assert.equal(text(r), '(ok true)');
  }

  expect('deposit 1 BTC', pub('vault', 'deposit', [Cl.uint(BASE), Cl.none()], user), '(ok u100000000)');

  // Advance one accounting window and account for the physically present 1 sat reward.
  simnet.mineEmptyBlocks(200);
  expect('log 1 sat reward', pub('controller-hbtc', 'log-reward', [Cl.uint(REWARD), Cl.bool(true)], rewarder), '(ok true)');
  expect('default max-deviation', ro('state', 'get-max-deviation'), 'u7');
  assert.equal(u(ro('state', 'get-share-price')), 100_000_001n);

  return { simnet, deployer, rewarder, user, pub, ro, expect, reserve };
}

async function installBurnDust(x) {
  x.expect(
    'send 1000 hBTC to permanent burn address',
    x.pub('token-hbtc', 'transfer', [Cl.uint(BURN_SHARES), Cl.principal(x.user), Cl.principal(BURN), Cl.none()], x.user),
    '(ok true)',
  );
  assert.equal(u(x.ro('token-hbtc', 'get-balance', [Cl.principal(BURN)])), BURN_SHARES);
}

console.log('\n=== CONTROL: M-04 remediation works when share supply can reach zero ===');
{
  const x = await setup();
  x.expect('request all shares', x.pub('vault', 'request-redeem', [Cl.uint(BASE), Cl.bool(false)], x.user), '(ok u1)');
  x.simnet.mineEmptyBlocks(500);

  // Burning every share makes post-share-supply == 0, so check-max-deviation deliberately
  // treats deviation as zero. This is the intended M-04 remediation path.
  x.expect('fund final claim with zero post-supply', x.pub('vault', 'fund-claim', [Cl.uint(1)], x.user), '(ok u100000001)');
  assert.equal(u(x.ro('token-hbtc', 'get-total-supply')), 0n);
  console.log('PASS M04 CONTROL: without permanent burn shares, the final claim succeeds because post-share-supply reaches zero and the M-04 deviation bypass activates.');
}

console.log('\n=== ONE-SHOT FAILURE: required 1000 burn shares make zero supply unreachable ===');
{
  const x = await setup();
  await installBurnDust(x);

  const redeemableShares = BASE - BURN_SHARES;
  x.expect('request every redeemable share', x.pub('vault', 'request-redeem', [Cl.uint(redeemableShares), Cl.bool(false)], x.user), '(ok u1)');
  x.simnet.mineEmptyBlocks(500);

  const prePrice = u(x.ro('state', 'get-share-price'));
  const netAssets = u(x.ro('state', 'get-net-assets'));
  const payout = redeemableShares * prePrice / BASE;
  const remainingAssets = netAssets - payout;
  const postPrice = remainingAssets * BASE / BURN_SHARES;
  const deviationBps = (postPrice > prePrice ? postPrice - prePrice : prePrice - postPrice) * 10_000n / prePrice;

  console.log(`pre share price:          ${prePrice}`);
  console.log(`redeemable shares:        ${redeemableShares}`);
  console.log(`rounded claim payout:     ${payout}`);
  console.log(`remaining net assets:     ${remainingAssets}`);
  console.log(`permanent shares left:    ${BURN_SHARES}`);
  console.log(`post share price:         ${postPrice}`);
  console.log(`calculated deviation bps: ${deviationBps}`);

  assert.equal(prePrice, 100_000_001n);
  assert.equal(payout, 99_999_000n);
  assert.equal(remainingAssets, 1_001n);
  assert.equal(postPrice, 100_100_000n);
  assert.equal(deviationBps, 9n);

  x.expect('fund all real-holder shares in one claim', x.pub('vault', 'fund-claim', [Cl.uint(1)], x.user), '(err u102014)');

  // Atomicity control: failed funding did not burn the user's escrowed shares or mutate accounting.
  assert.equal(u(x.ro('token-hbtc', 'get-total-supply')), BASE);
  assert.equal(u(x.ro('state', 'get-share-price')), prePrice);

  console.log('PASS M04 ONE-SHOT FAILURE: the required 1000 permanent shares turn a final one-shot redemption into ERR_DEVIATION at the default 7 bps threshold.');
}

console.log('\n=== TRIAGER COUNTER-CONTROL: splitting the final exit avoids permanent freeze ===');
{
  const x = await setup();
  await installBurnDust(x);

  // For this fixture, leave 250 real shares for the second claim. The first funding moves
  // share price by exactly 7 bps (allowed), and the second moves it by only 1 bp.
  // Therefore the one-shot revert above is NOT an irreducible permanent freeze.
  const secondClaimShares = 250n;
  const firstClaimShares = BASE - BURN_SHARES - secondClaimShares;

  x.expect('request first split claim', x.pub('vault', 'request-redeem', [Cl.uint(firstClaimShares), Cl.bool(false)], x.user), '(ok u1)');
  x.simnet.mineEmptyBlocks(500);
  x.expect('fund first split claim', x.pub('vault', 'fund-claim', [Cl.uint(1)], x.user), '(ok u99998750)');
  x.expect('redeem first split claim', x.pub('vault', 'redeem', [Cl.uint(1)], x.user), '(ok u99998750)');

  assert.equal(u(x.ro('token-hbtc', 'get-total-supply')), BURN_SHARES + secondClaimShares);
  assert.equal(u(x.ro('state', 'get-share-price')), 100_080_000n);

  x.expect('request second split claim', x.pub('vault', 'request-redeem', [Cl.uint(secondClaimShares), Cl.bool(false)], x.user), '(ok u2)');
  x.simnet.mineEmptyBlocks(500);
  x.expect('fund second split claim', x.pub('vault', 'fund-claim', [Cl.uint(2)], x.user), '(ok u250)');
  x.expect('redeem second split claim', x.pub('vault', 'redeem', [Cl.uint(2)], x.user), '(ok u250)');

  assert.equal(u(x.ro('token-hbtc', 'get-total-supply')), BURN_SHARES);
  assert.equal(u(x.ro('token-hbtc', 'get-balance', [Cl.principal(x.user)])), 0n);
  assert.equal(u(x.ro('state', 'get-share-price')), 100_100_000n);

  console.log('PASS TRIAGER COUNTER-CONTROL: all real user shares can still be redeemed by splitting the final exit into two claims. M-04 + burn dust is therefore a one-shot redemption DoS/accounting edge, not a permanent user-funds freeze. Do not submit it as High/Critical.');
}
