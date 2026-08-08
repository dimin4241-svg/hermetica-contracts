import { mkdirSync, writeFileSync } from 'node:fs';

const API='https://api.hiro.so';
const HBTC='SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const TRADING=`${HBTC}.trading-hbtc-v1`;
const TARGET=8179328;
const OUT='tests/security/evidence/hbtc-historical-zest-opens.json';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function req(url){
  for(let i=0;i<7;i++){
    const r=await fetch(url,{headers:{Accept:'application/json'}});
    const t=await r.text();
    if(r.ok)return JSON.parse(t);
    if(r.status===429&&i<6){
      const msg=Number(t.match(/try again in\s+(\d+)/i)?.[1]??0);
      const wait=Math.max(msg,2**i,2);
      console.log(`RATE_LIMIT wait=${wait}s offset request`);
      await sleep(wait*1000);continue;
    }
    throw new Error(`${r.status} ${url}: ${t.slice(0,800)}`);
  }
  throw new Error('retry exhaustion');
}

const found=[];
let scanned=0;
for(let offset=0;offset<3000;offset+=50){
  const j=await req(`${API}/extended/v1/address/${encodeURIComponent(TRADING)}/transactions?limit=50&offset=${offset}`);
  const rows=j.results??[];
  if(!rows.length)break;
  scanned+=rows.length;
  let minHeight=Infinity;
  let maxHeight=0;
  for(const tx of rows){
    const h=tx.block_height??0; minHeight=Math.min(minHeight,h); maxHeight=Math.max(maxHeight,h);
    const cc=tx.contract_call;
    if(!cc||cc.contract_id!==TRADING)continue;
    if(!['zest-open','zest-add-open','zest-deposit-add-open'].includes(cc.function_name))continue;
    found.push({
      tx_id:tx.tx_id,
      block_height:h,
      block_time_iso:tx.block_time_iso,
      status:tx.tx_status,
      sender:tx.sender_address,
      function_name:cc.function_name,
      args:(cc.function_args??[]).map(a=>({name:a.name,repr:a.repr})),
      result:tx.tx_result?.repr,
      distance_from_target:Math.abs(h-TARGET),
    });
  }
  console.log(`PAGE offset=${offset} heights=${minHeight}..${maxHeight} zestOpens=${found.length}`);
  if(minHeight<=TARGET-200000)break;
  if(rows.length<50)break;
  await sleep(250);
}

found.sort((a,b)=>a.distance_from_target-b.distance_from_target);
mkdirSync('tests/security/evidence',{recursive:true});
writeFileSync(OUT,JSON.stringify({observed_at:new Date().toISOString(),target_last_borrow_block:TARGET,scanned,found},null,2)+'\n');
console.log('HISTORICAL_ZEST_OPENS='+JSON.stringify(found.slice(0,20)));
console.log(`HISTORICAL_ZEST_OPENS_FILE=${OUT}`);
if(!found.length)throw new Error('no historical hBTC Zest open transaction found');
console.log('PASS HISTORICAL ZEST OPENS: recovered top-level hBTC Zest open/borrow transactions and exact arguments.');
