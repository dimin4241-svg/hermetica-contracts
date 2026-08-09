import fs from 'node:fs';
import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const D = 'SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG';
const HQ = `${D}.hq-v1`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const names = [
  'controller-v1','controller-v1-1',
  'staking-v1','staking-v1-1','staking-silo-v1','staking-silo-v1-1','staking-reserve-v1','staking-state-v1',
  'minting-v1','minting-otc-v1','minting-otc-v1-1','minting-auto-v1','minting-auto-v1-1','minting-auto-v1-2','minting-auto-state-v1','minting-state-v1',
  'redeeming-reserve-v1','redeeming-reserve-v1-1','redeeming-reserve-v1-2',
  'emergency-recover-v1','blacklist-susdh-v1','usdh-token-v1','susdh-token-v1'
];

async function req(url, options={}) {
  for (let i=0;i<8;i++) {
    const r = await fetch(url,{...options,headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{})}});
    const t = await r.text();
    if (r.ok) return t ? JSON.parse(t) : null;
    if (r.status===429 && i<7) {
      const m=Number(t.match(/try again in\s+(\d+)\s+seconds?/i)?.[1]??0);
      const wait=Math.max(Number(r.headers.get('retry-after')??0),m,2**i,2);
      console.log(`HIRO_RATE_LIMIT retry=${i+1} wait=${wait}s`); await sleep(wait*1000); continue;
    }
    throw new Error(`${r.status} ${url}: ${t.slice(0,1000)}`);
  }
}
function hex(cv){return '0x'+Cl.serialize(cv)}
async function ro(fn,args=[]) {
  const j=await req(`${API}/v2/contracts/call-read/${D}/hq-v1/${fn}`,{method:'POST',body:JSON.stringify({sender:D,arguments:args.map(hex)})});
  return j.okay?{okay:true,repr:cvToString(deserializeCV(j.result))}:{okay:false,raw:j};
}

const roleReads=[];
for (const name of names) {
  const p=`${D}.${name}`;
  roleReads.push({principal:p, protocol:await ro('get-contract-active',[Cl.principal(p)]), minting:await ro('get-minting-contract',[Cl.principal(p)])});
  await sleep(120);
}

const ops=[];
for(let offset=0;offset<5000;offset+=50){
  const page=await req(`${API}/extended/v1/address/${encodeURIComponent(HQ)}/transactions?limit=50&offset=${offset}`);
  const rows=page.results??[];
  for(const tx of rows){
    const cc=tx.contract_call;
    if(!cc||cc.contract_id!==HQ) continue;
    if(!['set-contract-active','request-minting-contract-update','activate-minting-contract','remove-minting-contract'].includes(cc.function_name)) continue;
    ops.push({tx_id:tx.tx_id,block_height:tx.block_height,block_time_iso:tx.block_time_iso,status:tx.tx_status,sender:tx.sender_address,fn:cc.function_name,args:(cc.function_args??[]).map(a=>({name:a.name,repr:a.repr})),result:tx.tx_result?.repr??null});
  }
  if(rows.length<50)break; await sleep(250);
}
const activeProtocol=roleReads.filter(x=>x.protocol.repr==='true');
const activeMinting=roleReads.filter(x=>/\(active true\)/.test(x.minting.repr??''));
const evidence={observed_at:new Date().toISOString(),hq:HQ,active_protocol:activeProtocol,active_minting:activeMinting,all_reads:roleReads,role_ops:ops.sort((a,b)=>a.block_height-b.block_height)};
fs.mkdirSync('tests/security/evidence',{recursive:true});
fs.writeFileSync('tests/security/evidence/live-usdh-role-versions.json',JSON.stringify(evidence,null,2));
console.log('LIVE_USDH_ROLE_VERSIONS='+JSON.stringify(evidence));
console.log('ACTIVE_PROTOCOL_COUNT='+activeProtocol.length);
console.log('ACTIVE_MINTING_COUNT='+activeMinting.length);
