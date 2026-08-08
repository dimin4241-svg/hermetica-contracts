import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const HBTC = 'SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const HQ = `${HBTC}.hq-v1`;
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
async function callHq(fn, args = []) {
  const j = await req(`${API}/v2/contracts/call-read/${HBTC}/hq-v1/${fn}`, {
    method: 'POST',
    body: JSON.stringify({ sender: HBTC, arguments: args.map(argHex) }),
  });
  if (!j.okay) return { okay: false, raw: j };
  return { okay: true, repr: cvToString(deserializeCV(j.result)) };
}

const ops = [];
for (let offset = 0; offset < 1500; offset += 50) {
  const j = await req(`${API}/extended/v1/address/${encodeURIComponent(HQ)}/transactions?limit=50&offset=${offset}`);
  const rows = j.results ?? [];
  for (const tx of rows) {
    const cc = tx.contract_call;
    if (!cc || cc.contract_id !== HQ) continue;
    if (!['request-protocol-update', 'confirm-protocol-request', 'cancel-protocol-request'].includes(cc.function_name)) continue;
    ops.push({
      tx_id: tx.tx_id,
      block_height: tx.block_height,
      microblock_sequence: tx.microblock_sequence ?? 0,
      tx_index: tx.tx_index ?? 0,
      block_time_iso: tx.block_time_iso,
      status: tx.tx_status,
      sender: tx.sender_address,
      fn: cc.function_name,
      args: (cc.function_args ?? []).map(a => ({ name: a.name, repr: a.repr })),
      result: tx.tx_result?.repr,
    });
  }
  if (rows.length < 50) break;
  await sleep(200);
}

ops.sort((a, b) =>
  a.block_height - b.block_height ||
  a.microblock_sequence - b.microblock_sequence ||
  a.tx_index - b.tx_index
);

const pending = new Map();
const active = new Map();
for (const op of ops) {
  if (op.status !== 'success' || !String(op.result ?? '').startsWith('(ok')) continue;
  const address = op.args.find(a => a.name === 'address')?.repr?.replace(/^'/, '');
  if (!address) continue;
  if (op.fn === 'request-protocol-update') {
    const addRepr = op.args.find(a => a.name === 'is-add')?.repr;
    pending.set(address, addRepr === 'true');
  } else if (op.fn === 'cancel-protocol-request') {
    pending.delete(address);
  } else if (op.fn === 'confirm-protocol-request') {
    if (pending.has(address)) {
      active.set(address, pending.get(address));
      pending.delete(address);
    }
  }
}

const historicalAddresses = [...new Set(ops.flatMap(op =>
  op.args.filter(a => a.name === 'address').map(a => a.repr?.replace(/^'/, '')).filter(Boolean)
))];

const live = {};
for (const address of historicalAddresses) {
  live[address] = await callHq('get-protocol', [Cl.principal(address)]);
  await sleep(100);
}

const activeNow = Object.entries(live)
  .filter(([, v]) => v.okay && v.repr === 'true')
  .map(([address]) => address);

const sourceSummaries = {};
for (const principal of activeNow) {
  const dot = principal.indexOf('.');
  if (dot < 0) continue;
  const addr = principal.slice(0, dot);
  const name = principal.slice(dot + 1);
  try {
    const j = await req(`${API}/v2/contracts/source/${addr}/${name}`);
    const src = j.source ?? j.source_code ?? '';
    const publics = [...src.matchAll(/\(define-public\s+\(([^\s()]+)/g)].map(m => m[1]);
    const reserveCalls = [...src.matchAll(/contract-call\?\s+\.reserve\s+transfer/g)].length;
    const updateStateCalls = [...src.matchAll(/contract-call\?\s+\.state(?:-hbtc-v1)?\s+update-state/g)].length;
    const mintCalls = [...src.matchAll(/mint-for-protocol/g)].length;
    const burnCalls = [...src.matchAll(/burn-for-protocol/g)].length;
    sourceSummaries[principal] = { publics, reserveCalls, updateStateCalls, mintCalls, burnCalls };
  } catch (e) {
    sourceSummaries[principal] = { error: String(e) };
  }
  await sleep(150);
}

console.log('LIVE_HBTC_PROTOCOL_ROLE_OPS=' + JSON.stringify(ops));
console.log('LIVE_HBTC_PROTOCOL_ROLE_RECONSTRUCTED=' + JSON.stringify({
  active_from_event_replay: [...active.entries()].filter(([, enabled]) => enabled).map(([address]) => address),
  pending: [...pending.entries()],
  live_get_protocol: live,
  active_now: activeNow,
  source_summaries: sourceSummaries,
}));
