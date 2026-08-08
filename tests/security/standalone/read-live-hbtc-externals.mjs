import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const HBTC = 'SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const ZEST = 'SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7';
const STATE = `${HBTC}.state-hbtc-v1`;

const known = {
  'zest-v0-3-market': `${ZEST}.v0-3-market`,
  'zest-v0-4-market': `${ZEST}.v0-4-market`,
  'zest-v0-market-vault': `${ZEST}.v0-market-vault`,
  'zest-v0-vault-sbtc': `${ZEST}.v0-vault-sbtc`,
  'zest-v0-vault-usdh': `${ZEST}.v0-vault-usdh`,
  'granite-borrower-v1': 'SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS.borrower-v1',
  'hermetica-staking-v1-1': 'SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.staking-v1-1',
  'hermetica-staking-silo-v1-1': 'SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.staking-silo-v1-1',
  'hermetica-minting-auto-v1-2': 'SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.minting-auto-v1-2',
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function req(url, options = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url, { ...options, headers: { Accept: 'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}) } });
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : null;

    if (r.status === 429 && attempt < 4) {
      const retryHeader = Number(r.headers.get('retry-after') ?? 0);
      const messageSeconds = Number(text.match(/try again in\s+(\d+)\s+seconds?/i)?.[1] ?? 0);
      const waitSeconds = Math.max(retryHeader, messageSeconds, 2 ** attempt, 2);
      console.log(`HIRO_RATE_LIMIT retry=${attempt + 1} wait=${waitSeconds}s url=${url}`);
      await sleep(waitSeconds * 1000);
      continue;
    }

    throw new Error(`${r.status} ${url}: ${text.slice(0,1200)}`);
  }
  throw new Error(`unreachable retry exhaustion: ${url}`);
}
function argHex(cv) { return '0x' + Cl.serialize(cv); }
async function callRead(fn, args=[]) {
  const j = await req(`${API}/v2/contracts/call-read/${HBTC}/state-hbtc-v1/${fn}`, {
    method:'POST', body: JSON.stringify({sender:HBTC, arguments:args.map(argHex)})
  });
  if (!j.okay) return {okay:false,raw:j};
  return {okay:true,repr:cvToString(deserializeCV(j.result))};
}

const knownState = {};
for (const [name,address] of Object.entries(known)) {
  knownState[name] = { address, result: await callRead('get-external',[Cl.principal(address)]) };
  await sleep(150);
}

const sourceResp = await req(`${API}/v2/contracts/source/${ZEST}/v0-4-market`);
const source = sourceResp.source ?? sourceResp.source_code ?? '';
const liqPos = source.indexOf('(define-public (liquidate');
const liquidationFragment = liqPos >= 0 ? source.slice(liqPos, Math.min(source.length, liqPos + 8000)) : 'NOT_FOUND';
console.log('ZEST_V04_LIQUIDATE_SOURCE=' + liquidationFragment);

const calls = [];
for (let offset=0; offset<500; offset+=50) {
  const j = await req(`${API}/extended/v1/address/${encodeURIComponent(STATE)}/transactions?limit=50&offset=${offset}`);
  for (const tx of j.results ?? []) {
    const cc = tx.contract_call;
    if (!cc || cc.contract_id !== STATE) continue;
    if (!['request-external-add','request-external-remove','confirm-external-request','cancel-external-request'].includes(cc.function_name)) continue;
    calls.push({
      tx_id:tx.tx_id, block_height:tx.block_height, block_time_iso:tx.block_time_iso,
      status:tx.tx_status, sender:tx.sender_address, fn:cc.function_name,
      args:(cc.function_args??[]).map(a=>({name:a.name,repr:a.repr})), result:tx.tx_result?.repr,
    });
  }
  if ((j.results??[]).length < 50) break;
  await sleep(250);
}

console.log('LIVE_HBTC_KNOWN_EXTERNALS='+JSON.stringify(knownState));
console.log('LIVE_HBTC_EXTERNAL_OPS='+JSON.stringify(calls));
