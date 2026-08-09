import fs from 'node:fs';
import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const HBTC = 'SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4';
const RETIRED = [
  `${HBTC}.vault-hbtc-v1`,
  `${HBTC}.vault-hbtc-v1-1`,
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function req(url, options = {}) {
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await fetch(url, {
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
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
async function callRead(deployer, contract, fn, args = [], sender = HBTC) {
  const j = await req(`${API}/v2/contracts/call-read/${deployer}/${contract}/${fn}`, {
    method: 'POST',
    body: JSON.stringify({ sender, arguments: args.map(argHex) }),
  });
  if (!j.okay) return { okay: false, raw: j };
  return { okay: true, repr: cvToString(deserializeCV(j.result)), hex: j.result };
}

function okUint(repr) {
  const m = String(repr ?? '').match(/^\(ok u(\d+)\)$/);
  return m ? BigInt(m[1]) : null;
}

const rows = [];
for (const address of RETIRED) {
  const addressBalances = await req(`${API}/extended/v1/address/${encodeURIComponent(address)}/balances`);
  const sbtc = await callRead(SBTC, 'sbtc-token', 'get-balance', [Cl.principal(address)]);
  const hbtc = await callRead(HBTC, 'token-hbtc', 'get-balance', [Cl.principal(address)]);
  const protocol = await callRead(HBTC, 'hq-v1', 'get-protocol', [Cl.principal(address)]);
  const sbtcRaw = okUint(sbtc.repr);
  const hbtcRaw = okUint(hbtc.repr);
  rows.push({
    address,
    protocol,
    sbtc,
    hbtc,
    sbtc_raw: sbtcRaw?.toString() ?? null,
    hbtc_raw: hbtcRaw?.toString() ?? null,
    all_fungible_token_balances: addressBalances?.fungible_tokens ?? {},
    stx_balance: addressBalances?.stx?.balance ?? null,
  });
  await sleep(250);
}

const nonzero = rows.filter(r => BigInt(r.sbtc_raw ?? '0') > 0n || BigInt(r.hbtc_raw ?? '0') > 0n || Object.values(r.all_fungible_token_balances ?? {}).some(v => BigInt(v?.balance ?? '0') > 0n));
const evidence = {
  observed_at: new Date().toISOString(),
  methodology: 'Read-only Hiro balance and Clarity call-read queries. No transaction is broadcast.',
  retired_vaults: rows,
  retired_vaults_with_nonzero_ft_balance: nonzero,
};

fs.mkdirSync('tests/security/evidence', { recursive: true });
fs.writeFileSync('tests/security/evidence/live-hbtc-retired-vault-balances.json', JSON.stringify(evidence, null, 2));
console.log('LIVE_HBTC_RETIRED_VAULT_BALANCES=' + JSON.stringify(evidence));
if (nonzero.length > 0) {
  console.log('POTENTIAL_RETIRED_CUSTODY: retired vault contract(s) still hold fungible-token balances; reconcile against live claims and recovery paths.');
} else {
  console.log('PASS_RETIRED_CUSTODY_NEGATIVE_CONTROL: retired vaults have no fungible-token custody remaining.');
}
