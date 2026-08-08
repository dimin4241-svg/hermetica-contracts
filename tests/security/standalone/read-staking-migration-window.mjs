import { deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const DEPLOYER = 'SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG';
const OLD_STAKING = `${DEPLOYER}.staking-v1`;
const NEW_RESERVE = `${DEPLOYER}.staking-reserve-v1`;
const USDH_ASSET = `${DEPLOYER}.usdh-token-v1::usdh`;
const BASE = 100_000_000n;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url, options = {}, attempt = 0) {
  const r = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await r.text();
  if (r.status === 429 && attempt < 7) {
    const wait = Math.min(20_000, 1_500 * 2 ** attempt);
    console.log(`RATE_LIMIT wait_ms=${wait} url=${url}`);
    await sleep(wait);
    return request(url, options, attempt + 1);
  }
  if (!r.ok) throw new Error(`${r.status} ${url}: ${text.slice(0, 1000)}`);
  await sleep(350);
  return text ? JSON.parse(text) : null;
}

function ftBalanceFromV1(j, asset = USDH_ASSET) {
  const item = j?.fungible_tokens?.[asset];
  return item ? BigInt(item.balance) : 0n;
}

async function balanceAt(principal, height) {
  const j = await request(`${API}/extended/v1/address/${encodeURIComponent(principal)}/balances?until_block=${height}`);
  return ftBalanceFromV1(j);
}

const blockCache = new Map();
async function blockIndexHash(height) {
  if (blockCache.has(height)) return blockCache.get(height);
  const j = await request(`${API}/extended/v3/blocks/${height}/transactions?limit=1`);
  const tx = j?.results?.[0];
  if (!tx?.block?.index_hash) throw new Error(`no index hash for height ${height}: ${JSON.stringify(j).slice(0, 1000)}`);
  const tip = tx.block.index_hash.replace(/^0x/, '');
  blockCache.set(height, tip);
  return tip;
}

async function callReadAt(contract, fn, height) {
  const tip = await blockIndexHash(height);
  const j = await request(`${API}/v2/contracts/call-read/${DEPLOYER}/${contract}/${fn}?tip=${tip}`, {
    method: 'POST',
    body: JSON.stringify({ sender: DEPLOYER, arguments: [] }),
  });
  if (!j.okay) return { okay: false, raw: j };
  return { okay: true, repr: cvToString(deserializeCV(j.result)), hex: j.result };
}

function parseOkUint(repr) {
  const m = /^\(ok u(\d+)\)$/.exec(repr || '');
  return m ? BigInt(m[1]) : null;
}

function ratio(backing, supply) {
  if (backing === 0n || supply === 0n) return BASE;
  return backing * BASE / supply;
}

// The first five rows from the previous run already established the exact
// pre-deployment state. Focus this retry on the deployment and post-deployment
// interval to minimize public API requests.
const heights = [3567257, 3567258, 3567288, 3567400, 3568000, 3569000, 3570000, 3580000, 3600000];
const rows = [];

for (const height of heights) {
  const oldBacking = await balanceAt(OLD_STAKING, height);
  const newBacking = await balanceAt(NEW_RESERVE, height);
  const supplyCv = await callReadAt('susdh-token-v1', 'get-total-supply', height);
  const supply = parseOkUint(supplyCv.repr);
  const row = {
    height,
    old_staking_usdh_raw: oldBacking.toString(),
    new_reserve_usdh_raw: newBacking.toString(),
    susdh_supply: supplyCv.repr,
    computed_old_ratio_raw: supply === null ? null : ratio(oldBacking, supply).toString(),
    computed_new_ratio_raw: supply === null ? null : ratio(newBacking, supply).toString(),
  };
  rows.push(row);
  console.log('MIGRATION_ROW=' + JSON.stringify(row));
}

// Identify asset events visible shortly after migration. Event objects include
// transaction IDs; those can then be inspected separately without guessing.
for (const until of [3567258, 3568000, 3570000, 3600000]) {
  try {
    const events = await request(`${API}/extended/v1/address/${encodeURIComponent(NEW_RESERVE)}/assets?limit=50&offset=0&until_block=${until}`);
    console.log(`RESERVE_EVENTS_UNTIL_${until}=` + JSON.stringify(events));
  } catch (e) {
    console.log(`RESERVE_EVENTS_UNTIL_${until}_ERROR=${String(e)}`);
  }
}

// Pull deployer transactions as of the migration period. This endpoint is
// ordered newest-first up to until_block; filter locally to the relevant range.
try {
  const txs = await request(`${API}/extended/v1/address/${DEPLOYER}/transactions?limit=50&offset=0&until_block=3600000`);
  const relevant = (txs?.results || []).filter((x) => (x.block_height || 0) >= 3567000);
  console.log('DEPLOYER_MIGRATION_TXS=' + JSON.stringify(relevant));
} catch (e) {
  console.log('DEPLOYER_MIGRATION_TXS_ERROR=' + String(e));
}

console.log('MIGRATION_SNAPSHOT=' + JSON.stringify(rows));
