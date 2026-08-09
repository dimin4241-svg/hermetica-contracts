import fs from 'node:fs';
import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const HBTC = 'SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const STATE = `${HBTC}.state-hbtc-v1`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function req(url, options = {}) {
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await fetch(url, {
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}) },
    });
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : null;
    last = new Error(`${r.status} ${url}: ${text.slice(0, 1200)}`);
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
async function callState(fn, args = []) {
  const j = await req(`${API}/v2/contracts/call-read/${HBTC}/state-hbtc-v1/${fn}`, {
    method: 'POST',
    body: JSON.stringify({ sender: HBTC, arguments: args.map(argHex) }),
  });
  if (!j.okay) return { okay: false, raw: j };
  return { okay: true, repr: cvToString(deserializeCV(j.result)) };
}

const names = new Set([
  'set-redeem-enabled',
  'disable-redeem',
  'set-request-redeem-enabled',
  'set-vault-enabled',
  'disable-vault',
]);

const txs = [];
for (let offset = 0; offset < 2000; offset += 50) {
  const j = await req(`${API}/extended/v1/address/${encodeURIComponent(STATE)}/transactions?limit=50&offset=${offset}`);
  const rows = j.results ?? [];
  for (const tx of rows) {
    const cc = tx.contract_call;
    if (!cc || cc.contract_id !== STATE || !names.has(cc.function_name)) continue;
    txs.push({
      tx_id: tx.tx_id,
      block_height: tx.block_height,
      block_time: tx.block_time,
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

txs.sort((a,b) => (a.block_height - b.block_height));

function boolArg(tx) {
  const arg = tx.args?.find(a => a.name === 'enabled') ?? tx.args?.[0];
  if (!arg) return null;
  if (arg.repr === 'true') return true;
  if (arg.repr === 'false') return false;
  return null;
}

const redeemOps = txs.filter(tx => tx.fn === 'set-redeem-enabled' || tx.fn === 'disable-redeem');
let redeemEnabled = true;
let openPause = null;
const pauseIntervals = [];
for (const tx of redeemOps) {
  if (tx.status !== 'success' || !String(tx.result ?? '').startsWith('(ok')) continue;
  const next = tx.fn === 'disable-redeem' ? false : boolArg(tx);
  if (next === null) continue;
  if (redeemEnabled && next === false) {
    openPause = tx;
  }
  if (!redeemEnabled && next === true && openPause) {
    const start = Number(openPause.block_time ?? 0);
    const end = Number(tx.block_time ?? 0);
    pauseIntervals.push({
      start: openPause,
      end: tx,
      duration_seconds: start && end ? end - start : null,
      duration_hours: start && end ? (end - start) / 3600 : null,
    });
    openPause = null;
  }
  redeemEnabled = next;
}

if (!redeemEnabled && openPause) {
  pauseIntervals.push({ start: openPause, end: null, duration_seconds: null, duration_hours: null });
}

const live = {
  redeem_enabled: await callState('get-redeem-enabled'),
  request_redeem_enabled: await callState('get-request-redeem-enabled'),
  vault_enabled: await callState('get-vault-enabled'),
  transfer_enabled: await callState('get-transfer-enabled'),
};

const evidence = {
  observed_at: new Date().toISOString(),
  methodology: 'Read-only Hiro transaction history + Clarity call-read. No transactions are broadcast.',
  state: STATE,
  live,
  relevant_transactions: txs,
  redeem_pause_intervals: pauseIntervals,
  successful_redeem_disable_events: redeemOps.filter(tx => tx.status === 'success' && (tx.fn === 'disable-redeem' || boolArg(tx) === false)).length,
};

fs.mkdirSync('tests/security/evidence', { recursive: true });
fs.writeFileSync('tests/security/evidence/live-hbtc-redeem-pause-history.json', JSON.stringify(evidence, null, 2));
console.log('LIVE_HBTC_REDEEM_PAUSE_HISTORY=' + JSON.stringify(evidence));
if (pauseIntervals.length) {
  console.log(`PASS HISTORICAL REDEEM PAUSE REACHABILITY: found ${pauseIntervals.length} production redemption-pause interval(s).`);
} else {
  console.log('NEGATIVE CONTROL: no historical redemption pause interval was found in scanned production state history.');
}
