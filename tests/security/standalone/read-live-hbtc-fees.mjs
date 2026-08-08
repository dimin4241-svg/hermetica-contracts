import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API='https://api.hiro.so';
const HBTC='SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const USER='SP20V8SG811G6CT2QMZQNX6XCN20YAX36DYD1BAE0';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function req(url,options={}){
  for(let i=0;i<6;i++){
    const r=await fetch(url,{...options,headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{})}});
    const t=await r.text();
    if(r.ok)return t?JSON.parse(t):null;
    if(r.status===429&&i<5){const m=Number(t.match(/try again in\s+(\d+)/i)?.[1]??0);await sleep(Math.max(m,2**i,2)*1000);continue;}
    throw new Error(`${r.status}: ${t.slice(0,800)}`);
  }
  throw new Error('retry exhaustion');
}
function argHex(cv){return '0x'+Cl.serialize(cv);}
async function call(fn,args=[]){
  const j=await req(`${API}/v2/contracts/call-read/${HBTC}/state-hbtc-v1/${fn}`,{method:'POST',body:JSON.stringify({sender:USER,arguments:args.map(argHex)})});
  if(!j.okay)throw new Error(JSON.stringify(j));
  return cvToString(deserializeCV(j.result));
}
const globalExit=await call('get-exit-fee');
const allFees=await call('get-fees');
const standard=await call('get-custom-exit-fee',[Cl.principal(USER),Cl.bool(false)]);
const express=await call('get-custom-exit-fee',[Cl.principal(USER),Cl.bool(true)]);
console.log(`LIVE_HBTC_GLOBAL_EXIT_FEE=${globalExit}`);
console.log(`LIVE_HBTC_STANDARD_EXIT_FEE_FOR_SAMPLE_USER=${standard}`);
console.log(`LIVE_HBTC_EXPRESS_EXIT_FEE_FOR_SAMPLE_USER=${express}`);
console.log(`LIVE_HBTC_FEES=${allFees}`);
if(globalExit!=='u0') throw new Error(`global standard exit fee changed: ${globalExit}`);
if(standard!=='u0') throw new Error(`sample user's standard exit fee is nonzero/custom: ${standard}`);
console.log('PASS LIVE HBTC FEES: current standard exit fee is 0 bps for the global setting and sampled standard user; small stale-NAV loss-shift PoCs are not erased by protocol exit fees.');
