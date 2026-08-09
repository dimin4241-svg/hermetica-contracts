import fs from 'node:fs';
import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API='https://api.hiro.so';
const D='SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG';
const HQ=`${D}.hq-v1`;
const MINT=`${D}.minting-v1`;
const OTC=`${D}.minting-otc-v1-1`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function req(url,options={}){
  for(let i=0;i<9;i++){
    const r=await fetch(url,{...options,headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{})}});
    const t=await r.text();
    if(r.ok)return t?JSON.parse(t):null;
    if(r.status===429&&i<8){
      const m=Number(t.match(/try again in\s+(\d+)\s+seconds?/i)?.[1]??0);
      const w=Math.max(Number(r.headers.get('retry-after')??0),m,2**i,2);
      console.log(`HIRO_RATE_LIMIT retry=${i+1} wait=${w}s`);await sleep((w+1)*1000);continue;
    }
    throw new Error(`${r.status} ${url}: ${t.slice(0,900)}`);
  }
  throw new Error(`retry exhaustion ${url}`);
}
function argHex(cv){return '0x'+Cl.serialize(cv)}
async function ro(contract,fn,args=[]){
  const dot=contract.indexOf('.'),a=contract.slice(0,dot),n=contract.slice(dot+1);
  const j=await req(`${API}/v2/contracts/call-read/${a}/${n}/${fn}`,{method:'POST',body:JSON.stringify({sender:D,arguments:args.map(argHex)})});
  return j.okay?{okay:true,repr:cvToString(deserializeCV(j.result)),hex:j.result}:{okay:false,raw:j};
}
async function addressTxs(address){
  const out=[];
  for(let offset=0;offset<7500;offset+=50){
    const p=await req(`${API}/extended/v1/address/${encodeURIComponent(address)}/transactions?limit=50&offset=${offset}`);
    const rows=p.results??[];out.push(...rows);
    if(rows.length<50)break;
    await sleep(350);
  }
  return out;
}
function successful(tx){return tx.tx_status==='success'&&String(tx.tx_result?.repr??'').startsWith('(ok')}
function arg(cc,name,index=0){return (cc.function_args??[]).find(x=>x.name===name)??(cc.function_args??[])[index]}
function principal(repr){return String(repr??'').match(/(?:SP|SM)[A-Z0-9]+(?:\.[A-Za-z0-9_-]+)?/)?.[0]??null}
function bool(repr){const s=String(repr??'').trim();return s==='true'?true:s==='false'?false:null}

const [hqTxs,mintTxs,otcTxs]=await Promise.all([addressTxs(HQ),addressTxs(MINT),addressTxs(OTC)]);

const proto=new Map(), minting=new Map(), discovered=new Set();
const authorityOps=[];
for(const tx of [...hqTxs].sort((a,b)=>(a.block_height-b.block_height)||((a.tx_index??0)-(b.tx_index??0)))){
  const cc=tx.contract_call;if(!cc||cc.contract_id!==HQ||!successful(tx))continue;
  const fn=cc.function_name;
  if(fn==='set-contract-active'){
    const p=principal(arg(cc,'address',0)?.repr),v=bool(arg(cc,'active',1)?.repr);
    if(p&&v!==null){proto.set(p,v);discovered.add(p);authorityOps.push({kind:'protocol',tx_id:tx.tx_id,block_height:tx.block_height,block_time_iso:tx.block_time_iso,fn,address:p,active:v,sender:tx.sender_address});}
  }
  if(['request-minting-contract-update','activate-minting-contract','remove-minting-contract'].includes(fn)){
    const p=principal(arg(cc,'address',0)?.repr);if(!p)continue;discovered.add(p);
    if(fn==='activate-minting-contract')minting.set(p,true);
    if(fn==='remove-minting-contract')minting.set(p,false);
    authorityOps.push({kind:'minting',tx_id:tx.tx_id,block_height:tx.block_height,block_time_iso:tx.block_time_iso,fn,address:p,active:fn==='activate-minting-contract'?true:fn==='remove-minting-contract'?false:null,sender:tx.sender_address});
  }
}

