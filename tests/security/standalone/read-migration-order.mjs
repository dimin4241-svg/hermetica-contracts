const API = 'https://api.hiro.so';
const DEPLOYER = 'SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG';
const HQ = `${DEPLOYER}.hq-v1`;
const OLD = `${DEPLOYER}.staking-v1`;
const NEW = `${DEPLOYER}.staking-v1-1`;
const RESERVE = `${DEPLOYER}.staking-reserve-v1`;
const MIGRATION_TX = '0xe318c9b37fe0cc13d45fbc2aff5fe75b309e6fea4f8840589d65ee4a159a3d1a';
const FIRST_INBOUND = [
  '0x92cc00165499346343a2ba765e5d36c7cbc44101fc71ec5f1a788e02a274cc49',
  '0xa99d01e0d3044423f428320b3f02dde4ee1cf4e0027f3c9fb5e5015579faf554',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, attempt = 0) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await r.text();
  if (r.status === 429 && attempt < 8) {
    const wait = Math.min(20000, 1000 * 2 ** attempt);
    console.log(`RATE_LIMIT ${wait}ms ${url}`);
    await sleep(wait);
    return get(url, attempt + 1);
  }
  if (!r.ok) throw new Error(`${r.status} ${url}: ${text.slice(0,1200)}`);
  await sleep(300);
  return JSON.parse(text);
}

function compactTx(tx) {
  const cc = tx.contract_call;
  return {
    tx_id: tx.tx_id,
    block_height: tx.block_height,
    block_time_iso: tx.block_time_iso,
    burn_block_height: tx.burn_block_height,
    sender_address: tx.sender_address,
    tx_status: tx.tx_status,
    tx_type: tx.tx_type,
    contract_id: cc?.contract_id,
    function_name: cc?.function_name,
    function_args: (cc?.function_args || []).map((x) => ({ name: x.name, repr: x.repr })),
    tx_result: tx.tx_result?.repr,
    events: (tx.events || []).map((e) => ({
      event_type: e.event_type,
      event_index: e.event_index,
      asset: e.asset,
      contract_log: e.contract_log,
    })),
  };
}

const exact = [];
for (const id of [MIGRATION_TX, ...FIRST_INBOUND]) {
  const tx = await get(`${API}/extended/v1/tx/${id}`);
  const c = compactTx(tx);
  exact.push(c);
  console.log('EXACT_TX=' + JSON.stringify(c));
}

async function principalTxs(principal, until = 3568200) {
  const j = await get(`${API}/extended/v1/address/${encodeURIComponent(principal)}/transactions?limit=50&offset=0&until_block=${until}`);
  return (j.results || []).map(compactTx).filter((x) => x.block_height >= 3567000);
}

for (const principal of [HQ, OLD, NEW, RESERVE]) {
  try {
    const txs = await principalTxs(principal);
    console.log('PRINCIPAL_TXS=' + JSON.stringify({ principal, txs }));
  } catch (e) {
    console.log('PRINCIPAL_TXS_ERROR=' + JSON.stringify({ principal, error: String(e) }));
  }
}

// The owner/admin that performs migration may not be DEPLOYER. Search the HQ
// principal transaction list for calls that change old/new staking status.
try {
  const hqTxs = await principalTxs(HQ, 3568200);
  const roleOps = hqTxs.filter((x) =>
    x.contract_id === HQ &&
    ['request-minting-contract-update','activate-minting-contract','remove-minting-contract','set-contract-active'].includes(x.function_name)
  );
  console.log('HQ_ROLE_OPS=' + JSON.stringify(roleOps));
} catch (e) {
  console.log('HQ_ROLE_OPS_ERROR=' + String(e));
}

console.log('ORDER_SUMMARY=' + JSON.stringify({ exact }));
