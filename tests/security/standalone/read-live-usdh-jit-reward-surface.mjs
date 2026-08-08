import fs from 'node:fs';
import { Cl, deserializeCV, cvToString } from '@stacks/transactions';

const API = 'https://api.hiro.so';
const DEPLOYER = 'SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG';
const CONTROLLER = `${DEPLOYER}.controller-v1-1`;
const STAKING_RESERVE = `${DEPLOYER}.staking-reserve-v1`;
const USDH = `${DEPLOYER}.usdh-token-v1`;
const SUSDH = `${DEPLOYER}.susdh-token-v1`;
const STAKING = `${DEPLOYER}.staking-v1-1`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(url, options = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await fetch(url, {
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}) },
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
    throw new Error(`${r.status} ${url}: ${text.slice(0,1000)}`);
  }
  throw new Error(`retry exhaustion: ${url}`);
}

function argHex(cv) { return '0x' + Cl.serialize(cv); }
async function ro(contract, fn, args = [], sender = DEPLOYER) {
  const [address, name] = contract.split('.');
  const j = await req(`${API}/v2/contracts/call-read/${address}/${name}/${fn}`, {
    method: 'POST',
    body: JSON.stringify({ sender, arguments: args.map(argHex) }),
  });
  if (!j.okay) return { okay: false, raw: j };
  return { okay: true, repr: cvToString(deserializeCV(j.result)), hex: j.result };
}

function uintOf(repr) {
  const m = String(repr ?? '').match(/(?:\(ok )?u(\d+)\)?/);
  return m ? BigInt(m[1]) : null;
}

const txs = [];
for (let offset = 0; offset < 5000; offset += 50) {
  const page = await req(`${API}/extended/v1/address/${encodeURIComponent(CONTROLLER)}/transactions?limit=50&offset=${offset}`);
  const rows = page.results ?? [];
  for (const tx of rows) {
    const cc = tx.contract_call;
    if (!cc || cc.contract_id !== CONTROLLER || cc.function_name !== 'log-reward') continue;
    const arg = (cc.function_args ?? []).find(a => a.name === 'reward-usdh') ?? (cc.function_args ?? [])[0];
    const raw = BigInt(String(arg?.repr ?? 'u0').replace(/^u/, ''));
    txs.push({
      tx_id: tx.tx_id,
      block_height: tx.block_height,
      burn_block_height: tx.burn_block_height ?? null,
      block_time_iso: tx.block_time_iso,
      status: tx.tx_status,
      sender: tx.sender_address,
      reward_raw: raw.toString(),
      reward_usdh: Number(raw) / 1e8,
      result: tx.tx_result?.repr ?? null,
    });
  }
  if (rows.length < 50) break;
  await sleep(300);
}

txs.sort((a,b) => a.block_height - b.block_height);
const success = txs.filter(x => x.status === 'success' && String(x.result ?? '').startsWith('(ok'));
const nonzero = success.filter(x => BigInt(x.reward_raw) > 0n);
const total = nonzero.reduce((n,x) => n + BigInt(x.reward_raw), 0n);
const max = nonzero.reduce((m,x) => BigInt(x.reward_raw) > m ? BigInt(x.reward_raw) : m, 0n);
const recent = nonzero.slice(-20).reverse();

const reserveBalRead = await ro(USDH, 'get-balance', [Cl.principal(STAKING_RESERVE)]);
const susdhSupplyRead = await ro(SUSDH, 'get-total-supply');
const ratioRead = await ro(STAKING, 'get-usdh-per-susdh');
const updateWindowRead = await ro(CONTROLLER, 'get-update-window');
const maxRewardRead = await ro(CONTROLLER, 'get-max-reward-per-window');
const lastLogRead = await ro(CONTROLLER, 'get-last-log-block-height');

const reserveRaw = uintOf(reserveBalRead.repr);
const supplyRaw = uintOf(susdhSupplyRead.repr);
const ratioRaw = uintOf(ratioRead.repr);

const evidence = {
  observed_at: new Date().toISOString(),
  controller: CONTROLLER,
  staking: STAKING,
  staking_reserve: STAKING_RESERVE,
  scanned_log_reward_calls: txs.length,
  successful_log_reward_calls: success.length,
  successful_nonzero_reward_calls: nonzero.length,
  total_reward_raw: total.toString(),
  total_reward_usdh: Number(total) / 1e8,
  max_reward_raw: max.toString(),
  max_reward_usdh: Number(max) / 1e8,
  recent_nonzero_rewards: recent,
  live: {
    staking_reserve_usdh: reserveBalRead,
    susdh_total_supply: susdhSupplyRead,
    usdh_per_susdh: ratioRead,
    controller_update_window: updateWindowRead,
    controller_max_reward_per_window: maxRewardRead,
    controller_last_log_block_height: lastLogRead,
    staking_reserve_usdh_raw: reserveRaw?.toString() ?? null,
    susdh_supply_raw: supplyRaw?.toString() ?? null,
    ratio_raw: ratioRaw?.toString() ?? null,
  },
  economics_note: 'A reward is minted directly into staking-reserve. stake() prices new sUSDh from the reserve/supply ratio immediately before that mint; unstake() prices exit from the ratio immediately after it. There is no staking-age checkpoint in either path.',
};

fs.mkdirSync('tests/security/evidence', { recursive: true });
fs.writeFileSync('tests/security/evidence/live-usdh-jit-reward-surface.json', JSON.stringify(evidence, null, 2));
console.log('LIVE_USDH_JIT_REWARD_SURFACE=' + JSON.stringify(evidence));
if (nonzero.length > 0) {
  console.log(`PASS PRODUCTION REACHABILITY: ${nonzero.length} successful non-zero controller.log-reward calls; max=${max} raw USDh.`);
} else {
  console.log('NO_NONZERO_PRODUCTION_REWARD_CALL_FOUND');
}
