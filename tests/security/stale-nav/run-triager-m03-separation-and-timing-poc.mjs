import assert from 'node:assert/strict';
import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

const MANIFEST = 'tests/security/stale-nav/Clarinet.toml';
const BASE = 100_000_000n;
const ATTACKER_SHARES = 40_000_000n;
const VICTIM_SHARES = 60_000_000n;
const LOSS = 12_000n; // 1.2 bps of 1.00 sBTC; still below 5/7 bps production guards
const FAIR_ATTACKER_AFTER_LOSS = 39_995_200n;
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';

const text = r => cvToString(r.result);
const u = r => {
  const m = text(r).match(/(?:\(ok )?u(\d+)\)?/);
  if (!m) throw new Error(text(r));
  return BigInt(m[1]);
};

async function setup({ strategyCapital = BASE } = {}) {
  const simnet = await initSimnet(MANIFEST);
  const accounts = simnet.getAccounts();
  const deployer = accounts.get('deployer');
  const rewarder = accounts.get('wallet_1');
  const attacker = accounts.get('wallet_2');
  const victim = accounts.get('wallet_3');
  if (!deployer || !rewarder || !attacker || !victim) throw new Error('missing accounts');

  const c = n => `${deployer}.${n}`;
  const state = c('state');
  const vault = c('vault');
  const controller = c('controller-hbtc');
  const reserve = c('reserve');
  const helper = c('strategy-loss-helper');
  const pub = (n, fn, args, sender) => simnet.callPublicFn(c(n), fn, args, sender);
  const ro = (n, fn, args = [], sender = deployer) => simnet.callReadOnlyFn(c(n), fn, args, sender);
  const expect = (label, r, wanted) => {
    const got = text(r);
    console.log(`${label}: ${got}`);
    assert.equal(got, wanted, `${label}: expected ${wanted}, got ${got}`);
  };
  const sbtc = who => u(simnet.callReadOnlyFn(SBTC, 'get-balance-available', [Cl.principal(who)], deployer));
  const hbtc = who => u(ro('token-hbtc', 'get-balance', [Cl.principal(who)], who));
  const price = () => u(ro('state', 'get-share-price'));
  const assetsForShares = (shares, sender = deployer) => u(ro('state', 'convert-to-assets', [Cl.uint(shares)], sender));

  const requestRole = (fn, address) => expect(fn, pub('hq-hbtc', fn, [Cl.principal(address), Cl.bool(true)], deployer), '(ok true)');
  const confirmRole = (fn, address) => expect(fn, pub('hq-hbtc', fn, [Cl.principal(address)], deployer), '(ok true)');

  for (const address of [state, vault, controller, helper]) requestRole('request-protocol-update', address);
  requestRole('request-rewarder-update', rewarder);
  expect('request sBTC asset', pub('state', 'request-asset-add', [Cl.principal(SBTC), Cl.buffer(new Uint8Array(32)), Cl.uint(8), Cl.uint(500), Cl.bool(false)], deployer), '(ok true)');
  simnet.mineEmptyBlocks(200);
  for (const address of [state, vault, controller, helper]) confirmRole('confirm-protocol-request', address);
  confirmRole('confirm-rewarder-request', rewarder);
  expect('confirm sBTC asset', pub('state', 'confirm-asset-request', [Cl.principal(SBTC)], deployer), '(ok true)');
  expect('deposit cap', pub('state', 'set-deposit-cap', [Cl.uint(2n * BASE)], deployer), '(ok true)');
  expect('default max-reward', ro('state', 'get-max-reward'), 'u5');
  expect('default max-deviation', ro('state', 'get-max-deviation'), 'u7');

  for (const [who, amount] of [[attacker, ATTACKER_SHARES], [victim, VICTIM_SHARES]]) {
    const r = simnet.callPrivateFn(SBTC, 'protocol-mint-many-iter', [Cl.tuple({ amount: Cl.uint(amount), recipient: Cl.principal(who) })], deployer);
    assert.equal(text(r), '(ok true)');
  }

  expect('attacker deposit 0.40', pub('vault', 'deposit', [Cl.uint(ATTACKER_SHARES), Cl.none()], attacker), '(ok u40000000)');
  expect('victim deposit 0.60', pub('vault', 'deposit', [Cl.uint(VICTIM_SHARES), Cl.none()], victim), '(ok u60000000)');
  expect('deploy strategy capital', pub('strategy-loss-helper', 'pull-from-reserve', [Cl.uint(strategyCapital)], deployer), '(ok true)');

  return { simnet, deployer, rewarder, attacker, victim, pub, ro, expect, sbtc, hbtc, price, assetsForShares, reserve, helper };
}

