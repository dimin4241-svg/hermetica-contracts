import { mkdir, writeFile } from 'node:fs/promises';

const API = 'https://api.hiro.so';
const HBTC = 'SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const CONTROLLER = `${HBTC}.controller-hbtc-v1`;
const EVIDENCE_PATH = 'tests/security/evidence/live-hbtc-positive-reward-history.json';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function retryDelayMs(response, body, attempt) {
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return (header + 2) * 1000;
  const m = /try again in\s+(\d+)\s+seconds?/i.exec(body ?? '');
  if (m) return (Number(m[1]) + 2) * 1000;
  return Math.min(60000, 3000 * (attempt + 1));
}

async function getJson(url, retries = 8) {
  let last;
  for (let i = 0; i < retries; i++) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : null;
    last = new Error(`${r.status} ${url}: ${text.slice(0, 500)}`);
    if (r.status !== 429 && r.status < 500) throw last;
    const wait = retryDelayMs(r, text, i);
    console.log(`HIRO_RATE_LIMIT retry=${i + 1} wait=${Math.ceil(wait / 1000)}s`);
    await sleep(wait);
  }
  throw last;
}

function normArg(a) {
  return { name: a?.name ?? null, repr: a?.repr ?? null };
}

function parseUint(repr) {
  const m = /^u(\d+)$/.exec(repr ?? '');
  return m ? BigInt(m[1]) : null;
}

async function allAddressTxs(principal) {
  const out = [];
  const limit = 50;
  for (let offset = 0; offset < 5000; offset += limit) {
    const j = await getJson(`${API}/extended/v1/address/${encodeURIComponent(principal)}/transactions?limit=${limit}&offset=${offset}`);
    const rows = j?.results ?? [];
    out.push(...rows);
    if (rows.length < limit) break;
    await sleep(1200);
  }
  return out;
}

const txs = await allAddressTxs(CONTROLLER);
const logs = txs
  .filter(tx => tx?.contract_call?.contract_id === CONTROLLER && tx?.contract_call?.function_name === 'log-reward')
  .map(tx => {
    const args = (tx.contract_call?.function_args ?? []).map(normArg);
    const rewardArg = args.find(a => a.name === 'reward') ?? args[0];
    const positiveArg = args.find(a => a.name === 'is-positive') ?? args[1];
    const reward = parseUint(rewardArg?.repr);
    const isPositive = positiveArg?.repr === 'true' ? true : positiveArg?.repr === 'false' ? false : null;
    return {
      tx_id: tx.tx_id,
      block_height: tx.block_height,
      block_time_iso: tx.block_time_iso,
      status: tx.tx_status,
      sender: tx.sender_address,
      reward_raw: reward?.toString() ?? rewardArg?.repr ?? null,
      reward_btc: reward === null ? null : Number(reward) / 1e8,
      is_positive: isPositive,
      tx_result: tx.tx_result?.repr ?? null,
      args,
    };
  });

const successfulPositive = logs.filter(x => x.status === 'success' && x.is_positive === true && BigInt(x.reward_raw) > 0n);
const zeroPositive = logs.filter(x => x.status === 'success' && x.is_positive === true && BigInt(x.reward_raw) === 0n);
const failed = logs.filter(x => x.status !== 'success');
const sorted = [...successfulPositive].sort((a, b) => {
  const aa = BigInt(a.reward_raw); const bb = BigInt(b.reward_raw);
  return aa === bb ? 0 : aa > bb ? -1 : 1;
});
const totalPositive = successfulPositive.reduce((a, x) => a + BigInt(x.reward_raw), 0n);
const maxPositive = sorted.length ? BigInt(sorted[0].reward_raw) : 0n;

const evidence = {
  observed_at: new Date().toISOString(),
  controller: CONTROLLER,
  scanned_address_transactions: txs.length,
  log_reward_calls: logs.length,
  successful_nonzero_positive_calls: successfulPositive.length,
  successful_zero_positive_calls: zeroPositive.length,
  failed_log_reward_calls: failed.length,
  total_successful_positive_reward_raw: totalPositive.toString(),
  total_successful_positive_reward_btc: Number(totalPositive) / 1e8,
  max_successful_positive_reward_raw: maxPositive.toString(),
  max_successful_positive_reward_btc: Number(maxPositive) / 1e8,
  top_positive_calls: sorted.slice(0, 10),
  most_recent_positive_calls: [...successfulPositive].sort((a, b) => b.block_height - a.block_height).slice(0, 10),
};

await mkdir('tests/security/evidence', { recursive: true });
await writeFile(EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n');
console.log(`LIVE_HBTC_POSITIVE_REWARD_EVIDENCE_FILE=${EVIDENCE_PATH}`);
console.log('LIVE_HBTC_POSITIVE_REWARD_HISTORY=' + JSON.stringify(evidence));

if (successfulPositive.length > 0) {
  console.log(`PASS HISTORICAL POSITIVE PNL: production controller-hbtc-v1 has ${successfulPositive.length} successful non-zero on-chain log-reward(..., true) calls. Largest recorded positive reward = ${maxPositive} sats (${Number(maxPositive) / 1e8} BTC). Positive PnL, which the force-funding High relies on, is therefore repeatedly production-reached rather than hypothetical.`);
} else {
  console.log('NO HISTORICAL NON-ZERO POSITIVE PNL FOUND in scanned production controller history. Do not claim production positive reward has already occurred.');
  process.exitCode = 2;
}
