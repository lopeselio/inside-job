import {
  dealCommits, dealInsider, filerCommit, flagsFor, replay, seedHash, stateHash, voteCommit,
  type LogEntry, type Proposal, type Setup, type Tally,
} from '@inside-job/rules';

// Re-checks a finished match without trusting the game server:
//   pnpm verify <matchId> [baseUrl]
// It fetches the proof bundle from the server, then reads the contract and the Sputnik DAO itself
// over public RPC, and checks: the seed against its committed hash; every role commitment; a full
// replay of the input log; every spend in the contract's audit log against the replay and its sealed
// filer; every sealed vote against its commitment and the contract's tally; every council vote on the
// DAO against the replay; and the outcome the contract recorded.

const [id, base = 'http://localhost:8841'] = process.argv.slice(2);
if (!id) { console.error('usage: pnpm verify <matchId> [baseUrl]'); process.exit(2); }

let failed = 0;
const ok = (s: string): void => console.log(`✓ ${s}`);
const bad = (s: string): void => { failed++; console.log(`✗ ${s}`); };

interface Bundle {
  id: string; contract: string; dao: string; over: boolean; setup: Setup; seedHash: string; roleCommits: string[]; log: LogEntry[];
  result: { winner: string; reason: string; insider: number; tick: number; stateHash: string } | null;
  proposals: (Proposal & { filerSalt: string | null; daoId: number | null })[];
  meetings: (Tally & { salts: (string | null)[] | null })[];
  lines: { who: string; text: string; signature?: string; signingAddress?: string }[];
  error?: string;
}
interface ChainSpend { tick: number; terminal: string; payee: string; amount: number; flags: string[]; filer_commit: string; dao_id: number | null; status: string }
interface ChainMatch {
  seed_hash: string; role_commits: string[]; spends: ChainSpend[];
  meetings: { commits: (string | null)[]; votes: (number | null)[] | null; ejected: number | null }[];
  outcome: { winner: string; reason: string; insider: number; drained: number; seed: string; filers: number[]; disputed: boolean } | null;
}

const bundle = (await (await fetch(`${base}/api/match/${id}/proof`)).json()) as Bundle;
if (bundle.error) { console.log(`✗ ${bundle.error}`); process.exit(1); }

const RPCS = ['https://rpc.testnet.fastnear.com', 'https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs'];
async function viewOn<T>(account: string, method: string, args: object): Promise<T> {
  for (const rpc of RPCS) {
    try {
      const r = (await (await fetch(rpc, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
      })).json()) as { result?: { result: number[] } };
      if (r.result) return JSON.parse(Buffer.from(r.result.result).toString('utf8')) as T;
    } catch { /* next RPC */ }
  }
  throw new Error(`could not read ${method} from ${account}`);
}

const cm = await viewOn<ChainMatch | null>(bundle.contract, 'get_match', { match_id: id });
if (!cm) { console.log(`✗ the contract has no match ${id}`); process.exit(1); }
const seed = bundle.setup.seed;

// 1. the seed and the sealed roles
if (seedHash(seed) === cm.seed_hash) ok(`seed matches the hash committed at create_match (${bundle.contract})`);
else bad('the seed does not match the committed hash');
const insider = dealInsider(id, seed);
if (JSON.stringify(dealCommits(id, seed)) === JSON.stringify(cm.role_commits)) ok(`all 5 sealed roles open; the seed deals the Insider to seat ${insider + 1} (${bundle.setup.seats[insider].name})`);
else bad('the role commitments onchain do not open from the seed');

// 2. the replay
const s = replay(bundle.setup, bundle.log, bundle.result?.tick);
if (bundle.result && stateHash(s) === bundle.result.stateHash && s.winner === bundle.result.winner && s.reason === bundle.result.reason) {
  ok(`replaying ${bundle.log.length} logged inputs reaches the recorded end: ${s.winner} win by ${s.reason} at ${(s.tick / 10).toFixed(0)} s`);
} else bad(`the replay ends differently (${s.winner} by ${s.reason}, hash ${stateHash(s)} vs ${bundle.result?.stateHash})`);

