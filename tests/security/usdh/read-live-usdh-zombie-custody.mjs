import fs from 'node:fs';

const API='https://api.hiro.so';
const contracts=[
'SP6XGBDAD800GGY6XF48AC27467W9PEHA6EPBGKJ.test-hermetica-interface-hbtc-v1-2',
'SP6XGBDAD800GGY6XF48AC27467W9PEHA6EPBGKJ.test-hermetica-interface-hbtc-v1',
'SP3EQA24WCW9XQRP2BPMME17JDX6PXRZPSGKAAR2J.flmintv2',
'SP6XGBDAD800GGY6XF48AC27467W9PEHA6EPBGKJ.test-hermetica-interface-hbtc-v3',
'SPEP08Q2GWNA8MTCT6QHYMRSV30BD9YMXP99WZNC.liquidator',
'SP6XGBDAD800GGY6XF48AC27467W9PEHA6EPBGKJ.test-hermetica-interface-hbtc-v6',
'SP6XGBDAD800GGY6XF48AC27467W9PEHA6EPBGKJ.test-hermetica-interface-hbtc-v4',
'SP6XGBDAD800GGY6XF48AC27467W9PEHA6EPBGKJ.test-hermetica-interface-hbtc4-v1',
'SP6XGBDAD800GGY6XF48AC27467W9PEHA6EPBGKJ.test-hermetica-interface-hbtc2-v1',
'SP2JQQF57F8P57VDK007VZMP72EX56XTVW8SKJ458.liquidator',
'SP1EH0FBF8NQTGEBJKF9RJT0AZ5XTNPKJAP0WZJ23.liquidator',
'SP1G51VRBTGKD1PV25X57562RPFW3BCYQNAVBFY0R.liquidator',
'SP6XGBDAD800GGY6XF48AC27467W9PEHA6EPBGKJ.test-hermetica-interface-hbtc3-v1',
'SP6XGBDAD800GGY6XF48AC27467W9PEHA6EPBGKJ.test-hermetica-interface-hbtc-v5-1',
'SP6XGBDAD800GGY6XF48AC27467W9PEHA6EPBGKJ.test-hermetica-interface-hbtc-v7',
'SP5GFPE85JZATVQJ9ZN755A6JTCVXXBSBWTEBNVG.liquidator'
];
const tracked=['sbtc-token::sbtc-token','usdh-token-v1::usdh','token-aeusdc::aeUSDC','susdh-token-v1::susdh'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function req(url){for(let i=0;i<8;i++){const r=await fetch(url,{headers:{Accept:'application/json'}});const t=await r.text();if(r.ok)return t?JSON.parse(t):null;if(r.status===429&&i<7){const m=Number(t.match(/try again in\s+(\d+)\s+seconds?/i)?.[1]??0);const w=Math.max(Number(r.headers.get('retry-after')??0),m,2**i,2);console.log(`HIRO_RATE_LIMIT retry=${i+1} wait=${w}s`);await sleep((w+1)*1000);continue;}throw new Error(`${r.status} ${url}: ${t.slice(0,800)}`)}}
const rows=[];
for(const principal of contracts){
  const balances=await req(`${API}/extended/v1/address/${encodeURIComponent(principal)}/balances`);
  const ft=balances?.fungible_tokens??{};
  const nonzero=Object.entries(ft).filter(([,v])=>BigInt(v.balance??0)>0n).map(([asset,v])=>({asset,balance:v.balance,total_sent:v.total_sent,total_received:v.total_received}));
  const relevant=nonzero.filter(x=>tracked.some(t=>x.asset.includes(t)));
  let sourceMeta={};
  if(relevant.length){const dot=principal.indexOf('.'),a=principal.slice(0,dot),n=principal.slice(dot+1);try{const src=await req(`${API}/v2/contracts/source/${a}/${n}?proof=0`);const text=src?.source??'';sourceMeta={publics:[...text.matchAll(/\(define-public\s+\(([^\s()]+)/g)].map(m=>m[1]),source_length:text.length,mentions_withdraw:/withdraw|sweep|transfer/i.test(text),source:text};}catch(e){sourceMeta={error:String(e)}}}
  rows.push({principal,relevant,all_nonzero_ft:nonzero,stx:balances?.stx??null,...sourceMeta});
  await sleep(250);
}
const candidates=rows.filter(x=>x.relevant.length);
const evidence={observed_at:new Date().toISOString(),checked:rows.length,candidate_count:candidates.length,candidates,all:rows};
fs.mkdirSync('tests/security/evidence',{recursive:true});fs.writeFileSync('tests/security/evidence/live-usdh-zombie-custody.json',JSON.stringify(evidence,null,2));
console.log('LIVE_USDH_ZOMBIE_CUSTODY='+JSON.stringify({...evidence,candidates:candidates.map(({source,...x})=>x),all:rows.map(({source,...x})=>x)}));
console.log(`ZOMBIE_CUSTODY_CANDIDATE_COUNT=${candidates.length}`);
