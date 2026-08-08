import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

const API = 'https://api.hiro.so';
const ZEST = 'SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7';
const EVIDENCE_PATH = 'tests/security/evidence/zest-v04-liquidation-source.txt';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function req(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await r.text();
    if (r.ok) return JSON.parse(text);
    if (r.status === 429 && attempt < 5) {
      const retryHeader = Number(r.headers.get('retry-after') ?? 0);
      const messageSeconds = Number(text.match(/try again in\s+(\d+)\s+seconds?/i)?.[1] ?? 0);
      const waitSeconds = Math.max(retryHeader, messageSeconds, 2 ** attempt, 2);
      console.log(`HIRO_RATE_LIMIT retry=${attempt + 1} wait=${waitSeconds}s`);
      await sleep(waitSeconds * 1000);
      continue;
    }
    throw new Error(`${r.status} ${url}: ${text.slice(0,1200)}`);
  }
  throw new Error('Hiro retry exhaustion');
}

const sourceEndpoint = `${API}/v2/contracts/source/${ZEST}/v0-4-market`;
const sourceResp = await req(sourceEndpoint);
const source = sourceResp.source ?? sourceResp.source_code ?? '';
assert(source.includes('(define-public (liquidate'), 'deployed v0-4-market liquidate not found');

function completeForm(marker) {
  const start = source.indexOf(marker);
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}
function clean(s) { return (s ?? 'NOT_FOUND').replace(/;;[^\n]*/g, ' ').replace(/\s+/g, ' ').trim(); }

const liquidate = completeForm('(define-public (liquidate');
assert(liquidate, 'could not parse deployed liquidate');
assert(liquidate.includes('(asserts! (is-eq contract-caller tx-sender) ERR-AUTHORIZATION)'), 'direct standard-account liquidation auth changed');

const forms = [];
for (const m of source.matchAll(/\(define-(private|read-only|public)\s+\(([a-zA-Z0-9?!_-]+)/g)) {
  const name = m[2];
  if (!/liquid|penalt|collateral|repay/i.test(name)) continue;
  const form = completeForm(m[0]);
  if (form && (/liquid|penalt/i.test(name) || /LIQ-PENALTY|liq-penalty|collateral-remove|debt-to-repay|coll-final|min-collateral-expected/i.test(form))) {
    forms.push({name, form});
  }
}
const penaltyConstants = [...source.matchAll(/\(define-constant\s+([A-Za-z0-9?!_-]*PENALT[A-Za-z0-9?!_-]*)/gi)].map(m => m[1]);
const constants = [...new Set(penaltyConstants)].map(name => ({ name, form: completeForm(`(define-constant ${name}`) }));

assert(/LIQ-PENALTY|liq-penalty/i.test(source), 'no deployed liquidation penalty reference');
assert(/collateral-remove|min-collateral-expected|coll-final/i.test(liquidate + forms.map(x=>x.form).join('\n')), 'no deployed collateral seizure/removal math');
assert(/debt-to-repay|repay/i.test(liquidate + forms.map(x=>x.form).join('\n')), 'no deployed debt repayment math');

const synchronousHbtcCallback = /state-hbtc|controller-hbtc|log-reward|update-state/i.test(liquidate);
assert.equal(synchronousHbtcCallback, false, 'deployed liquidation unexpectedly synchronizes Hermetica NAV');

const evidence = [
  `source_endpoint=${sourceEndpoint}`,
  `synchronous_hbtc_nav_callback=${synchronousHbtcCallback}`,
  '',
  '=== DEPLOYED LIQUIDATE ===',
  clean(liquidate),
  '',
  '=== DEPLOYED PENALTY CONSTANTS ===',
  ...constants.map(x => `${x.name}: ${clean(x.form)}`),
  '',
  '=== DEPLOYED LIQUIDATION / COLLATERAL / REPAY HELPERS ===',
  ...forms.map(x => `${x.name}: ${clean(x.form)}`),
].join('\n');

mkdirSync('tests/security/evidence', { recursive: true });
writeFileSync(EVIDENCE_PATH, evidence + '\n');
console.log(`ZEST_EVIDENCE_FILE=${EVIDENCE_PATH}`);
console.log(`ZEST_PENALTY_CONSTANTS=${JSON.stringify(constants.map(x=>x.name))}`);
console.log(`ZEST_RELEVANT_DEFS=${JSON.stringify(forms.map(x=>x.name))}`);
console.log(`ZEST_DEPLOYED_SYNCHRONOUS_HBTC_NAV_CALLBACK=${synchronousHbtcCallback}`);
console.log('PASS ZEST SOURCE: deployed v0-4 liquidation is direct-standard-account callable, contains penalty + debt-repay + collateral-removal semantics, and has no synchronous Hermetica NAV callback.');
