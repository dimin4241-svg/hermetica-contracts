import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

const API = 'https://api.hiro.so';
const ZEST = 'SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7';
const OUT = 'tests/security/evidence/zest-v04-egroup-source.txt';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getSource(contract) {
  for (let i=0;i<6;i++) {
    const r = await fetch(`${API}/v2/contracts/source/${ZEST}/${contract}`, {headers:{Accept:'application/json'}});
    const t = await r.text();
    if (r.ok) {
      const j = JSON.parse(t);
      return j.source ?? j.source_code ?? '';
    }
    if (r.status === 429 && i<5) { await sleep(Math.max(2,2**i)*1000); continue; }
    throw new Error(`${r.status}: ${t.slice(0,800)}`);
  }
  throw new Error('retry exhaustion');
}

function completeForm(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) return null;
  let depth=0,inString=false,escaped=false;
  for (let i=start;i<source.length;i++) {
    const ch=source[i];
    if (inString) {
      if (escaped) escaped=false;
      else if (ch==='\\') escaped=true;
      else if (ch==='"') inString=false;
      continue;
    }
    if (ch==='"') { inString=true; continue; }
    if (ch==='(') depth++;
    else if (ch===')') { depth--; if (depth===0) return source.slice(start,i+1); }
  }
  return source.slice(start);
}
const clean=s=>(s??'NOT_FOUND').replace(/;;[^\n]*/g,' ').replace(/\s+/g,' ').trim();

const market = await getSource('v0-4-market');
const egroup = await getSource('v0-egroup');

const marketForms = [];
for (const marker of ['(define-private (get-egroup','(define-read-only (get-egroup','(define-private (get-assets']) {
  const f=completeForm(market,marker); if (f) marketForms.push(clean(f));
}

const egroupForms=[];
for (const m of egroup.matchAll(/\(define-(?:private|read-only|public)\s+\(([A-Za-z0-9?!_-]+)/g)) {
  const name=m[1];
  if (!/resolve|group|factor|penalt|ltv/i.test(name)) continue;
  const f=completeForm(egroup,m[0]);
  if (f) egroupForms.push(`${name}: ${clean(f)}`);
}
const dataDefs=[];
for (const m of egroup.matchAll(/\(define-(?:map|data-var|constant)\s+([A-Za-z0-9?!_-]+)/g)) {
  const name=m[1];
  if (!/group|factor|penalt|ltv|mask/i.test(name)) continue;
  const f=completeForm(egroup,m[0]);
  if (f) dataDefs.push(`${name}: ${clean(f)}`);
}

assert(marketForms.some(x=>/egroup/i.test(x)), 'market get-egroup form not found');
assert(egroupForms.some(x=>/resolve/i.test(x)), 'egroup resolve interface not found');

mkdirSync('tests/security/evidence',{recursive:true});
writeFileSync(OUT,[
  'source_market='+`${API}/v2/contracts/source/${ZEST}/v0-4-market`,
  'source_egroup='+`${API}/v2/contracts/source/${ZEST}/v0-egroup`,
  '', '=== MARKET E-GROUP RESOLUTION ===', ...marketForms,
  '', '=== E-GROUP LIQUIDATION INTERFACE ===', ...egroupForms,
  '', '=== E-GROUP DATA DEFINITIONS ===', ...dataDefs,
].join('\n')+'\n');
console.log(`ZEST_EGROUP_EVIDENCE_FILE=${OUT}`);
console.log('PASS ZEST EGROUP SOURCE: deployed market-to-egroup resolution and liquidation parameter interface extracted.');
