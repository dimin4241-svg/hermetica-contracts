const API = 'https://api.hiro.so';
const ADDRESS = 'SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7';
const CONTRACT = 'v0-3-market';

const r = await fetch(`${API}/v2/contracts/source/${ADDRESS}/${CONTRACT}`, {
  headers: { Accept: 'application/json' },
});
const text = await r.text();
if (!r.ok) throw new Error(`${r.status}: ${text.slice(0, 1000)}`);
const j = JSON.parse(text);
const source = j.source ?? j.source_code;
if (typeof source !== 'string') throw new Error(`source missing: ${text.slice(0, 1000)}`);

console.log(`ZEST_V03_SOURCE_LEN=${source.length}`);

const needles = [
  '(define-public (liquidate',
  '(define-public (liquidate-multi',
  '(define-public (liquidate-redeem',
  '(define-public (borrow',
  '(define-public (repay',
  '(define-public (collateral-add',
  '(define-public (collateral-remove',
  '(define-public (supply-collateral-add',
  '(define-public (collateral-remove-redeem',
];

for (const needle of needles) {
  let pos = 0;
  let hit = 0;
  while ((pos = source.indexOf(needle, pos)) !== -1) {
    const start = Math.max(0, pos - 700);
    const end = Math.min(source.length, pos + 6500);
    console.log(`\n=== ZEST_FRAGMENT ${needle} #${++hit} @${pos} ===\n${source.slice(start, end)}\n=== END_FRAGMENT ===`);
    pos += needle.length;
  }
  if (!hit) console.log(`NO_MATCH=${needle}`);
}
