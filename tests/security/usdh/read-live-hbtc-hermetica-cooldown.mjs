import fs from 'node:fs';
import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API='https://api.hiro.so';
const D='SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG';
const STATE=`${D}.staking-state-v1`;
const HBTC_INTERFACE='SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D.hermetica-interface-hbtc-v1';
const HBTC_TRADING='SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D.trading-hbtc-v1';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function req(url,options={}){for(let i=0;i<8;i++){const r=await fetch(url,{...options,headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{})}});const t=await r.text();if(r.ok)return t?JSON.parse(t):null;if(r.status===429&&i<7){const m=Number(t.match(/try again in\s+(\d+)\s+seconds?/i)?.[1]??0);const w=Math.max(Number(r.headers.get('retry-after')??0),m,2**i,2);console.log(`HIRO_RATE_LIMIT retry=${i+1} wait=${w}s`);await sleep((w+1)*1000);continue;}throw new Error(`${r.status} ${url}: ${t.slice(0,900)}`)}}
function ah(cv){return '0x'+Cl.serialize(cv)}
async function ro(fn,args=[]){const j=await req(`${API}/v2/contracts/call-read/${D}/staking-state-v1/${fn}`,{method:'POST',body:JSON.stringify({sender:D,arguments:args.map(ah)})});return j.okay?{okay:true,repr:cvToString(deserializeCV(j.result)),hex:j.result}:{okay:false,raw:j}}
const txs=[];for(let offset=0;offset<4000;offset+=50){const p=await req(`${API}/extended/v1/address/${encodeURIComponent(STATE)}/transactions?limit=50&offset=${offset}`);const rows=p.results??[];txs.push(...rows);if(rows.length<50)break;await sleep(250)}
const customOps=[];for(const tx of txs){const cc=tx.contract_call;if(!cc||cc.contract_id!==STATE||cc.function_name!=='set-custom-cooldown')continue;customOps.push({tx_id:tx.tx_id,block_height:tx.block_height,block_time_iso:tx.block_time_iso,status:tx.tx_status,sender:tx.sender_address,result:tx.tx_result?.repr??null,args:(cc.function_args??[]).map(a=>({name:a.name,repr:a.repr}))});}
const evidence={observed_at:new Date().toISOString(),state:STATE,default_cooldown:await ro('get-cooldown-window'),hbtc_interface:{principal:HBTC_INTERFACE,cooldown:await ro('get-custom-cooldown',[Cl.principal(HBTC_INTERFACE)])},hbtc_trading:{principal:HBTC_TRADING,cooldown:await ro('get-custom-cooldown',[Cl.principal(HBTC_TRADING)])},custom_cooldown_ops:customOps.sort((a,b)=>a.block_height-b.block_height)};
fs.mkdirSync('tests/security/evidence',{recursive:true});fs.writeFileSync('tests/security/evidence/live-hbtc-hermetica-cooldown.json',JSON.stringify(evidence,null,2));console.log('LIVE_HBTC_HERMETICA_COOLDOWN='+JSON.stringify(evidence));
