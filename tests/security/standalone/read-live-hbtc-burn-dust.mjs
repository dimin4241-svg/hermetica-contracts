import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const HBTC = 'SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const BURN = 'SP000000000000000000002Q6VF78';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function req(url, options = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url, {
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}) },
    });
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : null;
    if (r.status === 429 && attempt < 5) {
      const h = Number(r.headers.get('retry-after') ?? 0);
      const m = Number(text.match(/try again in\s+(\d+)\s+seconds?/i)?.[1] ?? 0);
      const wait = Math.max(h, m, 2 ** attempt, 2);
      console.log(`HIRO_RATE_LIMIT retry=${attempt + 1} wait=${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    throw new Error(`${r.status}: ${text.slice(0,1000)}`);
  }
}

function argHex(cv) { return '0x' + Cl.serialize(cv); }
async function callRead(contract, fn, args = []) {
  const j = await req(`${API}/v2/contracts/call-read/${HBTC}/${contract}/${fn}`, {
    method: 'POST',
    body: JSON.stringify({ sender: HBTC, arguments: args.map(argHex) }),
  });
  if (!j.okay) throw new Error(JSON.stringify(j));
  return cvToString(deserializeCV(j.result));
}

const burnBalance = await callRead('token-hbtc', 'get-balance', [Cl.principal(BURN)]);
const supply = await callRead('token-hbtc', 'get-total-supply');
const sharePrice = await callRead('state-hbtc-v1', 'get-share-price');
const maxDeviation = await callRead('state-hbtc-v1', 'get-max-deviation');
const totalAssets = await callRead('state-hbtc-v1', 'get-total-assets');

console.log('LIVE_HBTC_BURN_DUST=' + JSON.stringify({
  observed_at: new Date().toISOString(),
  burn_address: BURN,
  burn_balance: burnBalance,
  total_supply: supply,
  share_price: sharePrice,
  max_deviation: maxDeviation,
  total_assets: totalAssets,
}));
