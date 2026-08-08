import { deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const DEPLOYER = 'SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG';
const OLD_STAKING = `${DEPLOYER}.staking-v1`;
const NEW_STAKING = `${DEPLOYER}.staking-v1-1`;
const NEW_RESERVE = `${DEPLOYER}.staking-reserve-v1`;
const USDH_ASSET = `${DEPLOYER}.usdh-token-v1::usdh`;

async function request(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${url}: ${text.slice(0, 1000)}`);
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

async function blockIndexHash(height) {
  const j = await request(`${API}/extended/v3/blocks/${height}/transactions?limit=1`);
  const tx = j?.results?.[0];
  if (!tx?.block?.index_hash) throw new Error(`no index hash for height ${height}: ${JSON.stringify(j).slice(0, 1000)}`);
  return tx.block.index_hash.replace(/^0x/, '');
}

async function callReadAt(contract, fn, height) {
  const tip = await blockIndexHash(height);
  const url = `${API}/v2/contracts/call-read/${DEPLOYER}/${contract}/${fn}?tip=${tip}`;
  const j = await request(url, {
    method: 'POST',
    body: JSON.stringify({ sender: DEPLOYER, arguments: [] }),
  });
  if (!j.okay) return { okay: false, raw: j };
  return { okay: true, repr: cvToString(deserializeCV(j.result)), hex: j.result };
}

const heights = [
  3567191, // before staking-state-v1
  3567209, // staking-silo-v1-1 deployment block
  3567229, // immediately before staking-reserve-v1 deployment
  3567230, // staking-reserve-v1 deployed
  3567257, // immediately before staking-v1-1 deployment
  3567258, // staking-v1-1 deployed
  3567288, // controller-v1-1 deployed
  3567300,
  3567400,
  3567600,
  3568000,
  3569000,
  3570000,
];

const rows = [];
for (const height of heights) {
  const oldBacking = await balanceAt(OLD_STAKING, height);
  const newBacking = await balanceAt(NEW_RESERVE, height);
  let supply;
  let oldRatio;
  let newRatio;
  try { supply = await callReadAt('susdh-token-v1', 'get-total-supply', height); } catch (e) { supply = { error: String(e) }; }
  try { oldRatio = await callReadAt('staking-v1', 'get-usdh-per-susdh', height); } catch (e) { oldRatio = { error: String(e) }; }
  if (height >= 3567258) {
    try { newRatio = await callReadAt('staking-v1-1', 'get-usdh-per-susdh', height); } catch (e) { newRatio = { error: String(e) }; }
  }
  const row = {
    height,
    old_staking_usdh_raw: oldBacking.toString(),
    new_reserve_usdh_raw: newBacking.toString(),
    susdh_supply: supply?.repr ?? supply,
    old_ratio: oldRatio?.repr ?? oldRatio,
    new_ratio: newRatio?.repr ?? newRatio ?? null,
  };
  rows.push(row);
  console.log('MIGRATION_ROW=' + JSON.stringify(row));
}

// Also fetch the first pages of asset events around the new reserve. This is
// read-only and helps identify the transaction that initially seeded it.
for (const until of [3567258, 3567300, 3568000, 3570000, 3600000]) {
  try {
    const events = await request(`${API}/extended/v1/address/${encodeURIComponent(NEW_RESERVE)}/assets?limit=50&offset=0&until_block=${until}`);
    console.log(`RESERVE_EVENTS_UNTIL_${until}=` + JSON.stringify(events));
  } catch (e) {
    console.log(`RESERVE_EVENTS_UNTIL_${until}_ERROR=${String(e)}`);
  }
}

console.log('MIGRATION_SNAPSHOT=' + JSON.stringify(rows));
