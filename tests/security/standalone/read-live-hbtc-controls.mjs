import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const HBTC = 'SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const ZEST = 'SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7';
const ZEST_MARKET = `${ZEST}.v0-3-market`;
const ZEST_SBTC_VAULT = `${ZEST}.v0-vault-sbtc`;

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

function argHex(cv) { return '0x' + Cl.serialize(cv); }

async function callRead(contract, fn, args = []) {
  const j = await getJson(`${API}/v2/contracts/call-read/${HBTC}/${contract}/${fn}`, {
    method: 'POST',
    body: JSON.stringify({ sender: HBTC, arguments: args.map(argHex) }),
  });
  if (!j.okay) return { okay: false, raw: j };
  return { okay: true, repr: cvToString(deserializeCV(j.result)), hex: j.result };
}

const stateFns = [
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
  'get-trading-enabled',
  'get-vault-enabled',
];

const state = {};
for (const fn of stateFns) {
  try { state[fn] = await callRead('state-hbtc-v1', fn); }
  catch (e) { state[fn] = { error: String(e) }; }
}

const hq = {};
for (const fn of ['get-timelock', 'get-protocol-enabled']) {
  try { hq[fn] = await callRead('hq-v1', fn); }
  catch (e) { hq[fn] = { error: String(e) }; }
}

const externals = {};
for (const [name, address] of [['zest-market', ZEST_MARKET], ['zest-sbtc-vault', ZEST_SBTC_VAULT]]) {
  try { externals[name] = await callRead('state-hbtc-v1', 'get-external', [Cl.principal(address)]); }
  catch (e) { externals[name] = { error: String(e) }; }
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
  hq,
  state,
  externals,
}));
