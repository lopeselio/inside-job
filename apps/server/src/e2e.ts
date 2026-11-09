import { WebSocket } from 'ws';
import { roleCommit } from '@inside-job/rules';

// Plays one solo match the way the browser does, over the same WebSocket: sits down, checks its own
// sealed role against the commitment, hands its chair to the AI planner (so the match plays itself
// out), and waits for the settlement. Then prints every transaction.
//   pnpm e2e [baseUrl]

const base = process.argv[2] ?? 'http://localhost:8841';
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
const t0 = Date.now();
let matchId = '';
let lastPhase = '';
let chainOn = true;
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
console.log(`check it: pnpm verify ${matchId}${base === 'http://localhost:8841' ? '' : ` ${base}`}`);
ws.close();
