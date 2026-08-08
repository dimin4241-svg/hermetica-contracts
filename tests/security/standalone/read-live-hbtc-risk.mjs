import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const HBTC = 'SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const ZEST = 'SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7';
const ZEST_MARKET = 'v0-3-market';
const ZEST_MARKET_VAULT = 'v0-market-vault';
const ZEST_ACCOUNT = `${HBTC}.zest-interface-hbtc-v1`;
const TRADING = `${HBTC}.trading-hbtc-v1`;
const SBTC_ASSET = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token';

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
  if (!r.ok) throw new Error(`${r.status} ${url}: ${text.slice(0, 1200)}`);
  return text ? JSON.parse(text) : null;
}

function argHex(cv) {
  // Stacks.js Cl.serialize returns raw hex without the 0x prefix.
  return '0x' + Cl.serialize(cv);
}

async function callRead(address, contract, fn, args = [], sender = HBTC) {
  const url = `${API}/v2/contracts/call-read/${address}/${contract}/${fn}`;
  const j = await getJson(url, {
    method: 'POST',
    body: JSON.stringify({ sender, arguments: args.map(argHex) }),
  });
  if (!j.okay) return { okay: false, raw: j };
  return { okay: true, repr: cvToString(deserializeCV(j.result)), hex: j.result };
}

async function ftBalances(principal) {
  const url = `${API}/extended/v3/principals/${encodeURIComponent(principal)}/balances/ft?limit=200`;
  return getJson(url);
}

async function contractSource(address, contract) {
  const j = await getJson(`${API}/v2/contracts/source/${address}/${contract}`);
  return j.source ?? j.source_code ?? '';
}

async function addressTransactions(principal, limit = 100) {
  try {
    return await getJson(`${API}/extended/v1/address/${encodeURIComponent(principal)}/transactions?limit=${limit}&offset=0`);
  } catch (e) {
    return { error: String(e), results: [] };
  }
}

const stateFns = [
  'get-total-assets',
  'get-net-assets',
  'get-share-price',
  'get-last-log-ts',
  'get-pending',
  'get-reserve-rate',
  'get-effective-express-limit',
  'get-cooldown',
  'get-express-cooldown',
];

const state = {};
for (const fn of stateFns) {
  try { state[fn] = await callRead(HBTC, 'state-hbtc-v1', fn); }
  catch (e) { state[fn] = { error: String(e) }; }
}

const supply = await callRead(HBTC, 'token-hbtc', 'get-total-supply');
const reserveBalances = await ftBalances(`${HBTC}.reserve-hbtc-v1`);
const reserveFundBalances = await ftBalances(`${HBTC}.reserve-fund-hbtc-v1`);
const zestInterfaceBalances = await ftBalances(ZEST_ACCOUNT);

function summarizeFt(j) {
  return (j?.results ?? []).map(x => ({
    asset_identifier: x.asset_identifier,
    balance: x.balance,
  }));
}

const source = await contractSource(ZEST, ZEST_MARKET);
for (const needle of [
  '(define-private (get-position',
  '(define-private (get-full-position',
  '(define-private (get-liquidation-position',
  '(define-read-only (get-position',
]) {
  const pos = source.indexOf(needle);
  if (pos >= 0) console.log(`ZEST_GETTER_SOURCE=${source.slice(pos, Math.min(source.length, pos + 3200))}`);
  else console.log(`ZEST_GETTER_NOT_FOUND=${needle}`);
}

const positionReads = {};
for (const [contract, fn] of [
  [ZEST_MARKET_VAULT, 'resolve-safe'],
  [ZEST_MARKET_VAULT, 'resolve'],
]) {
  try {
    positionReads[`${contract}.${fn}`] = await callRead(ZEST, contract, fn, [Cl.principal(ZEST_ACCOUNT)], ZEST_ACCOUNT);
  } catch (e) {
    positionReads[`${contract}.${fn}`] = { error: String(e) };
  }
}

const tradingTxsRaw = await addressTransactions(TRADING, 100);
const tradingTxs = (tradingTxsRaw?.results ?? []).map(tx => ({
  tx_id: tx.tx_id,
  block_height: tx.block_height,
  block_time_iso: tx.block_time_iso,
  status: tx.tx_status,
  contract_id: tx.contract_call?.contract_id,
  function_name: tx.contract_call?.function_name,
  function_args: tx.contract_call?.function_args?.map(a => ({ name: a.name, repr: a.repr })),
})).filter(tx => tx.contract_id === TRADING || (tx.function_name ?? '').includes('zest'));

const zestAccountTxsRaw = await addressTransactions(ZEST_ACCOUNT, 100);
const zestAccountTxs = (zestAccountTxsRaw?.results ?? []).map(tx => ({
  tx_id: tx.tx_id,
  block_height: tx.block_height,
  block_time_iso: tx.block_time_iso,
  status: tx.tx_status,
  contract_id: tx.contract_call?.contract_id,
  function_name: tx.contract_call?.function_name,
}));

const blocks = await getJson(`${API}/extended/v2/blocks?limit=1`);
const latest = blocks?.results?.[0] ?? null;

const snapshot = {
  observed_at: new Date().toISOString(),
  latest_block: latest ? {
    height: latest.height,
    burn_block_height: latest.burn_block_height,
    block_time: latest.block_time,
    burn_block_time: latest.burn_block_time,
  } : null,
  hbtc_deployer: HBTC,
  zest_account: ZEST_ACCOUNT,
  state,
  hbtc_supply: supply,
  reserve_ft: summarizeFt(reserveBalances),
  reserve_fund_ft: summarizeFt(reserveFundBalances),
  zest_interface_ft: summarizeFt(zestInterfaceBalances),
  zest_position_reads: positionReads,
  recent_trading_txs: tradingTxs,
  recent_zest_account_txs: zestAccountTxs,
};

console.log('LIVE_HBTC_RISK=' + JSON.stringify(snapshot));

const sbtcReserve = snapshot.reserve_ft.find(x => x.asset_identifier === SBTC_ASSET);
console.log('RESERVE_SBTC_RAW=' + (sbtcReserve?.balance ?? 'NOT_FOUND'));
