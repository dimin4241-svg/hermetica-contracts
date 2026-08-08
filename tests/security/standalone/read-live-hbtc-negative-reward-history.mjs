const API = 'https://api.hiro.so';
const HBTC = 'SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const CONTROLLER = `${HBTC}.controller-hbtc-v1`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, retries = 6) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      const text = await r.text();
      if (r.ok) return text ? JSON.parse(text) : null;
      last = new Error(`${r.status} ${url}: ${text.slice(0, 500)}`);
      if (r.status !== 429 && r.status < 500) throw last;
    } catch (e) {
      last = e;
    }
    await sleep(1500 * (i + 1));
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

const successful = logs.filter(x => x.status === 'success');
const negative = successful.filter(x => x.is_positive === false);
const positive = successful.filter(x => x.is_positive === true);
const failed = logs.filter(x => x.status !== 'success');

const totalNegative = negative.reduce((a, x) => a + BigInt(x.reward_raw), 0n);
const maxNegative = negative.reduce((m, x) => BigInt(x.reward_raw) > m ? BigInt(x.reward_raw) : m, 0n);

const evidence = {
  observed_at: new Date().toISOString(),
  controller: CONTROLLER,
  scanned_address_transactions: txs.length,
  log_reward_calls: logs.length,
  successful_log_reward_calls: successful.length,
  successful_positive_calls: positive.length,
  successful_negative_calls: negative.length,
  failed_log_reward_calls: failed.length,
  total_successful_negative_reward_raw: totalNegative.toString(),
  total_successful_negative_reward_btc: Number(totalNegative) / 1e8,
  max_successful_negative_reward_raw: maxNegative.toString(),
  max_successful_negative_reward_btc: Number(maxNegative) / 1e8,
  negative_calls: negative,
  failed_calls: failed,
};

console.log('LIVE_HBTC_NEGATIVE_REWARD_HISTORY=' + JSON.stringify(evidence));

if (negative.length > 0) {
  console.log(`PASS HISTORICAL NEGATIVE PNL: production controller-hbtc-v1 has ${negative.length} successful on-chain log-reward(..., false) calls. Largest recorded negative reward = ${maxNegative} sats (${Number(maxNegative) / 1e8} BTC). The adverse accounting branch required by the stale-NAV exploit is therefore historically production-reached, not merely theoretical.`);
} else {
  console.log('NO HISTORICAL NEGATIVE PNL FOUND in the scanned controller transaction history. Do not claim production negative log-reward has already occurred.');
}
