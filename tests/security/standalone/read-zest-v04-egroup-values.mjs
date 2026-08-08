import assert from 'node:assert/strict';
import { Cl, deserializeCV, cvToString } from '@stacks/transactions';
import { mkdirSync, writeFileSync } from 'node:fs';

const API='https://api.hiro.so';
const ZEST='SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7';
const OUT='tests/security/evidence/zest-v04-egroup-values.txt';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function req(url,options={}) {
  for(let i=0;i<6;i++) {
    const r=await fetch(url,{...options,headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{})}});
    const t=await r.text();
    if(r.ok) return t?JSON.parse(t):null;
    if(r.status===429&&i<5){await sleep(Math.max(2,2**i)*1000);continue;}
    throw new Error(`${r.status} ${url}: ${t.slice(0,800)}`);
  }
  throw new Error('retry exhaustion');
}

const marketResp=await req(`${API}/v2/contracts/source/${ZEST}/v0-4-market`);
const source=marketResp.source??marketResp.source_code??'';
function constant(name){
  const m=source.match(new RegExp(`\\(define-constant\\s+${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s+u(\\d+)\\)`));
  if(!m) throw new Error(`constant ${name} not found in deployed market source`);
  return BigInt(m[1]);
}

const IDs={
  sBTC:constant('sBTC'),
  zsBTC:constant('zsBTC'),
  USDH:constant('USDH'),
  zUSDH:constant('zUSDH'),
  debtOffset:constant('DEBT-OFFSET'),
};

const collBit=id=>1n<<id;
const debtBit=id=>1n<<(IDs.debtOffset+id);
const candidates={
  'sBTC+USDH':collBit(IDs.sBTC)|debtBit(IDs.USDH),
  'zsBTC+USDH':collBit(IDs.zsBTC)|debtBit(IDs.USDH),
  'sBTC+zUSDH':collBit(IDs.sBTC)|debtBit(IDs.zUSDH),
  'zsBTC+zUSDH':collBit(IDs.zsBTC)|debtBit(IDs.zUSDH),
};

function argHex(cv){return '0x'+Cl.serialize(cv);}
async function resolve(mask){
  const j=await req(`${API}/v2/contracts/call-read/${ZEST}/v0-egroup/resolve`,{
    method:'POST', body:JSON.stringify({sender:ZEST,arguments:[argHex(Cl.uint(mask))]})
  });
  if(!j.okay) return {okay:false,raw:j};
  return {okay:true,repr:cvToString(deserializeCV(j.result)),hex:j.result};
}
function fieldBuffToUint(repr,field){
  const escaped=field.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const m=repr.match(new RegExp(`\\(${escaped}\\s+0x([0-9a-fA-F]+)\\)`));
  if(!m) return null;
  return BigInt('0x'+m[1]);
}

const rows=[];
for(const [name,mask] of Object.entries(candidates)){
  const result=await resolve(mask);
  const row={name,mask:mask.toString(),result};
  if(result.okay){
    row.penaltyMin=fieldBuffToUint(result.repr,'LIQ-PENALTY-MIN')?.toString()??null;
    row.penaltyMax=fieldBuffToUint(result.repr,'LIQ-PENALTY-MAX')?.toString()??null;
    row.ltvPartial=fieldBuffToUint(result.repr,'LTV-LIQ-PARTIAL')?.toString()??null;
    row.ltvFull=fieldBuffToUint(result.repr,'LTV-LIQ-FULL')?.toString()??null;
  }
  rows.push(row);
  console.log(`EGROUP_${name}=${JSON.stringify(row)}`);
  await sleep(200);
}

const successful=rows.filter(x=>x.result.okay);
assert(successful.length>0,'no hBTC-relevant egroup mask resolved');
mkdirSync('tests/security/evidence',{recursive:true});
writeFileSync(OUT,JSON.stringify({observed_at:new Date().toISOString(),IDs:Object.fromEntries(Object.entries(IDs).map(([k,v])=>[k,v.toString()])),rows},null,2)+'\n');
console.log(`ZEST_EGROUP_VALUES_FILE=${OUT}`);
console.log('PASS ZEST EGROUP VALUES: deployed liquidation penalty ranges resolved for hBTC-relevant asset masks.');
