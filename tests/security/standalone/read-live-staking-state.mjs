import { deserializeCV, cvToString } from '@stacks/transactions';

const DEPLOYER = 'SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG';
const STAKING_RESERVE = `${DEPLOYER}.staking-reserve-v1`;
const USDH_ASSET = `${DEPLOYER}.usdh-token-v1::usdh`;
const API = 'https://api.hiro.so';

async function getJson(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${url}: ${text}`);
  return JSON.parse(text);
}

async function callRead(contract, fn) {
  const j = await getJson(`${API}/v2/contracts/call-read/${DEPLOYER}/${contract}/${fn}`, {
    method: 'POST',
    body: JSON.stringify({ sender: DEPLOYER, arguments: [] }),
  });
  if (!j.okay) throw new Error(`read-only ${contract}.${fn} failed: ${JSON.stringify(j)}`);
  return {
    hex: j.result,
    repr: cvToString(deserializeCV(j.result)),
  };
}

const ft = await getJson(`${API}/extended/v3/principals/${encodeURIComponent(STAKING_RESERVE)}/balances/ft?limit=100`);
const usdh = ft.results.find((x) => x.asset_identifier === USDH_ASSET);
if (!usdh) throw new Error(`USDh balance not found in staking reserve: ${JSON.stringify(ft)}`);

const supply = await callRead('susdh-token-v1', 'get-total-supply');
const ratio = await callRead('staking-v1-1', 'get-usdh-per-susdh');

const snapshot = {
  observed_at: new Date().toISOString(),
  staking_reserve: STAKING_RESERVE,
  usdh_asset: USDH_ASSET,
  staking_reserve_usdh_raw: usdh.balance,
  susdh_total_supply: supply.repr,
  usdh_per_susdh: ratio.repr,
};

console.log('LIVE_STAKING_STATE=' + JSON.stringify(snapshot));
