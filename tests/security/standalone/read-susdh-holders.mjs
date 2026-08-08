const API = 'https://api.hiro.so';
const ASSET = 'SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.susdh-token-v1::susdh';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, attempt = 0) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await r.text();
  if (r.status === 429 && attempt < 7) {
    const wait = Math.min(15000, 1000 * 2 ** attempt);
    console.log(`RATE_LIMIT ${wait}ms ${url}`);
    await sleep(wait);
    return get(url, attempt + 1);
  }
  if (!r.ok) return { _error: `${r.status} ${url}: ${text.slice(0,800)}` };
  return text ? JSON.parse(text) : null;
}

const candidates = [
  `${API}/extended/v1/tokens/ft/${encodeURIComponent(ASSET)}/holders?limit=100&offset=0`,
  `${API}/extended/v1/tokens/ft/${ASSET}/holders?limit=100&offset=0`,
];
let holders = null;
for (const url of candidates) {
  const j = await get(url);
  console.log('HOLDER_ENDPOINT_RESULT=' + JSON.stringify({ url, response: j }));
  if (j && !j._error && Array.isArray(j.results)) { holders = j; break; }
}

if (!holders) throw new Error('No working holder endpoint found');

const results = holders.results.map((x) => ({ address: x.address, balance: x.balance }));
const total = BigInt(holders.total_supply || results.reduce((a,x)=>a+BigInt(x.balance),0n));
console.log('SUSDH_HOLDERS_SUMMARY=' + JSON.stringify({
  total_holders: holders.total,
  total_supply: total.toString(),
  top: results.slice(0,50),
}));

for (const [i, h] of results.slice(0,20).entries()) {
  const bal = BigInt(h.balance);
  const ppm = total > 0n ? bal * 1_000_000n / total : 0n;
  console.log(`TOP_HOLDER rank=${i+1} address=${h.address} balance_raw=${bal} supply_ppm=${ppm}`);
}