console.log('\n=== TRIAGER CONTROL A: exact old M-03 request-time lock-in is fixed ===');
{
  const x = await setup({ strategyCapital: 50_000_000n });
  x.expect('fresh NAV log', x.pub('controller-hbtc', 'log-reward', [Cl.uint(0), Cl.bool(true)], x.rewarder), '(ok true)');
  x.expect('external 1.2bp loss becomes real BEFORE request', x.pub('strategy-loss-helper', 'realize-loss', [Cl.uint(LOSS), Cl.principal(x.deployer)], x.deployer), '(ok true)');
  assert.equal(x.price(), BASE, 'accounting price is stale when request is created');

  x.expect('request redeem while NAV is stale', x.pub('vault', 'request-redeem', [Cl.uint(ATTACKER_SHARES), Cl.bool(false)], x.attacker), '(ok u1)');
  const requestedText = text(x.ro('vault', 'get-claim', [Cl.uint(1)], x.attacker));
  console.log(`claim immediately after request: ${requestedText}`);
  assert.match(requestedText, /\(assets none\)/, 'current remediation must not lock an asset amount at request time');
  assert.match(requestedText, /\(share-price none\)/, 'current remediation must not lock share price at request time');

  x.simnet.mineEmptyBlocks(500);
  x.expect('reconcile the 1.2bp loss before funding', x.pub('controller-hbtc', 'log-reward', [Cl.uint(LOSS), Cl.bool(false)], x.rewarder), '(ok true)');
  assert.equal(x.price(), 99_988_000n);

  x.expect('fund old-M03-style claim at corrected price', x.pub('vault', 'fund-claim', [Cl.uint(1)], x.attacker), '(ok u39995200)');
  x.expect('redeem old-M03-style claim at corrected value', x.pub('vault', 'redeem', [Cl.uint(1)], x.attacker), '(ok u39995200)');
  console.log('PASS OLD-M03 NEGATIVE CONTROL: request-time staleness does not lock assets or price; once NAV is corrected before funding, current code pays exactly 39,995,200 sats.');
}

console.log('\n=== TRIAGER CONTROL B: mature standard claim is a cancellable pre-positioned option ===');
{
  const x = await setup({ strategyCapital: 50_000_000n });

  x.expect('arm standard claim #1', x.pub('vault', 'request-redeem', [Cl.uint(ATTACKER_SHARES), Cl.bool(false)], x.attacker), '(ok u1)');
  x.simnet.mineEmptyBlocks(500);
  assert.equal(x.hbtc(x.attacker), 0n, 'shares are escrowed while claim is armed');
  x.expect('cancel mature unfunded claim #1', x.pub('vault', 'cancel-redeem', [Cl.uint(1)], x.attacker), '(ok u40000000)');
  assert.equal(x.hbtc(x.attacker), ATTACKER_SHARES, 'all shares are returned after cancellation');

  x.expect('re-arm standard claim #2', x.pub('vault', 'request-redeem', [Cl.uint(ATTACKER_SHARES), Cl.bool(false)], x.attacker), '(ok u2)');
  x.simnet.mineEmptyBlocks(500);

  x.expect('fresh NAV log AFTER claim is already mature', x.pub('controller-hbtc', 'log-reward', [Cl.uint(0), Cl.bool(true)], x.rewarder), '(ok true)');
  const freshTs = u(x.ro('state', 'get-last-log-ts'));
  x.expect('PR137 timestamp guard says fresh', x.ro('pr137-shadow', 'is-sp-stale', [Cl.uint(freshTs)]), 'false');

  x.expect('new 1.2bp external loss occurs AFTER fresh log', x.pub('strategy-loss-helper', 'realize-loss', [Cl.uint(LOSS), Cl.principal(x.deployer)], x.deployer), '(ok true)');
  x.expect('PR137 still says fresh after adverse event', x.ro('pr137-shadow', 'is-sp-stale', [Cl.uint(freshTs)]), 'false');
  x.expect('immediate correction blocked only by update-window', x.pub('controller-hbtc', 'log-reward', [Cl.uint(LOSS), Cl.bool(false)], x.rewarder), '(err u102011)');
  assert.equal(x.price(), BASE);

  const attackerLiquidBefore = x.sbtc(x.attacker);
  x.expect('fund mature claim #2 at stale funding-time price', x.pub('vault', 'fund-claim', [Cl.uint(2)], x.attacker), '(ok u40000000)');
  x.expect('redeem mature claim #2', x.pub('vault', 'redeem', [Cl.uint(2)], x.attacker), '(ok u40000000)');
  const stalePayout = x.sbtc(x.attacker) - attackerLiquidBefore;
  assert.equal(stalePayout, ATTACKER_SHARES);

  x.simnet.mineEmptyBlocks(200);
  x.expect('later reconcile same 1.2bp loss', x.pub('controller-hbtc', 'log-reward', [Cl.uint(LOSS), Cl.bool(false)], x.rewarder), '(ok true)');

  const victimValue = x.assetsForShares(VICTIM_SHARES, x.victim);
  const attackerExcess = stalePayout - FAIR_ATTACKER_AFTER_LOSS;
  const victimFairLoss = 7_200n;
  const victimActualLoss = VICTIM_SHARES - victimValue;
  const victimIncrementalLoss = victimActualLoss - victimFairLoss;

  console.log(`attacker stale payout raw:       ${stalePayout}`);
  console.log(`attacker fair payout raw:        ${FAIR_ATTACKER_AFTER_LOSS}`);
  console.log(`attacker avoided loss raw:       ${attackerExcess}`);
  console.log(`victim fair loss raw:            ${victimFairLoss}`);
  console.log(`victim actual loss raw:          ${victimActualLoss}`);
  console.log(`victim incremental loss raw:     ${victimIncrementalLoss}`);

  assert.equal(attackerExcess, 4_800n);
  assert.equal(victimActualLoss, 12_000n);
  assert.equal(victimIncrementalLoss, 4_800n);
  assert.equal(attackerExcess, victimIncrementalLoss);

  console.log('PASS NEW-BUG POSITIVE CONTROL: old M-03 request-time locking is demonstrably fixed and the mature claim is cancellable/re-armable, yet a NEW post-log loss creates stale funding-time NAV. The claimant avoids exactly 4,800 sats of loss and the existing holder absorbs exactly the same 4,800 sats, with zero rounding discrepancy.');
}
