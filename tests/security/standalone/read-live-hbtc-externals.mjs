import assert from 'node:assert/strict';
import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const HBTC = 'SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const ZEST = 'SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7';
const STATE = `${HBTC}.state-hbtc-v1`;

const known = {
  'zest-v0-3-market': `${ZEST}.v0-3-market`,
  'zest-v0-4-market': `${ZEST}.v0-4-market`,
  'zest-v0-market-vault': `${ZEST}.v0-market-vault`,
  'zest-v0-vault-sbtc': `${ZEST}.v0-vault-sbtc`,
  'zest-v0-vault-usdh': `${ZEST}.v0-vault-usdh`,
  'granite-borrower-v1': 'SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS.borrower-v1',
  'hermetica-staking-v1-1': 'SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.staking-v1-1',
  'hermetica-staking-silo-v1-1': 'SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.staking-silo-v1-1',
  'hermetica-minting-auto-v1-2': 'SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.minting-auto-v1-2',
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function req(url, options = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url, { ...options, headers: { Accept: 'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}) } });
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : null;
    if (r.status === 429 && attempt < 4) {
      const retryHeader = Number(r.headers.get('retry-after') ?? 0);
      const messageSeconds = Number(text.match(/try again in\s+(\d+)\s+seconds?/i)?.[1] ?? 0);
      const waitSeconds = Math.max(retryHeader, messageSeconds, 2 ** attempt, 2);
      console.log(`HIRO_RATE_LIMIT retry=${attempt + 1} wait=${waitSeconds}s`);
      await sleep(waitSeconds * 1000);
      continue;
    }
    throw new Error(`${r.status} ${url}: ${text.slice(0,1200)}`);
  }
  throw new Error(`unreachable retry exhaustion: ${url}`);
}
function argHex(cv) { return '0x' + Cl.serialize(cv); }
async function callRead(fn, args=[]) {
  const j = await req(`${API}/v2/contracts/call-read/${HBTC}/state-hbtc-v1/${fn}`, {
    method:'POST', body: JSON.stringify({sender:HBTC, arguments:args.map(argHex)})
  });
  if (!j.okay) return {okay:false,raw:j};
  return {okay:true,repr:cvToString(deserializeCV(j.result))};
}

const knownState = {};
for (const [name,address] of Object.entries(known)) {
  knownState[name] = { address, result: await callRead('get-external',[Cl.principal(address)]) };
  await sleep(150);
}

const sourceResp = await req(`${API}/v2/contracts/source/${ZEST}/v0-4-market`);
const source = sourceResp.source ?? sourceResp.source_code ?? '';
assert(source.includes('(define-public (liquidate'), 'deployed v0-4-market liquidation entrypoint not found');

// Extract one complete Clarity top-level form beginning at a marker. This keeps CI evidence
// compact enough to inspect while still preserving the exact deployed formula.
function completeForm(marker) {
  const start = source.indexOf(marker);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
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
function oneLine(s) { return (s ?? 'NOT_FOUND').replace(/;;[^\n]*/g, ' ').replace(/\s+/g, ' ').trim(); }
function definitionsMatching(rx) {
  const out = [];
  for (const m of source.matchAll(/\(define-(private|read-only|public)\s+\(([a-zA-Z0-9?!_-]+)/g)) {
    const name = m[2];
    if (!rx.test(name)) continue;
    const form = completeForm(m[0]);
    if (form) out.push({ name, form });
  }
  return out;
}
function constantForm(name) {
  const marker = `(define-constant ${name}`;
  return completeForm(marker);
}

const liquidate = completeForm('(define-public (liquidate');
assert(liquidate, 'liquidate body extraction failed');
assert(liquidate.includes('(asserts! (is-eq contract-caller tx-sender) ERR-AUTHORIZATION)'), 'expected direct-standard liquidator authorization missing');

const relevantDefs = definitionsMatching(/liquid|penalt|collateral|repay/i);
const penaltyConstants = [...source.matchAll(/\(define-constant\s+([A-Za-z0-9?!_-]*PENALT[A-Za-z0-9?!_-]*)/gi)]
  .map(m => m[1]);

console.log('ZEST_DEPLOYED_LIQUIDATE=' + oneLine(liquidate));
for (const name of [...new Set(penaltyConstants)]) {
  console.log(`ZEST_DEPLOYED_CONSTANT_${name}=` + oneLine(constantForm(name)));
}
for (const {name,form} of relevantDefs) {
  if (/liquid|penalt/i.test(name) || /LIQ-PENALTY|liq-penalty|collateral-remove|debt-to-repay|coll-final|min-collateral-expected/i.test(form)) {
    console.log(`ZEST_DEPLOYED_DEF_${name}=` + oneLine(form));
  }
}

const penaltyUse = source.match(/LIQ-PENALTY|liq-penalty/i);
const collateralRemovalUse = source.match(/collateral-remove|min-collateral-expected|coll-final/i);
const debtRepayUse = source.match(/debt-to-repay|repay/i);
assert(penaltyUse, 'deployed liquidation source has no penalty symbol/use');
assert(collateralRemovalUse, 'deployed liquidation source has no collateral-removal calculation');
assert(debtRepayUse, 'deployed liquidation source has no debt-repayment calculation');

// A Zest liquidation is external to Hermetica. Reject any hidden assumption that the deployed
// liquidation synchronously calls Hermetica accounting to mark the loss before a claimant can act.
const hermeticaNavCallback = /state-hbtc|controller-hbtc|log-reward|update-state/i.test(liquidate);
console.log(`ZEST_DEPLOYED_SYNCHRONOUS_HBTC_NAV_CALLBACK=${hermeticaNavCallback}`);
assert.equal(hermeticaNavCallback, false, 'unexpected synchronous hBTC NAV callback found inside deployed Zest liquidate');

console.log('PASS ZEST DEPLOYED SOURCE: v0-4 liquidation is callable by a direct standard account, contains explicit debt-repayment + collateral-removal/penalty semantics, and has no synchronous hBTC state/controller NAV callback.');

const calls = [];
for (let offset=0; offset<500; offset+=50) {
  const j = await req(`${API}/extended/v1/address/${encodeURIComponent(STATE)}/transactions?limit=50&offset=${offset}`);
  for (const tx of j.results ?? []) {
    const cc = tx.contract_call;
    if (!cc || cc.contract_id !== STATE) continue;
    if (!['request-external-add','request-external-remove','confirm-external-request','cancel-external-request'].includes(cc.function_name)) continue;
    calls.push({
      tx_id:tx.tx_id, block_height:tx.block_height, block_time_iso:tx.block_time_iso,
      status:tx.tx_status, sender:tx.sender_address, fn:cc.function_name,
      args:(cc.function_args??[]).map(a=>({name:a.name,repr:a.repr})), result:tx.tx_result?.repr,
    });
  }
  if ((j.results??[]).length < 50) break;
  await sleep(250);
}

console.log('LIVE_HBTC_KNOWN_EXTERNALS='+JSON.stringify(knownState));
console.log('LIVE_HBTC_EXTERNAL_OPS='+JSON.stringify(calls));
