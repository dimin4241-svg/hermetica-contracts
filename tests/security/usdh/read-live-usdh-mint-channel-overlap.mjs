import fs from 'node:fs';
import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API='https://api.hiro.so';
const D='SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG';
const MINT=`${D}.minting-v1`;
const AUTO=`${D}.minting-auto-v1-2`;
const STATE=`${D}.minting-state-v1`;
const AUTO_STATE=`${D}.minting-auto-state-v1`;
const ASSETS=[
  'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token',
  'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx',
  'SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc'
];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function req(url,options={}){for(let i=0;i<8;i++){const r=await fetch(url,{...options,headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{})}});const t=await r.text();if(r.ok)return t?JSON.parse(t):null;if(r.status===429&&i<7){const m=Number(t.match(/try again in\s+(\d+)\s+seconds?/i)?.[1]??0);const w=Math.max(Number(r.headers.get('retry-after')??0),m,2**i,2);console.log(`HIRO_RATE_LIMIT retry=${i+1} wait=${w}s`);await sleep(w*1000);continue;}throw new Error(`${r.status} ${url}: ${t.slice(0,800)}`)}}
function argHex(cv){return '0x'+Cl.serialize(cv)}
async function ro(contract,fn,args=[]){const dot=contract.indexOf('.');const a=contract.slice(0,dot),n=contract.slice(dot+1);const j=await req(`${API}/v2/contracts/call-read/${a}/${n}/${fn}`,{method:'POST',body:JSON.stringify({sender:D,arguments:args.map(argHex)})});return j.okay?{okay:true,repr:cvToString(deserializeCV(j.result)),hex:j.result}:{okay:false,raw:j}}
async function addressTxs(contract){const out=[];for(let offset=0;offset<5000;offset+=50){const p=await req(`${API}/extended/v1/address/${encodeURIComponent(contract)}/transactions?limit=50&offset=${offset}`);const rows=p.results??[];out.push(...rows);if(rows.length<50)break;await sleep(220)}return out}
function good(tx){return tx.tx_status==='success'&&String(tx.tx_result?.repr??'').startsWith('(ok')}
function call(tx,contract){const c=tx.contract_call;return c&&c.contract_id===contract?c:null}
function principals(text){return [...new Set(String(text??'').match(/(?:SP|SM)[A-Z0-9]+(?:\.[A-Za-z0-9_-]+)?/g)??[])]}

const [mintTxs,autoTxs,stateTxs,autoStateTxs]=await Promise.all([addressTxs(MINT),addressTxs(AUTO),addressTxs(STATE),addressTxs(AUTO_STATE)]);
const mintUsers=new Set(), autoUsers=new Set(), discovered=new Set();
const mintCalls=[],autoCalls=[];
for(const tx of mintTxs){const c=call(tx,MINT);if(!c)continue;if(['request-mint','request-redeem'].includes(c.function_name)&&good(tx)){mintUsers.add(tx.sender_address);discovered.add(tx.sender_address);mintCalls.push({tx_id:tx.tx_id,block_height:tx.block_height,block_time_iso:tx.block_time_iso,sender:tx.sender_address,fn:c.function_name,status:tx.tx_status,result:tx.tx_result?.repr??null})}}
for(const tx of autoTxs){const c=call(tx,AUTO);if(!c)continue;if(['mint','redeem'].includes(c.function_name)&&good(tx)){autoUsers.add(tx.sender_address);discovered.add(tx.sender_address);autoCalls.push({tx_id:tx.tx_id,block_height:tx.block_height,block_time_iso:tx.block_time_iso,sender:tx.sender_address,fn:c.function_name,status:tx.tx_status,result:tx.tx_result?.repr??null})}}
for(const tx of stateTxs){const c=call(tx,STATE);if(!c||!['add-whitelist','remove-whitelist'].includes(c.function_name))continue;for(const a of c.function_args??[])for(const p of principals(a.repr))discovered.add(p)}
for(const tx of autoStateTxs){const c=call(tx,AUTO_STATE);if(!c||c.function_name!=='set-whitelist')continue;for(const a of c.function_args??[])for(const p of principals(a.repr))discovered.add(p)}

const candidates=[...discovered].filter(p=>!p.includes('.')).sort();
const overlap=[];
for(const p of candidates){const legacy=await ro(STATE,'get-whitelist',[Cl.principal(p)]);const auto=[];for(const asset of ASSETS)auto.push({asset,state:await ro(AUTO_STATE,'get-whitelist',[Cl.principal(p),Cl.principal(asset)])});const legacyMint=/\(minter true\)/.test(legacy.repr??'');const autoMint=auto.some(x=>/\(minter true\)/.test(x.state.repr??''));if(legacyMint||autoMint)overlap.push({principal:p,legacy,auto,legacy_minter:legacyMint,auto_minter:autoMint,both:legacyMint&&autoMint});await sleep(80)}

const limits={
 legacy:{mint_limit:await ro(MINT,'get-mint-limit'),current:await ro(MINT,'get-current-mint-limit'),window:await ro(MINT,'get-mint-limit-reset-window'),last_reset:await ro(MINT,'get-last-mint-limit-reset')},
 auto:{mint_limit:await ro(AUTO,'get-mint-limit'),current:await ro(AUTO,'get-current-mint-limit'),window:await ro(AUTO,'get-mint-limit-reset-window'),last_reset:await ro(AUTO,'get-last-mint-limit-reset')},
 whitelist_enabled:await ro(STATE,'get-whitelist-enabled'),
 mint_enabled:await ro(STATE,'get-mint-enabled')
};
const both=overlap.filter(x=>x.both);
const evidence={observed_at:new Date().toISOString(),contracts:{mint:MINT,auto:AUTO,state:STATE,auto_state:AUTO_STATE},limits,historical_successful_calls:{minting_v1:mintCalls.slice(-50).reverse(),minting_auto_v1_2:autoCalls.slice(-50).reverse()},historical_unique_users:{minting_v1:[...mintUsers],minting_auto_v1_2:[...autoUsers],intersection:[...mintUsers].filter(x=>autoUsers.has(x))},current_whitelist_candidates:overlap,current_both_minter:both};
fs.mkdirSync('tests/security/evidence',{recursive:true});fs.writeFileSync('tests/security/evidence/live-usdh-mint-channel-overlap.json',JSON.stringify(evidence,null,2));
console.log('LIVE_USDH_MINT_CHANNEL_OVERLAP='+JSON.stringify(evidence));console.log(`CURRENT_BOTH_MINTER_COUNT=${both.length}`);console.log(`HISTORICAL_CALLER_INTERSECTION_COUNT=${evidence.historical_unique_users.intersection.length}`);
