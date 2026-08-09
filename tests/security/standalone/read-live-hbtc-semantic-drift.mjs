import fs from 'node:fs';
import crypto from 'node:crypto';

const API = 'https://api.hiro.so';
const DEPLOYER = 'SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CONTRACTS = [
  ['hq-v1', 'mainnet/contracts/hbtc/protocol/hq-v1.clar'],
  ['state-hbtc-v1', 'mainnet/contracts/hbtc/protocol/state-v1.clar'],
  ['blacklist-v1', 'mainnet/contracts/hbtc/protocol/blacklist-v1.clar'],
  ['token-hbtc', 'mainnet/contracts/hbtc/tokens/token-hbtc.clar'],
  ['reserve-hbtc-v1', 'mainnet/contracts/hbtc/protocol/reserve-v1.clar'],
  ['reserve-fund-hbtc-v1', 'mainnet/contracts/hbtc/protocol/reserve-fund-v1.clar'],
  ['fee-collector-hbtc-v1', 'mainnet/contracts/hbtc/protocol/fee-collector-v1.clar'],
  ['controller-hbtc-v1', 'mainnet/contracts/hbtc/protocol/controller-v1.clar'],
  ['trading-hbtc-v1', 'mainnet/contracts/hbtc/protocol/trading-v1.clar'],
  ['zest-interface-hbtc-v1', 'mainnet/contracts/hbtc/protocol/interfaces/zest-interface-v1.clar'],
  ['hermetica-interface-hbtc-v1', 'mainnet/contracts/hbtc/protocol/interfaces/hermetica-interface-v1.clar'],
  ['vault-hbtc-v1-2', 'mainnet/contracts/hbtc/protocol/vault-v1-2.clar'],
];

async function req(url) {
  let last;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : null;
    last = new Error(`${r.status} ${url}: ${text.slice(0, 1000)}`);
    if (r.status !== 429 && r.status < 500) throw last;
    const h = Number(r.headers.get('retry-after') ?? 0);
    const m = Number(text.match(/try again in\s+(\d+)\s+seconds?/i)?.[1] ?? 0);
    const wait = Math.max(h, m, Math.min(60, 2 ** i), 2);
    console.log(`HIRO_RATE_LIMIT retry=${i + 1} wait=${wait}s`);
    await sleep(wait * 1000);
  }
  throw last;
}

function stripComments(src) {
  return src.replace(/;;.*$/gm, '');
}
function names(src, kind) {
  const re = new RegExp(`\\(define-${kind}\\s+\\(([^\\s()]+)`, 'g');
  return [...stripComments(src).matchAll(re)].map(m => m[1]).sort();
}
function simpleNames(src, form) {
  const re = new RegExp(`\\(define-${form}\\s+([^\\s()]+)`, 'g');
  return [...stripComments(src).matchAll(re)].map(m => m[1]).sort();
}
function sensitiveCalls(src) {
  const s = stripComments(src);
  const patterns = [
    /check-is-[a-z0-9-]+/g,
    /check-[a-z0-9-]*auth/g,
    /update-state/g,
    /increment-claim-id/g,
    /mint-for-protocol/g,
    /burn-for-protocol/g,
    /\breserve\s+transfer\b/g,
    /\.reserve(?:-hbtc-v1)?\s+transfer/g,
    /reserve-fund[^\n()]*transfer/g,
    /fund-claim(?:-many)?/g,
    /log-reward/g,
    /settle-pending/g,
  ];
  const out = [];
  for (const p of patterns) out.push(...(s.match(p) ?? []));
  return out.sort();
}
function fingerprint(src) {
  return {
    public: names(src, 'public'),
    read_only: names(src, 'read-only'),
    private: names(src, 'private'),
    data_vars: simpleNames(src, 'data-var'),
    maps: simpleNames(src, 'map'),
    constants: simpleNames(src, 'constant'),
    sensitive_calls: sensitiveCalls(src),
  };
}
function diffSet(a, b) {
  const A = new Set(a), B = new Set(b);
  return { only_local: [...A].filter(x => !B.has(x)), only_live: [...B].filter(x => !A.has(x)) };
}
function compareFingerprints(local, live) {
  const keys = ['public','read_only','private','data_vars','maps','constants','sensitive_calls'];
  return Object.fromEntries(keys.map(k => [k, diffSet(local[k], live[k])]));
}
function hasDiff(d) {
  return Object.values(d).some(x => x.only_local.length || x.only_live.length);
}
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

