import { Cl, deserializeCV, cvToString } from '@stacks/transactions';
const API='https://api.hiro.so';
const D='SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const HQ=`${D}.hq-v1`, STATE=`${D}.state-hbtc-v1`;
const candidates=[
  `${D}.granite-interface-hbtc-v1`,
  `${D}.granite-interface-v1`,
  'SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS.borrower-v1'
];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function req(url,options={}){for(let i=0;i<8;i++){const r=await fetch(url,{...options,headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{})}});const t=await r.text();if(r.ok)return JSON.parse(t);if(r.status===429){const m=Number(t.match(/try again in\s+(\d+)/i)?.[1]??2);await sleep((m+1)*1000);continue;}throw new Error(`${r.status}: ${t.slice(0,500)}`)}}
function ah(cv){return '0x'+Cl.serialize(cv)}
async function ro(contract,fn,args=[]){const dot=contract.indexOf('.'),a=contract.slice(0,dot),n=contract.slice(dot+1);const j=await req(`${API}/v2/contracts/call-read/${a}/${n}/${fn}`,{method:'POST',body:JSON.stringify({sender:D,arguments:args.map(ah)})});return j.okay?cvToString(deserializeCV(j.result)):JSON.stringify(j)}
const out={};for(const p of candidates){out[p]={protocol:await ro(HQ,'get-protocol',[Cl.principal(p)]),external:await ro(STATE,'get-external',[Cl.principal(p)])};}
console.log('LIVE_HBTC_GRANITE_STATUS='+JSON.stringify(out));
