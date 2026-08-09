import fs from 'node:fs';
import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const DEPLOYER = 'SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG';
const STATE = `${DEPLOYER}.minting-auto-state-v1`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(url, options = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await fetch(url, {
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : null;
    if (r.status === 429 && attempt < 7) {
      const retry = Number(r.headers.get('retry-after') ?? 0);
      const m = Number(text.match(/try again in\s+(\d+)\s+seconds?/i)?.[1] ?? 0);
      const wait = Math.max(retry, m, 2 ** attempt, 2);
      console.log(`HIRO_RATE_LIMIT retry=${attempt + 1} wait=${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    throw new Error(`${r.status} ${url}: ${text.slice(0, 1000)}`);
  }
  throw new Error(`retry exhaustion: ${url}`);
}

function argHex(cv) { return '0x' + Cl.serialize(cv); }
async function ro(contract, fn, args = [], sender = DEPLOYER) {
  const dot = contract.indexOf('.');
  const address = contract.slice(0, dot);
  const name = contract.slice(dot + 1);
  const j = await req(`${API}/v2/contracts/call-read/${address}/${name}/${fn}`, {
    method: 'POST',
    body: JSON.stringify({ sender, arguments: args.map(argHex) }),
  });
  if (!j.okay) return { okay: false, raw: j };
  return { okay: true, repr: cvToString(deserializeCV(j.result)), hex: j.result };
}

function principalFromArg(arg) {
  const text = `${arg?.repr ?? ''} ${arg?.hex ?? ''}`;
  const m = text.match(/((?:SP|SM)[A-Z0-9]+\.[A-Za-z0-9_-]+)/);
  return m?.[1] ?? null;
}

const ops = [];
const assets = new Set();
for (let offset = 0; offset < 5000; offset += 50) {
  const page = await req(`${API}/extended/v1/address/${encodeURIComponent(STATE)}/transactions?limit=50&offset=${offset}`);
  const rows = page.results ?? [];
  for (const tx of rows) {
    const cc = tx.contract_call;
    if (!cc || cc.contract_id !== STATE || cc.function_name !== 'set-supported-asset') continue;
    const tokenArg = (cc.function_args ?? []).find(a => a.name === 'token') ?? (cc.function_args ?? [])[0];
    const token = principalFromArg(tokenArg);
    if (token) assets.add(token);
    ops.push({
      tx_id: tx.tx_id,
      block_height: tx.block_height,
      block_time_iso: tx.block_time_iso,
      status: tx.tx_status,
      sender: tx.sender_address,
      result: tx.tx_result?.repr ?? null,
      token,
      args: (cc.function_args ?? []).map(a => ({ name: a.name, repr: a.repr })),
    });
  }
  if (rows.length < 50) break;
  await sleep(300);
}

const live = [];
for (const token of [...assets].sort()) {
  const config = await ro(STATE, 'get-supported-asset', [Cl.principal(token)]);
  const symbol = await ro(token, 'get-symbol');
  const name = await ro(token, 'get-name');
  const decimals = await ro(token, 'get-decimals');
  const zeroFeed = /0x0{64}/i.test(config.repr ?? '');
  const active = /\(active true\)/.test(config.repr ?? '');
  live.push({ token, config, symbol, name, decimals, active, zero_feed_id: zeroFeed });
  await sleep(250);
}

const evidence = {
  observed_at: new Date().toISOString(),
  state: STATE,
  set_supported_asset_calls: ops.length,
  operations: ops.sort((a, b) => a.block_height - b.block_height),
  assets: live,
  active_zero_feed_assets: live.filter(x => x.active && x.zero_feed_id),
};

fs.mkdirSync('tests/security/evidence', { recursive: true });
fs.writeFileSync('tests/security/evidence/live-usdh-minting-auto-assets.json', JSON.stringify(evidence, null, 2));
console.log('LIVE_USDH_MINTING_AUTO_ASSETS=' + JSON.stringify(evidence));
console.log(`ACTIVE_ZERO_FEED_ASSET_COUNT=${evidence.active_zero_feed_assets.length}`);