const ALIASES = [
  ['.reserve-fund', '.reserve-fund-hbtc-v1'],
  ['.fee-collector', '.fee-collector-hbtc-v1'],
  ['.hermetica-interface', '.hermetica-interface-hbtc-v1'],
  ['.zest-interface', '.zest-interface-hbtc-v1'],
  ['.controller-hbtc', '.controller-hbtc-v1'],
  ['.hq-hbtc', '.hq-v1'],
  ['.state', '.state-hbtc-v1'],
  ['.blacklist', '.blacklist-v1'],
  ['.reserve', '.reserve-hbtc-v1'],
];

function canonicalExecutableSource(src, isLocal) {
  let s = stripComments(src)
    .replace(/^\s*\(use-trait[^\n]*$/gm, '')
    .replace(/^\s*\(impl-trait[^\n]*$/gm, '');
  if (isLocal) {
    for (const [from, to] of ALIASES) s = s.split(from).join(to);
  }
  // Deployment can rename trait-only contracts while executable behavior remains identical.
  // We already compare all callable functions/state/auth separately, so strip declaration-only trait lines above.
  return s.replace(/\s+/g, ' ').trim();
}

const results = [];
for (const [liveName, localPath] of CONTRACTS) {
  const localSource = fs.readFileSync(localPath, 'utf8');
  const j = await req(`${API}/v2/contracts/source/${DEPLOYER}/${liveName}`);
  const liveSource = j?.source ?? j?.source_code ?? '';
  if (!liveSource) throw new Error(`empty live source for ${liveName}`);
  const localFp = fingerprint(localSource);
  const liveFp = fingerprint(liveSource);
  const semanticDiff = compareFingerprints(localFp, liveFp);
  const localCanonical = canonicalExecutableSource(localSource, true);
  const liveCanonical = canonicalExecutableSource(liveSource, false);
  results.push({
    live_contract: `${DEPLOYER}.${liveName}`,
    local_path: localPath,
    live_source_sha256: sha(liveSource),
    local_source_sha256: sha(localSource),
    exact_source_match: liveSource === localSource,
    canonical_executable_local_sha256: sha(localCanonical),
    canonical_executable_live_sha256: sha(liveCanonical),
    canonical_executable_match: localCanonical === liveCanonical,
    semantic_diff: semanticDiff,
    semantic_drift_detected: hasDiff(semanticDiff),
    local_fingerprint: localFp,
    live_fingerprint: liveFp,
  });
  console.log(`SEMANTIC_DRIFT ${liveName}=${hasDiff(semanticDiff)} FULL_CANONICAL_MATCH=${localCanonical === liveCanonical}`);
  await sleep(180);
}

const drift = results.filter(r => r.semantic_drift_detected || !r.canonical_executable_match);
const evidence = {
  observed_at: new Date().toISOString(),
  methodology: 'Read-only Hiro deployed-source fetch versus checked-out repository. Full executable source is canonicalized for known deployment aliases; function/state/auth fingerprints are compared independently.',
  results,
  contracts_with_semantic_or_body_drift: drift.map(r => r.live_contract),
};
fs.mkdirSync('tests/security/evidence', { recursive: true });
fs.writeFileSync('tests/security/evidence/live-hbtc-semantic-drift.json', JSON.stringify(evidence, null, 2));
console.log('LIVE_HBTC_SEMANTIC_DRIFT=' + JSON.stringify({contracts_with_semantic_or_body_drift:evidence.contracts_with_semantic_or_body_drift, count:drift.length}));
