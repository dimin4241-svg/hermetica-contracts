import fs from 'node:fs';
import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API='https://api.hiro.so';
const D='SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG';
const C=`${D}.controller-v1-1`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function req(url,options={}){for(let i=0;i<8;i++){const r=await fetch(url,{...options,headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{})}});const t=await r.text();if(r.ok)return t?JSON.parse(t):null;if(r.status===429&&i<7){const m=Number(t.match(/try again in\s+(\d+)\s+seconds?/i)?.[1]??0);const w=Math.max(Number(r.headers.get('retry-after')??0),m,2**i,2);console.log(`HIRO_RATE_LIMIT retry=${i+1} wait=${w}s`);await sleep((w+1)*1000);continue;}throw new Error(`${r.status} ${url}: ${t.slice(0,800)}`)}}
function argHex(cv){return '0x'+Cl.serialize(cv)}
async function ro(fn,args=[]){const j=await req(`${API}/v2/contracts/call-read/${D}/controller-v1-1/${fn}`,{method:'POST',body:JSON.stringify({sender:D,arguments:args.map(argHex)})});return j.okay?{okay:true,repr:cvToString(deserializeCV(j.result)),hex:j.result}:{okay:false,raw:j}}
function principal(repr){return String(repr??'').match(/(?:SP|SM)[A-Z0-9]+(?:\.[A-Za-z0-9_-]+)?/)?.[0]??null}
function bool(repr){return String(repr??'').trim()==='true'?true:String(repr??'').trim()==='false'?false:null}
const txs=[];for(let offset=0;offset<4000;offset+=50){const p=await req(`${API}/extended/v1/address/${encodeURIComponent(C)}/transactions?limit=50&offset=${offset}`);const rows=p.results??[];txs.push(...rows);if(rows.length<50)break;await sleep(250)}
const map=new Map(),ops=[],logs=[];
for(const tx of [...txs].sort((a,b)=>(a.block_height-b.block_height)||((a.tx_index??0)-(b.tx_index??0)))){const cc=tx.contract_call;if(!cc||cc.contract_id!==C||tx.tx_status!=='success'||!String(tx.tx_result?.repr??'').startsWith('(ok'))continue;if(cc.function_name==='set-rewarder'){const a=(cc.function_args??[]).find(x=>x.name==='address')??cc.function_args?.[0];const v=(cc.function_args??[]).find(x=>x.name==='active')??cc.function_args?.[1];const p=principal(a?.repr),b=bool(v?.repr);if(p&&b!==null){map.set(p,b);ops.push({tx_id:tx.tx_id,block_height:tx.block_height,block_time_iso:tx.block_time_iso,sender:tx.sender_address,address:p,active:b});}}if(cc.function_name==='log-reward'){logs.push({tx_id:tx.tx_id,block_height:tx.block_height,block_time_iso:tx.block_time_iso,sender:tx.sender_address,args:(cc.function_args??[]).map(a=>({name:a.name,repr:a.repr})),result:tx.tx_result?.repr??null});}}
const active=[];for(const [p,v] of map){if(!v)continue;active.push({principal:p,is_contract:p.includes('.'),live:await ro('get-rewarder',[Cl.principal(p)])});}
const evidence={observed_at:new Date().toISOString(),controller:C,active_rewarders:active,rewarder_ops:ops,recent_successful_log_reward:logs.slice(-30).reverse(),unique_log_reward_senders:[...new Set(logs.map(x=>x.sender))]};
fs.mkdirSync('tests/security/evidence',{recursive:true});fs.writeFileSync('tests/security/evidence/live-usdh-rewarders.json',JSON.stringify(evidence,null,2));console.log('LIVE_USDH_REWARDERS='+JSON.stringify(evidence));console.log(`ACTIVE_REWARDER_COUNT=${active.length}`);console.log(`ACTIVE_CONTRACT_REWARDER_COUNT=${active.filter(x=>x.is_contract).length}`);
