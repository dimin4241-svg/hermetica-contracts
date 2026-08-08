import fs from 'node:fs';
import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const HBTC = 'SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const HQ = `${HBTC}.hq-v1`;
const VAULTS = [
  { name: 'vault-hbtc-v1', removed_at_block: 7207702, removed_at_iso: '2026-03-17T21:47:06.000Z' },
  { name: 'vault-hbtc-v1-1', removed_at_block: 7445784, removed_at_iso: '2026-04-02T18:34:53.000Z' },
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function req(url, options = {}) {
  for (let attempt = 0; attempt < 7; attempt++) {
    const r = await fetch(url, {
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}) },
    });
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : null;
    if (r.status === 429 && attempt < 6) {
      const h = Number(r.headers.get('retry-after') ?? 0);
      const m = Number(text.match(/try again in\s+(\d+)\s+seconds?/i)?.[1] ?? 0);
      const wait = Math.max(h, m, 2 ** attempt, 2);
      console.log(`HIRO_RATE_LIMIT retry=${attempt + 1} wait=${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    throw new Error(`${r.status} ${url}: ${text.slice(0,1200)}`);
  }
  throw new Error(`retry exhaustion: ${url}`);
}

function argHex(cv) { return '0x' + Cl.serialize(cv); }
async function callRead(contractName, fn, args = [], sender = HBTC) {
  const j = await req(`${API}/v2/contracts/call-read/${HBTC}/${contractName}/${fn}`, {
    method: 'POST',
    body: JSON.stringify({ sender, arguments: args.map(argHex) }),
  });
  if (!j.okay) return { okay: false, raw: j };
  return { okay: true, repr: cvToString(deserializeCV(j.result)), hex: j.result };
}

async function getProtocol(principal) {
  return callRead('hq-v1', 'get-protocol', [Cl.principal(principal)]);
}

function parseClaimId(repr) {
  const m = String(repr ?? '').match(/^\(ok u(\d+)\)$/);
  return m ? Number(m[1]) : null;
}

function extractField(repr, field) {
  const s = String(repr ?? '');
  const patterns = {
    user: /\(user ([A-Z0-9.]+)\)/,
    shares: /\(shares u(\d+)\)/,
    assets: /\(assets (none|\(some u\d+\))\)/,
    fee: /\(fee (none|\(some u\d+\))\)/,
    isExpress: /\(is-express (true|false)\)/,
    ts: /\(ts u(\d+)\)/,
  };
  const m = s.match(patterns[field]);
  return m?.[1] ?? null;
}

async function scanVault(v) {
  const principal = `${HBTC}.${v.name}`;
  const calls = [];
  for (let offset = 0; offset < 5000; offset += 50) {
    const j = await req(`${API}/extended/v1/address/${encodeURIComponent(principal)}/transactions?limit=50&offset=${offset}`);
    const rows = j.results ?? [];
    for (const tx of rows) {
      const cc = tx.contract_call;
      if (!cc || cc.contract_id !== principal) continue;
      if (!['request-redeem','fund-claim','fund-claim-many','cancel-redeem','redeem','redeem-many','redeem-peg-out','redeem-peg-out-many'].includes(cc.function_name)) continue;
      calls.push({
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
    await sleep(250);
  }
  calls.sort((a,b) => a.block_height - b.block_height);

  const requests = calls.filter(x => x.fn === 'request-redeem' && x.status === 'success' && String(x.result ?? '').startsWith('(ok'))
    .map(x => ({
      ...x,
      claim_id: parseClaimId(x.result),
      shares_arg: x.args.find(a => a.name === 'shares')?.repr ?? null,
      is_express_arg: x.args.find(a => a.name === 'is-express')?.repr ?? null,
      before_removal: x.block_height < v.removed_at_block,
    }))
    .filter(x => Number.isInteger(x.claim_id));

  const currentClaims = [];
  for (const r of requests) {
    const read = await callRead(v.name, 'get-claim', [Cl.uint(r.claim_id)]);
    const repr = read.repr ?? '';
    currentClaims.push({
      claim_id: r.claim_id,
      request_tx: r.tx_id,
      request_block: r.block_height,
      request_time_iso: r.block_time_iso,
      requester: r.sender,
      requested_is_express: r.is_express_arg,
      requested_shares: r.shares_arg,
      existed_before_removal: r.before_removal,
      live_read: read,
      still_exists: read.okay && String(repr).startsWith('(ok (tuple'),
      live_user: extractField(repr, 'user'),
      live_shares: extractField(repr, 'shares'),
      live_assets: extractField(repr, 'assets'),
      live_fee: extractField(repr, 'fee'),
      live_is_express: extractField(repr, 'isExpress'),
      live_ts: extractField(repr, 'ts'),
    });
    await sleep(120);
  }

  const role = await getProtocol(principal);
  const strandedExpress = currentClaims.filter(c =>
    c.existed_before_removal && c.still_exists && c.live_is_express === 'true' && c.live_assets === 'none'
  );

  return {
    vault: principal,
    protocol_role_now: role,
    removal: { block_height: v.removed_at_block, block_time_iso: v.removed_at_iso },
    relevant_top_level_calls: calls,
    request_count: requests.length,
    current_claim_reads: currentClaims,
    stranded_unfunded_express_claims: strandedExpress,
  };
}

const results = [];
for (const v of VAULTS) {
  console.log(`SCAN_RETIRED_VAULT ${v.name}`);
  results.push(await scanVault(v));
}

const evidence = {
  observed_at: new Date().toISOString(),
  methodology: 'Read-only Hiro history plus live get-claim/get-protocol calls. No transaction is broadcast.',
  results,
  total_stranded_unfunded_express_claims: results.reduce((n, r) => n + r.stranded_unfunded_express_claims.length, 0),
};

fs.mkdirSync('tests/security/evidence', { recursive: true });
fs.writeFileSync('tests/security/evidence/live-hbtc-retired-vault-claims.json', JSON.stringify(evidence, null, 2));
console.log('LIVE_HBTC_RETIRED_VAULT_CLAIMS=' + JSON.stringify(evidence));
if (evidence.total_stranded_unfunded_express_claims > 0) {
  console.log('POTENTIAL_FINDING: retired hBTC vault retains unfunded express claim(s) that cannot be cancelled while the vault no longer has PROTOCOL role.');
} else {
  console.log('NO_CURRENT_STRANDED_EXPRESS_CLAIM_FOUND_IN_SCANNED_TOP_LEVEL_REQUESTS');
}