// 3. the audit log and the sealed filers
let spendsOk = cm.spends.length > 0 || s.proposals.length === 0;
let last: number | null = null;
cm.spends.forEach((c, n) => {
  const p = s.proposals[n];
  const salt = bundle.proposals[n]?.filerSalt;
  const flags = p ? flagsFor(p.payee, p.amount, p.terminal, p.tick, last) : [];
  last = c.tick;
  if (!p || p.payee !== c.payee || p.amount !== c.amount || p.terminal !== c.terminal || JSON.stringify(flags) !== JSON.stringify(c.flags)) { spendsOk = false; bad(`spend #${n} in the audit log differs from the replay`); return; }
  if (!salt || filerCommit(id, n, p.filer, salt) !== c.filer_commit) { spendsOk = false; bad(`spend #${n}: the filer opening does not match its seal`); }
});
if (spendsOk) {
  const drains = s.proposals.filter((p) => p.drain).length;
  ok(`all ${cm.spends.length} spends in the audit log match the replay, flags included; every sealed filer opens (${drains} filed by the Insider)`);
}
if (cm.spends.length < s.proposals.length) console.log(`· ${s.proposals.length - cm.spends.length} spend(s) never reached the contract`);

// 4. the sealed votes
let votesOk = true;
let opened = 0;
cm.meetings.forEach((cmt, n) => {
  const t = s.meetings[n];
  const salts = bundle.meetings[n]?.salts ?? [];
  if (!t || !cmt.votes) { votesOk = false; bad(`meeting ${n + 1} was not tallied onchain`); return; }
  cmt.commits.forEach((c, seat) => {
    if (!c) return;
    const choice = cmt.votes![seat];
    if (choice === null || !salts[seat] || voteCommit(id, n, seat, choice, salts[seat]!) !== c || t.votes[seat] !== choice) { votesOk = false; bad(`meeting ${n + 1}: seat ${seat + 1}'s vote doesn't open or differs from the replay`); }
    else opened++;
  });
  if (cmt.ejected !== t.ejected) { votesOk = false; bad(`meeting ${n + 1}: the contract ejected ${cmt.ejected}, the replay ${t.ejected}`); }
});
if (votesOk) ok(`${opened} sealed eject votes open to what was cast; the contract's ${cm.meetings.length} tallies match the replay (${s.meetings.filter((t) => t.ejected !== null).map((t) => `seat ${t.ejected! + 1} ejected`).join(', ') || 'no ejections'})`);
if (cm.meetings.length < s.meetings.length) bad(`${s.meetings.length - cm.meetings.length} meeting(s) never reached the contract`);

// 5. the DAO
const desks = (await viewOn<{ desks: string[] }>(bundle.contract, 'get_policy', {})).desks;
let daoOk = true;
let daoVotes = 0;
const STATUS: Record<string, string> = { approved: 'Approved', rejected: 'Rejected', pending: 'InProgress' };
for (const [n, c] of cm.spends.entries()) {
  if (c.dao_id === null) continue;
  const dp = await viewOn<{ status: string; votes: Record<string, string> }>(bundle.dao, 'get_proposal', { id: c.dao_id });
  const p = s.proposals[n];
  const want = p.votes.map((v, seat) => (v === null ? null : [desks[seat], v ? 'Approve' : 'Reject'])).filter((x): x is [string, string] => !!x);
  const same = want.length === Object.keys(dp.votes).length && want.every(([a, v]) => dp.votes[a] === v);
  const status = dp.status === 'Expired' && p.status === 'pending' ? 'InProgress' : dp.status;
  if (!same || status !== STATUS[p.status]) { daoOk = false; bad(`DAO proposal ${c.dao_id} (spend #${n}): ${dp.status} ${JSON.stringify(dp.votes)}, replay ${p.status}`); }
  daoVotes += want.length;
}
if (daoOk) ok(`the Sputnik DAO (${bundle.dao}) holds the same ${daoVotes} council votes and statuses as the replay`);

// 6. the outcome
const o = cm.outcome;
const drained = s.proposals.filter((p) => p.drain && p.status === 'approved').reduce((a, p) => a + p.amount, 0);
if (!o) bad('the contract has not settled the match');
else if (o.insider !== insider || o.drained !== drained || o.winner !== s.winner || o.reason !== s.reason) bad(`the contract recorded ${o.winner} by ${o.reason} (drained ${o.drained}), the replay ${s.winner} by ${s.reason} (drained ${drained})`);
else ok(`the contract settled it: ${o.winner} win by ${o.reason}, Insider seat ${o.insider + 1}, ${o.drained} credits drained${o.disputed ? ' (disputed)' : ''}`);

const signed = bundle.lines.filter((l) => l.signature).length;
if (bundle.lines.length) console.log(`· ${bundle.lines.length} AI lines in the bundle, ${signed} signed by the NEAR AI TEE (request, response and signature included)`);
process.exit(failed ? 1 : 0);
