import fs from 'node:fs';
import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API='https://api.hiro.so';
const D='SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG';
const LEGACY=`${D}.minting-state-v1`;
const AUTO=`${D}.minting-auto-state-v1`;
const ASSETS=[
  'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token',
  'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx',
  'SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc',
];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function req(url,options={}){
  for(let i=0;i<9;i++){
    const r=await fetch(url,{...options,headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{})}});
    const t=await r.text();
    if(r.ok)return t?JSON.parse(t):null;
    if(r.status===429&&i<8){const m=Number(t.match(/try again in\s+(\d+)\s+seconds?/i)?.[1]??0);const w=Math.max(Number(r.headers.get('retry-after')??0),m,2**i,2);console.log(`HIRO_RATE_LIMIT retry=${i+1} wait=${w}s`);await sleep((w+1)*1000);continue;}
    throw new Error(`${r.status} ${url}: ${t.slice(0,900)}`);
  }
  throw new Error(`retry exhaustion ${url}`);
}
function ah(cv){return '0x'+Cl.serialize(cv)}
async function ro(contract,fn,args=[]){const dot=contract.indexOf('.'),a=contract.slice(0,dot),n=contract.slice(dot+1);const j=await req(`${API}/v2/contracts/call-read/${a}/${n}/${fn}`,{method:'POST',body:JSON.stringify({sender:D,arguments:args.map(ah)})});return j.okay?{okay:true,repr:cvToString(deserializeCV(j.result)),hex:j.result}:{okay:false,raw:j};}
async function txs(address){const out=[];for(let offset=0;offset<5000;offset+=50){const p=await req(`${API}/extended/v1/address/${encodeURIComponent(address)}/transactions?limit=50&offset=${offset}`);const rows=p.results??[];out.push(...rows);if(rows.length<50)break;await sleep(300);}return out;}
function principals(s){return [...new Set(String(s??'').match(/(?:SP|SM)[A-Z0-9]+(?:\.[A-Za-z0-9_-]+)?/g)??[])];}
function good(tx){return tx.tx_status==='success'&&String(tx.tx_result?.repr??'').startsWith('(ok');}

const [legacyTxs,autoTxs]=await Promise.all([txs(LEGACY),txs(AUTO)]);
const discovered=new Set(),ops=[];
for(const tx of legacyTxs){const cc=tx.contract_call;if(!cc||cc.contract_id!==LEGACY||!good(tx)||!['add-whitelist','remove-whitelist'].includes(cc.function_name))continue;const ps=(cc.function_args??[]).flatMap(a=>principals(a.repr));for(const p of ps)discovered.add(p);ops.push({contract:LEGACY,tx_id:tx.tx_id,block_height:tx.block_height,block_time_iso:tx.block_time_iso,fn:cc.function_name,sender:tx.sender_address,principals:ps,args:(cc.function_args??[]).map(a=>({name:a.name,repr:a.repr}))});}
for(const tx of autoTxs){const cc=tx.contract_call;if(!cc||cc.contract_id!==AUTO||!good(tx)||cc.function_name!=='set-whitelist')continue;const ps=(cc.function_args??[]).flatMap(a=>principals(a.repr));for(const p of ps)discovered.add(p);ops.push({contract:AUTO,tx_id:tx.tx_id,block_height:tx.block_height,block_time_iso:tx.block_time_iso,fn:cc.function_name,sender:tx.sender_address,principals:ps,args:(cc.function_args??[]).map(a=>({name:a.name,repr:a.repr}))});}

const current=[];
for(const p of [...discovered].sort()){
  const legacy=await ro(LEGACY,'get-whitelist',[Cl.principal(p)]);
  const auto=[];
  for(const asset of ASSETS) auto.push({asset,state:await ro(AUTO,'get-whitelist',[Cl.principal(p),Cl.principal(asset)])});
  const legacyActive=/\(minter true\)|\(redeemer true\)/.test(legacy.repr??'');
  const autoActive=auto.some(x=>/\(minter true\)|\(redeemer true\)/.test(x.state.repr??''));
  if(legacyActive||autoActive) current.push({principal:p,is_contract:p.includes('.'),legacy,auto,legacy_active:legacyActive,auto_active:autoActive});
  await sleep(90);
}

const contractEntries=current.filter(x=>x.is_contract);
const sources=[];
for(const e of contractEntries){const p=e.principal,dot=p.indexOf('.'),a=p.slice(0,dot),n=p.slice(dot+1);try{const j=await req(`${API}/v2/contracts/source/${a}/${n}?proof=0`);const src=j?.source??'';const publics=[...src.matchAll(/\(define-public\s+\(([^\s()]+)/g)].map(m=>m[1]);sources.push({principal:p,publics,source_length:src.length,mentions_usdh_minting:src.includes('minting-auto')||src.includes('minting-v1'),mentions_contract_caller:src.includes('contract-caller'),mentions_tx_sender:src.includes('tx-sender'),source:src});}catch(err){sources.push({principal:p,error:String(err),source:''});}await sleep(160);}

const evidence={observed_at:new Date().toISOString(),legacy_state:LEGACY,auto_state:AUTO,discovered_count:discovered.size,current_active:current,current_contract_whitelists:contractEntries,contract_sources:sources.map(({source,...x})=>x),whitelist_ops:ops.sort((a,b)=>a.block_height-b.block_height)};
fs.mkdirSync('tests/security/evidence',{recursive:true});fs.writeFileSync('tests/security/evidence/live-usdh-contract-whitelists.json',JSON.stringify({...evidence,contract_sources:sources},null,2));
console.log('LIVE_USDH_CONTRACT_WHITELISTS='+JSON.stringify(evidence));
console.log(`ACTIVE_CONTRACT_WHITELIST_COUNT=${contractEntries.length}`);