async function replayTraders(contract,txs){
  const map=new Map(),ops=[];
  for(const tx of [...txs].sort((a,b)=>(a.block_height-b.block_height)||((a.tx_index??0)-(b.tx_index??0)))){
    const cc=tx.contract_call;if(!cc||cc.contract_id!==contract||!successful(tx)||cc.function_name!=='set-trader')continue;
    const p=principal(arg(cc,'address',0)?.repr),m=bool(arg(cc,'mint',1)?.repr),r=bool(arg(cc,'redeem',2)?.repr);
    if(!p||m===null||r===null)continue;
    map.set(p,{minter:m,redeemer:r});
    ops.push({tx_id:tx.tx_id,block_height:tx.block_height,block_time_iso:tx.block_time_iso,address:p,minter:m,redeemer:r,sender:tx.sender_address});
  }
  const live=[];
  for(const [p,v] of map){if(!v.minter&&!v.redeemer)continue;const read=await ro(contract,'get-trader',[Cl.principal(p)]);live.push({principal:p,replayed:v,live:read,is_contract:p.includes('.')});await sleep(100);}
  return {ops,active:live};
}
const legacyTraders=await replayTraders(MINT,mintTxs);
const otcTraders=await replayTraders(OTC,otcTxs);

const activeProto=[...proto].filter(([,v])=>v).map(([p])=>p);
const candidates=[...new Set([...discovered,...activeProto])].sort();
const verified=[];
for(const p of candidates){
  const protocol=await ro(HQ,'get-contract-active',[Cl.principal(p)]);
  const mintRole=await ro(HQ,'get-minting-contract',[Cl.principal(p)]);
  const activeProtocol=protocol.repr==='true';
  const activeMint=/\(active true\)/.test(mintRole.repr??'');
  if(activeProtocol||activeMint)verified.push({principal:p,is_contract:p.includes('.'),protocol,minting:mintRole,active_protocol:activeProtocol,active_minting:activeMint});
  await sleep(100);
}

// Best-effort source metadata for any active contract-principal authority/trader.
const contractPrincipals=[...new Set([
  ...verified.filter(x=>x.is_contract).map(x=>x.principal),
  ...legacyTraders.active.filter(x=>x.is_contract).map(x=>x.principal),
  ...otcTraders.active.filter(x=>x.is_contract).map(x=>x.principal),
])];
const contractSources=[];
for(const p of contractPrincipals){
  const dot=p.indexOf('.'),a=p.slice(0,dot),n=p.slice(dot+1);
  try{
    const src=await req(`${API}/v2/contracts/source/${a}/${n}?proof=0`);
    const text=src?.source??'';
    const publics=[...text.matchAll(/\(define-public\s+\(([^\s()]+)/g)].map(m=>m[1]);
    contractSources.push({principal:p,source_available:Boolean(text),publics,source_length:text.length,mentions_tx_sender:text.includes('tx-sender'),mentions_contract_caller:text.includes('contract-caller'),source_preview:text.slice(0,1600)});
  }catch(e){contractSources.push({principal:p,source_available:false,error:String(e)});}
  await sleep(200);
}

const evidence={
  observed_at:new Date().toISOString(),
  contracts:{hq:HQ,minting:MINT,otc:OTC},
  active_authorities:verified,
  active_protocol_replayed:activeProto,
  legacy_traders:legacyTraders,
  otc_traders:otcTraders,
  contract_authority_sources:contractSources,
  authority_ops:authorityOps,
};
fs.mkdirSync('tests/security/evidence',{recursive:true});
fs.writeFileSync('tests/security/evidence/live-usdh-full-authority-graph.json',JSON.stringify(evidence,null,2));
console.log('LIVE_USDH_FULL_AUTHORITY_GRAPH='+JSON.stringify(evidence));
console.log(`ACTIVE_AUTHORITY_COUNT=${verified.length}`);
console.log(`ACTIVE_LEGACY_TRADER_COUNT=${legacyTraders.active.length}`);
console.log(`ACTIVE_OTC_TRADER_COUNT=${otcTraders.active.length}`);
console.log(`CONTRACT_AUTHORITY_OR_TRADER_COUNT=${contractPrincipals.length}`);
