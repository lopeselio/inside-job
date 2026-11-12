import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Account, KeyPair, KeyPairSigner, actions, type KeyPairString } from 'near-api-js';
import { Near } from 'near-kit';
import { roleCommit } from '@inside-job/rules';
import { explorerTx } from './config.ts';
import { provider, viewOn } from './chain.ts';

// Plays one solo match the way the browser does, over the same WebSocket: sits down, checks its own
// sealed role against the commitment, hands its chair to the AI planner (so the match plays itself
// out), and waits for the settlement. Then prints every transaction.
//   pnpm e2e [--host <url>] [--signed-in]   (default: a local server, http://localhost:8841; `pnpm e2e <url>` works too)
//
// --signed-in plays as a signed-in player instead of a guest, the way a wallet does it: a fresh testnet
// account (faucet, or 0.05 NEAR from the contract account if the faucet is busy) signs "Sign in to <host>"
// (NEP-413, Better Auth + better-near-auth), sits down with the session cookie, and claims its seat with a
// NEP-366 meta-transaction the game's relayer pays for (claim_seat). After the settlement the account's row
// on the contract's ledger (stats_of) is printed.

const argv = process.argv.slice(2);
const hostAt = argv.findIndex((a) => a === '--host' || a.startsWith('--host='));
const base = ((hostAt >= 0 ? (argv[hostAt].includes('=') ? argv[hostAt].slice('--host='.length) : argv[hostAt + 1]) : argv.find((a) => /^https?:/.test(a))) ?? 'http://localhost:8841').replace(/\/+$/, '');
const signedIn = argv.includes('--signed-in');
const CONTRACT = process.env.CONTRACT_ID ?? 'inside-job.testnet';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------- the signed-in player (a wallet stand-in) ----------
const credFile = (a: string): string => join(homedir(), '.near-credentials', 'testnet', `${a}.json`);
async function testAccount(): Promise<{ id: string; key: KeyPairString }> {
  const stamp = Date.now().toString(36);
  const id = `ij-e2e-${stamp}.testnet`;
  try {
    execFileSync('near', ['account', 'create-account', 'sponsor-by-faucet-service', id, 'autogenerate-new-keypair', 'save-to-legacy-keychain', 'network-config', 'testnet', 'create'], { stdio: 'ignore' });
    return { id, key: JSON.parse(readFileSync(credFile(id), 'utf8')).private_key as KeyPairString };
  } catch {
    // the faucet is busy: a sub-account of the contract account (which the running server never signs with)
    const fk = JSON.parse(readFileSync(credFile(CONTRACT), 'utf8')).private_key as KeyPairString;
    const kp = KeyPair.fromRandom('ed25519');
    const sub = `e2e-${stamp}.${CONTRACT}`;
    await new Account(CONTRACT, provider, KeyPairSigner.fromSecretKey(fk)).signAndSendTransaction({
      receiverId: sub, actions: [actions.createAccount(), actions.transfer(50_000_000_000_000_000_000_000n), actions.addFullAccessKey(kp.getPublicKey())], waitUntil: 'EXECUTED_OPTIMISTIC',
    });
    writeFileSync(credFile(sub), JSON.stringify({ account_id: sub, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
    return { id: sub, key: kp.toString() as KeyPairString };
  }
}
/** sha256 of the NEP-413 payload a wallet signs (what better-near-auth verifies). */
function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Buffer {
  const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const str = (t: string): Buffer => { const e = Buffer.from(t, 'utf8'); return Buffer.concat([u32(e.length), e]); };
  return createHash('sha256').update(Buffer.concat([u32(2 ** 31 + 413), str(message), nonce, str(recipient), Buffer.from([0])])).digest();
}
let cookie = '';
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin: new URL(base).origin, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const j = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(`${path}: ${j.error ?? j.message ?? res.status}`);
  return j;
}
let player: { id: string; key: KeyPairString } | null = null;
let claim: ((matchId: string, seat: number) => Promise<string>) | null = null;
if (signedIn) {
  player = await testAccount();
  console.log(`player ${player.id} (a fresh testnet account standing in for a wallet)`);
  await sleep(3000);
  const host = new URL(base).host;
  const message = `Sign in to ${host}`;
  const { nonce } = await api<{ nonce: string }>('/ba/near/nonce', { accountId: player.id, networkId: 'testnet' });
  const kp = KeyPair.fromString(player.key);
  const sig = kp.sign(nep413Hash(message, Buffer.from(nonce, 'hex'), host));
  await api('/ba/near/verify', { signedMessage: { accountId: player.id, publicKey: kp.getPublicKey().toString(), signature: Buffer.from(sig.signature).toString('base64') }, message, recipient: host, nonce, accountId: player.id });
  console.log(`signed in (NEP-413 "${message}"); the server sees ${(await api<{ accountId: string | null }>('/me')).accountId}`);
  const kit = new Near({ network: 'testnet', privateKey: player.key as `ed25519:${string}`, defaultSignerId: player.id });
  const me = player.id;
  claim = async (matchId, seat) => {
    const { payload } = await kit.transaction(me).functionCall(CONTRACT, 'claim_seat', { match_id: matchId, seat }, { gas: '50 Tgas', attachedDeposit: '0 yocto' }).delegate();
    const r = await api<{ txHash: string }>('/ba/near/relay', { payload });
    for (let k = 0; k < 30; k++) {
      const st = await api<{ status: string }>(`/ba/near/relay-status/${r.txHash}`);
      if (st.status === 'completed') return r.txHash;
      if (st.status === 'failed') throw new Error(`claim_seat relay failed (${r.txHash})`);
      await sleep(1500);
    }
    return r.txHash;
  };
}

const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, cookie ? { headers: { cookie, origin: new URL(base).origin } } : undefined);
const t0 = Date.now();
let matchId = '';
let lastPhase = '';
let chainOn = true;
let mySeat = -1;
let claimed: Promise<string> | null = null;
const log = (s: string): void => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s  ${s}`);

await new Promise<void>((resolve, reject) => {
  ws.on('open', () => ws.send(JSON.stringify({ t: 'solo', name: 'E2E' })));
  ws.on('error', reject);
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.t === 'error') { reject(new Error(m.message)); return; }
    if (m.t === 'start') {
      matchId = m.matchId;
      chainOn = m.chain;
      mySeat = m.you;
      if (player && !m.seats[m.you]?.signedIn) { reject(new Error('the server did not seat me as signed in')); return; }
      const ok = roleCommit(m.matchId, m.you, m.role, m.salt) === m.commits[m.you];
      log(`match ${m.matchId}: seat ${m.you + 1}, role ${m.role}; my role ${ok ? 'opens' : 'DOES NOT open'} my sealed commitment`);
      if (!ok) { reject(new Error('role commitment mismatch')); return; }
      ws.send(JSON.stringify({ t: 'autopilot' }));
    }
    if (m.t === 'view') {
      const v = m.v;
      const ph = v.meeting ? `meeting ${v.meeting.n + 1} (${v.meeting.kind}) ${v.meeting.phase}` : v.phase;
      if (ph !== lastPhase) { lastPhase = ph; log(`${ph}; treasury ${v.treasury}, duties ${v.duties.done}/${v.duties.total}, spends ${v.proposals.length}`); }
      for (const e of m.ev) if (e.t === 'tally') log(`  tally: ${e.tally.votes.map((x: number | null) => (x === null ? '·' : x < 0 ? 'skip' : `#${x + 1}`)).join(' ')} → ${e.tally.ejected === null ? 'nobody' : `seat ${e.tally.ejected + 1} ejected`}`);
    }
    // the seat can be claimed once create_match has put this account on it
    if (m.t === 'chain' && claim && !claimed && (m.txs as { what: string }[]).some((t) => t.what === 'create_match')) {
      claimed = claim(matchId, mySeat);
      claimed.then((tx) => log(`claim_seat (gasless, NEP-366 through the relayer) ${explorerTx(tx)}`), (e: Error) => log(`claim_seat failed: ${e.message}`));
    }
    if (m.t === 'chat' && !m.human) log(`  seat ${m.seat + 1}: ${m.text}${m.signed ? '  [signed by NEAR AI TEE]' : ''}`);
    if (m.t === 'results') {
      if (!m.final) { log(`over: ${m.winner} by ${m.reason} (Insider: seat ${m.insider + 1}); waiting for the settlement…`); return; }
      log(`over: ${m.winner} by ${m.reason} (Insider: seat ${m.insider + 1})`);
      if (chainOn) log(`settled onchain: ${JSON.stringify(m.outcome)}`);
      if (m.error) log(`chain warning: ${m.error}`);
      for (const t of m.txs) console.log(`  ${t.what.padEnd(40)} ${t.url}`);
      resolve();
    }
  });
});
if (player) {
  const tx = await (claimed as Promise<string> | null)?.catch(() => null);
  if (tx) console.log(`  ${'claim_seat (player, gasless)'.padEnd(40)} ${explorerTx(tx)}`);
  const stats = await viewOn<Record<string, number>>(CONTRACT, 'stats_of', { account_id: player.id }).catch(() => null);
  console.log(`the ledger (stats_of ${player.id}): ${JSON.stringify(stats)}`);
}
console.log(`check it: pnpm verify ${matchId}${base.replace(/\/+$/, '') === 'https://inside-job.lopeselio.online' ? '' : ` --host ${base}`}`);
ws.close();
