import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const HBTC = 'SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const ZEST = 'SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7';
const ZEST_ACCOUNT = `${HBTC}.zest-interface-hbtc-v1`;
const RESERVE = `${HBTC}.reserve-hbtc-v1`;
const RESERVE_FUND = `${HBTC}.reserve-fund-hbtc-v1`;

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
  if (!r.ok) throw new Error(`${r.status} ${url}: ${text.slice(0, 1200)}`);
  return text ? JSON.parse(text) : null;
}

function argHex(cv) { return '0x' + Cl.serialize(cv); }

async function blockTip(height) {
  const j = await request(`${API}/extended/v3/blocks/${height}/transactions?limit=1`);
  const tx = j?.results?.[0];
  if (!tx?.block?.index_hash) throw new Error(`no index hash for ${height}`);
  return tx.block.index_hash.replace(/^0x/, '');
}

async function callReadAt(address, contract, fn, args, height, sender = HBTC) {
  const tip = await blockTip(height);
  const j = await request(`${API}/v2/contracts/call-read/${address}/${contract}/${fn}?tip=${tip}`, {
    method: 'POST',
    body: JSON.stringify({ sender, arguments: args.map(argHex) }),
  });
  if (!j.okay) return { okay: false, raw: j };
  return { okay: true, repr: cvToString(deserializeCV(j.result)), hex: j.result };
}

async function allFtAt(principal, height) {
  const j = await request(`${API}/extended/v1/address/${encodeURIComponent(principal)}/balances?until_block=${height}`);
  return Object.entries(j?.fungible_tokens ?? {}).map(([asset, v]) => ({ asset, balance: v.balance }));
}

async function snapshot(height) {
  const resolve = await callReadAt(ZEST, 'v0-market-vault', 'resolve-safe', [Cl.principal(ZEST_ACCOUNT)], height, ZEST_ACCOUNT);
  let mask = 0n;
  if (resolve.okay) {
    const m = resolve.repr.match(/\(mask u(\d+)\)/);
    if (m) mask = BigInt(m[1]);
  }
  const position = await callReadAt(ZEST, 'v0-market-vault', 'get-position', [Cl.principal(ZEST_ACCOUNT), Cl.uint(mask)], height, ZEST_ACCOUNT);
  const totalAssets = await callReadAt(HBTC, 'state-hbtc-v1', 'get-total-assets', [], height);
  const netAssets = await callReadAt(HBTC, 'state-hbtc-v1', 'get-net-assets', [], height);
  const sharePrice = await callReadAt(HBTC, 'state-hbtc-v1', 'get-share-price', [], height);
  const lastLog = await callReadAt(HBTC, 'state-hbtc-v1', 'get-last-log-ts', [], height);
  const supply = await callReadAt(HBTC, 'token-hbtc', 'get-total-supply', [], height);
  const reserveFt = await allFtAt(RESERVE, height);
  const reserveFundFt = await allFtAt(RESERVE_FUND, height);
  const interfaceFt = await allFtAt(ZEST_ACCOUNT, height);
  const row = { height, resolve, mask: mask.toString(), position, totalAssets, netAssets, sharePrice, lastLog, supply, reserveFt, reserveFundFt, interfaceFt };
  console.log('HBTC_ZEST_HISTORY_ROW=' + JSON.stringify(row));
  return row;
}

const heights = [8179000, 8179327, 8179328, 8179329, 8180000, 8200000, 8300000, 8400000, 8500000, 8600000];
const rows = [];
for (const h of heights) {
  try { rows.push(await snapshot(h)); }
  catch (e) { console.log(`HISTORY_ERROR height=${h} error=${String(e)}`); }
}

for (const h of [8179327, 8179328, 8179329]) {
  try {
    const block = await request(`${API}/extended/v3/blocks/${h}/transactions?limit=50`);
    const txs = (block?.results ?? []).map(x => x.tx).filter(Boolean).map(tx => ({
      tx_id: tx.tx_id,
      sender_address: tx.sender_address,
      tx_status: tx.tx_status,
      tx_type: tx.tx_type,
      contract_id: tx.contract_call?.contract_id,
      function_name: tx.contract_call?.function_name,
      function_args: tx.contract_call?.function_args?.map(a => ({ name: a.name, repr: a.repr })),
    }));
    console.log(`BLOCK_TXS_${h}=` + JSON.stringify(txs));
  } catch (e) { console.log(`BLOCK_TX_ERROR height=${h} error=${String(e)}`); }
}

console.log('HBTC_ZEST_HISTORY=' + JSON.stringify(rows));
