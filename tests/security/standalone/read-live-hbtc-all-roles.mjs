import fs from 'node:fs';
import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const HBTC = 'SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const HQ = `${HBTC}.hq-v1`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const ROLE_FNS = {
  guardian: { request: 'request-guardian-update', confirm: 'confirm-guardian-request', cancel: 'cancel-guardian-request', getter: 'get-guardian' },
  trader: { request: 'request-trader-update', confirm: 'confirm-trader-request', cancel: 'cancel-trader-request', getter: 'get-trader' },
  rewarder: { request: 'request-rewarder-update', confirm: 'confirm-rewarder-request', cancel: 'cancel-rewarder-request', getter: 'get-rewarder' },
  manager: { request: 'request-manager-update', confirm: 'confirm-manager-request', cancel: 'cancel-manager-request', getter: 'get-manager' },
  fee_setter: { request: 'request-fee-setter-update', confirm: 'confirm-fee-setter-request', cancel: 'cancel-fee-setter-request', getter: 'get-fee-setter' },
  protocol: { request: 'request-protocol-update', confirm: 'confirm-protocol-request', cancel: 'cancel-protocol-request', getter: 'get-protocol' },
};
const FN_TO_ROLE = new Map();
for (const [role, f] of Object.entries(ROLE_FNS)) {
  for (const [kind, fn] of Object.entries(f)) if (kind !== 'getter') FN_TO_ROLE.set(fn, { role, kind });
}

async function req(url, options = {}) {
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await fetch(url, {
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}) },
    });
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : null;
    last = new Error(`${r.status} ${url}: ${text.slice(0,1200)}`);
    if (r.status !== 429 && r.status < 500) throw last;
    const h = Number(r.headers.get('retry-after') ?? 0);
    const m = Number(text.match(/try again in\s+(\d+)\s+seconds?/i)?.[1] ?? 0);
    const wait = Math.max(h, m, Math.min(60, 2 ** attempt), 2);
    console.log(`HIRO_RATE_LIMIT retry=${attempt + 1} wait=${wait}s`);
    await sleep(wait * 1000);
  }
  throw last;
}

function argHex(cv) { return '0x' + Cl.serialize(cv); }
async function callHq(fn, address) {
  const j = await req(`${API}/v2/contracts/call-read/${HBTC}/hq-v1/${fn}`, {
    method: 'POST',
    body: JSON.stringify({ sender: HBTC, arguments: [argHex(Cl.principal(address))] }),
  });
  return j.okay ? { okay: true, repr: cvToString(deserializeCV(j.result)) } : { okay: false, raw: j };
}

const ops = [];
for (let offset = 0; offset < 2500; offset += 50) {
  const j = await req(`${API}/extended/v1/address/${encodeURIComponent(HQ)}/transactions?limit=50&offset=${offset}`);
  const rows = j.results ?? [];
  for (const tx of rows) {
    const cc = tx.contract_call;
    const meta = cc && cc.contract_id === HQ ? FN_TO_ROLE.get(cc.function_name) : null;
    if (!meta) continue;
    ops.push({
      tx_id: tx.tx_id,
      block_height: tx.block_height,
      microblock_sequence: tx.microblock_sequence ?? 0,
      tx_index: tx.tx_index ?? 0,
      block_time_iso: tx.block_time_iso,
      status: tx.tx_status,
      sender: tx.sender_address,
      fn: cc.function_name,
      role: meta.role,
      kind: meta.kind,
      args: (cc.function_args ?? []).map(a => ({ name: a.name, repr: a.repr })),
      result: tx.tx_result?.repr,
    });
  }
  if (rows.length < 50) break;
  await sleep(250);
}
ops.sort((a,b) => a.block_height-b.block_height || a.microblock_sequence-b.microblock_sequence || a.tx_index-b.tx_index);

const byRole = {};
for (const role of Object.keys(ROLE_FNS)) byRole[role] = { pending: new Map(), replay: new Map(), historical: new Set() };
for (const op of ops) {
  if (op.status !== 'success' || !String(op.result ?? '').startsWith('(ok')) continue;
  const address = op.args.find(a => a.name === 'address')?.repr?.replace(/^'/, '');
  if (!address) continue;
  const r = byRole[op.role];
  r.historical.add(address);
  if (op.kind === 'request') {
    const add = op.args.find(a => a.name === 'is-add')?.repr === 'true';
    r.pending.set(address, add);
  } else if (op.kind === 'cancel') {
    r.pending.delete(address);
  } else if (op.kind === 'confirm' && r.pending.has(address)) {
    r.replay.set(address, r.pending.get(address));
    r.pending.delete(address);
  }
}

const live = {};
for (const [role, r] of Object.entries(byRole)) {
  const getter = ROLE_FNS[role].getter;
  const checks = {};
  for (const address of r.historical) {
    checks[address] = await callHq(getter, address);
    await sleep(100);
  }
  const active = Object.entries(checks).filter(([,v]) => v.okay && v.repr === 'true').map(([a]) => a);
  live[role] = {
    historical: [...r.historical],
    pending: [...r.pending.entries()],
    replay_active: [...r.replay.entries()].filter(([,v]) => v).map(([a]) => a),
    checks,
    active,
  };
}

const traderSources = {};
for (const principal of live.trader.active) {
  const dot = principal.indexOf('.');
  if (dot < 0) { traderSources[principal] = { type: 'standard-principal' }; continue; }
  const addr = principal.slice(0,dot), name = principal.slice(dot+1);
  try {
    const j = await req(`${API}/v2/contracts/source/${addr}/${name}`);
    const src = j.source ?? j.source_code ?? '';
    const publics = [...src.matchAll(/\(define-public\s+\(([^\s()]+)/g)].map(m => m[1]);
    const callerGuards = [...src.matchAll(/check-is-(?:trader|owner|admin|manager|protocol|rewarder|guardian)[^\n]*/g)].map(m => m[0].slice(0,220));
    traderSources[principal] = { type: 'contract', publics, callerGuards, source_length: src.length };
  } catch (e) { traderSources[principal] = { error: String(e) }; }
  await sleep(150);
}

const evidence = { observed_at: new Date().toISOString(), hq: HQ, roles: live, trader_sources: traderSources, role_ops: ops };
fs.mkdirSync('tests/security/evidence', { recursive: true });
fs.writeFileSync('tests/security/evidence/live-hbtc-all-roles.json', JSON.stringify(evidence, null, 2));
console.log('LIVE_HBTC_ALL_ROLES=' + JSON.stringify(evidence));
console.log('ACTIVE_TRADERS=' + JSON.stringify(live.trader.active));
