import fs from 'node:fs';
import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const HBTC = 'SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const STATE = `${HBTC}.state-hbtc-v1`;
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
      console.log(`HIRO_RATE_LIMIT retry=${attempt + 1} wait=${wait}s url=${url}`);
      await sleep(wait * 1000);
      continue;
    }
    throw new Error(`${r.status} ${url}: ${text.slice(0,1200)}`);
  }
  throw new Error(`retry exhaustion: ${url}`);
}

function argHex(cv) { return '0x' + Cl.serialize(cv); }
async function callState(fn, args = []) {
  const j = await req(`${API}/v2/contracts/call-read/${HBTC}/state-hbtc-v1/${fn}`, {
    method: 'POST',
    body: JSON.stringify({ sender: HBTC, arguments: args.map(argHex) }),
  });
  if (!j.okay) return { okay: false, raw: j };
  return { okay: true, repr: cvToString(deserializeCV(j.result)) };
}

const names = new Set([
  'set-custom-exit-fee', 'set-custom-exit-fee-many',
  'remove-custom-exit-fee', 'remove-custom-exit-fee-many',
  'set-custom-cooldown', 'set-custom-cooldown-many',
  'remove-custom-cooldown', 'remove-custom-cooldown-many',
]);

const txs = [];
for (let offset = 0; offset < 1500; offset += 50) {
  const j = await req(`${API}/extended/v1/address/${encodeURIComponent(STATE)}/transactions?limit=50&offset=${offset}`);
  const rows = j.results ?? [];
  for (const tx of rows) {
    const cc = tx.contract_call;
    if (!cc || cc.contract_id !== STATE || !names.has(cc.function_name)) continue;
    txs.push({
      tx_id: tx.tx_id,
      block_height: tx.block_height,
      block_time_iso: tx.block_time_iso,
      status: tx.tx_status,
      sender: tx.sender_address,
      fn: cc.function_name,
      args: (cc.function_args ?? []).map(a => ({ name: a.name, repr: a.repr })),
      result: tx.tx_result?.repr,
    });
  }
  if (rows.length < 50) break;
  await sleep(180);
}

txs.sort((a,b) => a.block_height - b.block_height);

// Collect every standard principal literally present in successful override calls.
const addressRegex = /S[MP][A-Z0-9]{38,40}/g;
const addresses = new Set();
for (const tx of txs) {
  if (tx.status !== 'success' || !String(tx.result ?? '').startsWith('(ok')) continue;
  for (const arg of tx.args) {
    for (const m of String(arg.repr ?? '').matchAll(addressRegex)) addresses.add(m[0]);
  }
}

const live = {};
for (const address of addresses) {
  live[address] = {
    customExitFee: await callState('get-custom-exit-fee', [Cl.principal(address), Cl.bool(false)]),
    customCooldown: await callState('get-custom-cooldown', [Cl.principal(address), Cl.bool(false)]),
  };
  await sleep(120);
}

const defaults = {
  exitFee: await callState('get-exit-fee'),
  cooldown: await callState('get-cooldown'),
};

const evidence = {
  observed_at: new Date().toISOString(),
  state: STATE,
  defaults,
  override_transactions: txs,
  addresses: [...addresses],
  live_values: live,
};

fs.mkdirSync('tests/security/evidence', { recursive: true });
fs.writeFileSync('tests/security/evidence/live-hbtc-custom-overrides.json', JSON.stringify(evidence, null, 2));
console.log('LIVE_HBTC_CUSTOM_OVERRIDES=' + JSON.stringify(evidence));
