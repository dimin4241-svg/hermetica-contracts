import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

const N = 5_114_718_180n; // live net-assets snapshot
const S = 5_021_844_277n; // live hBTC total supply snapshot
const B = 100_000_000n;
const MAX_DEV = 7n;        // live max-deviation (bps)
const BAD_R = 20_042n;
const GOOD_R = 20_043n;

const simnet = await initSimnet('./security/residual-poc/Clarinet.toml', true);
const accounts = simnet.getAccounts();
const deployer = accounts.get('deployer');
if (!deployer) throw new Error('missing deployer account');

const call = (fn, args = []) => simnet.callPublicFn('state', fn, args, deployer);
const show = tx => cvToString(tx.result);

function expectEq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
  console.log(`${label}=${actual}`);
}

function setMaxDeviation(value) {
  expectEq(show(call('request-max-deviation-update', [Cl.uint(value)])), '(ok true)', `request-max-deviation-${value}`);
  expectEq(show(call('confirm-max-deviation-request')), '(ok true)', `confirm-max-deviation-${value}`);
}

const op = (amount, isAdd) => Cl.tuple({
  type: Cl.stringAscii('total-assets'),
  amount: Cl.uint(amount),
  'is-add': Cl.bool(isAdd),
});
const shareOp = (amount, isAdd) => Cl.some(Cl.tuple({
  amount: Cl.uint(amount),
  'is-add': Cl.bool(isAdd),
  user: Cl.principal(deployer),
}));

// Bootstrap the exact live N/S ratio. Temporarily widening max-deviation is only
// a fixture-construction step; the vulnerable transition below runs at the
// production value of 7 bps.
setMaxDeviation(10_000n);
expectEq(
  show(call('update-state', [Cl.list([op(N, true)]), Cl.none(), shareOp(S, true)])),
  '(ok true)',
  'seed-live-ratio'
);
setMaxDeviation(MAX_DEV);

const P = N * B / S;
expectEq(P.toString(), '101849398', 'initial-share-price');

function transitionForResidual(r) {
  const claimShares = S - r;
  // This exactly mirrors vault-v1-2::process-claim:
  // assets = floor(shares * share-price / 1e8).
  const assets = claimShares * P / B;
  const n2 = N - assets;
  const p2 = n2 * B / r;
  const deviation = (p2 >= P ? p2 - P : P - p2) * 10_000n / P;
  const tx = call('update-state', [
    Cl.list([op(assets, false)]),
    Cl.none(),
    shareOp(claimShares, false),
  ]);
  return { r, claimShares, assets, n2, p2, deviation, result: show(tx) };
}

const bad = transitionForResidual(BAD_R);
console.log('BAD='+JSON.stringify(Object.fromEntries(Object.entries(bad).map(([k,v])=>[k, typeof v === 'bigint' ? v.toString() : v]))));
expectEq(bad.deviation.toString(), '8', 'bad-deviation-bps');
expectEq(bad.result, '(err u102014)', 'bad-funding-transition');

// The failed State transaction is atomic and therefore leaves the initial N/S
// state untouched. One extra residual share is enough to make the same funding
// transition pass at the exact 7 bps threshold.
const good = transitionForResidual(GOOD_R);
console.log('GOOD='+JSON.stringify(Object.fromEntries(Object.entries(good).map(([k,v])=>[k, typeof v === 'bigint' ? v.toString() : v]))));
expectEq(good.deviation.toString(), '7', 'good-deviation-bps');
expectEq(good.result, '(ok true)', 'good-funding-transition');

console.log('POC_PASS: production State rejects near-empty funding with 20,042 non-zero residual shares but accepts 20,043.');
