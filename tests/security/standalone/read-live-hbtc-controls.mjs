import { deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const HBTC = 'SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';

async function getJson(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${url}: ${text.slice(0, 1200)}`);
  return text ? JSON.parse(text) : null;
}

async function callRead(fn) {
  const j = await getJson(`${API}/v2/contracts/call-read/${HBTC}/state-hbtc-v1/${fn}`, {
    method: 'POST',
    body: JSON.stringify({ sender: HBTC, arguments: [] }),
  });
  if (!j.okay) return { okay: false, raw: j };
  return { okay: true, repr: cvToString(deserializeCV(j.result)), hex: j.result };
}

const fns = [
  'get-max-reward',
  'get-max-deviation',
  'get-update-window',
  'get-staleness-window',
  'get-last-log-ts',
  'get-total-assets',
  'get-share-price',
  'get-reserve-rate',
  'get-deposit-enabled',
  'get-redeem-enabled',
  'get-request-redeem-enabled',
  'get-reward-enabled',
];

const state = {};
for (const fn of fns) {
  try { state[fn] = await callRead(fn); }
  catch (e) { state[fn] = { error: String(e) }; }
}

const blocks = await getJson(`${API}/extended/v2/blocks?limit=1`);
const latest = blocks?.results?.[0] ?? null;
const latestTime = latest?.block_time ?? latest?.burn_block_time ?? null;
const lastLogMatch = state['get-last-log-ts']?.repr?.match(/u(\d+)/);
const lastLog = lastLogMatch ? Number(lastLogMatch[1]) : null;

console.log('LIVE_HBTC_CONTROLS=' + JSON.stringify({
  observed_at: new Date().toISOString(),
  latest_block: latest ? {
    height: latest.height,
    block_time: latest.block_time,
    burn_block_height: latest.burn_block_height,
    burn_block_time: latest.burn_block_time,
  } : null,
  seconds_since_last_log: latestTime && lastLog ? latestTime - lastLog : null,
  state,
}));
