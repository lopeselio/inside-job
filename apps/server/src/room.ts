import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  DUTIES, PERSONAS, SEATS, SEAT_COLORS, SKIM_PAYEES, TICK_HZ, botBallot, createState, roleSalt, stateHash, step, viewFor,
  type Input, type SimEvent, type State,
} from '@inside-job/rules';
import { personaById, talk } from './agents.ts';
import { config, explorerTx } from './config.ts';
import { ChainMatch, newRecord } from './match.ts';
import { saveMatch, type MatchRecord } from './store.ts';

// Rooms. The server runs the sim at 10 Hz; each client sends inputs and gets only its own view:
// its own role, the players its seat can see, and public facts. Nobody but the Insider is ever told
// who froze someone or who filed a drain.

type Phase = 'lobby' | 'playing' | 'over';

interface Member {
  ws: WebSocket | null;
  token: string;
  name: string;
  account: string | null;
  ready: boolean;
  persona: string | null;
  inputs: Input[];
  sent: number;
  /** an AI is holding this human's chair */
  tookOver?: boolean;
}

const rooms = new Map<string, Room>();
const byMatch = new Map<string, Room>();
const send = (ws: WebSocket | null, msg: unknown): void => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

function code(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const c = Array.from(randomBytes(4), (b) => A[b % A.length]).join('');
    if (!rooms.has(c)) return c;
  }
}

/** Only the parts of an input a client may send. */
function clean(i: Partial<Input> | undefined): Input {
  const out: Input = {};
  if (!i || typeof i !== 'object') return out;
  if (i.mx === -1 || i.mx === 0 || i.mx === 1) out.mx = i.mx;
  if (i.my === -1 || i.my === 0 || i.my === 1) out.my = i.my;
  if (typeof i.done === 'string' && DUTIES.some((d) => d.kind === i.done)) out.done = i.done;
  if (i.vote && Number.isInteger(i.vote.n)) out.vote = { n: i.vote.n, approve: !!i.vote.approve };
  if (Number.isInteger(i.freeze)) out.freeze = i.freeze;
  if (i.skim && SKIM_PAYEES.includes(String(i.skim.payee)) && Number.isInteger(i.skim.amount)) out.skim = { payee: String(i.skim.payee), amount: i.skim.amount };
  for (const k of ['lights', 'fix', 'report', 'bell', 'ready'] as const) if (i[k]) out[k] = true;
  if (i.ballot && typeof i.ballot === 'object') {
    const props: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(i.ballot.props ?? {}).slice(0, 20)) props[String(Number(k))] = !!v;
    out.ballot = { eject: Number.isInteger(i.ballot.eject) ? i.ballot.eject : -1, props };
  }
  return out;
}

export class Room {
  readonly code = code();
  phase: Phase = 'lobby';
  members: Member[] = [];
  state: State | null = null;
  rec: MatchRecord | null = null;
  private chain: ChainMatch | null = null;
  private timer: NodeJS.Timeout | null = null;
  private picks = new Map<number, number | null>();
  private talking = new Set<number>();
  private replies = 0;
  private lastSent = '';

  constructor(readonly solo = false) { rooms.set(this.code, this); }

  static get(c: string): Room | undefined { return rooms.get(String(c).toUpperCase()); }
  static ofMatch(id: string): Room | undefined { return byMatch.get(id); }
  static open(): { code: string; players: number }[] {
    return [...rooms.values()].filter((r) => r.phase === 'lobby' && !r.solo).map((r) => ({ code: r.code, players: r.members.length }));
  }

  get hostIdx(): number { return this.members.findIndex((m) => !m.persona && m.ws); }
  seatOf(ws: WebSocket): number { return this.members.findIndex((m) => m.ws === ws); }

  join(ws: WebSocket, name: string, account: string | null): string {
    if (this.phase !== 'lobby') throw new Error('that match has already started');
    if (this.members.length >= SEATS) throw new Error('the council is full');
    if (account && this.members.some((m) => m.account === account)) throw new Error('you are already in this room');
    const token = randomBytes(16).toString('hex');
    this.members.push({ ws, token, name: name.trim().slice(0, 18) || 'Guest', account, ready: false, persona: null, inputs: [], sent: 0 });
    this.broadcastLobby();
    return token;
  }

  /** Back after a reload: the seat token proves it's you. A finished match can't be rejoined (its result
   *  stays at /api/match/<id>/proof and under "Recent nights"); the client then drops its ticket. */
  rejoin(ws: WebSocket, token: string): boolean {
    if (this.phase === 'over') return false;
    const m = this.members.find((x) => x.token === token && !x.persona);
    if (!m) return false;
    m.ws = ws;
    if (m.tookOver && this.phase === 'playing') { m.inputs.push({ release: true }); m.tookOver = false; }
    if (this.phase === 'lobby') this.broadcastLobby();
    else this.sendStart(this.members.indexOf(m));
    return true;
  }

  addAi(by: WebSocket): void {
    if (this.phase !== 'lobby' || this.seatOf(by) !== this.hostIdx || this.members.length >= SEATS) return;
    const used = new Set(this.members.map((m) => m.persona));
    const p = PERSONAS.find((x) => !used.has(x.id));
    if (!p) return;
    this.members.push({ ws: null, token: '', name: p.name, account: null, ready: true, persona: p.id, inputs: [], sent: 0 });
    this.broadcastLobby();
  }

  kick(by: WebSocket, seat: number): void {
    if (this.phase !== 'lobby' || this.seatOf(by) !== this.hostIdx || seat === this.hostIdx || !this.members[seat]) return;
    send(this.members[seat].ws, { t: 'kicked' });
    this.members.splice(seat, 1);
    this.broadcastLobby();
  }

  setReady(ws: WebSocket, ready: boolean): void {
    const i = this.seatOf(ws);
    if (i < 0 || this.phase !== 'lobby') return;
    this.members[i].ready = ready;
    this.broadcastLobby();
    if (this.members.filter((m) => !m.persona).every((m) => m.ready) && this.members.length >= 2) this.start();
  }

  /** The host starts now: empty chairs go to the AI council. */
  startNow(ws: WebSocket): void {
    if (this.seatOf(ws) === this.hostIdx) this.start();
  }

  leave(ws: WebSocket): void {
    const i = this.seatOf(ws);
    if (i < 0) return;
    const m = this.members[i];
    if (this.phase === 'lobby') this.members.splice(i, 1);
    else {
      m.ws = null;
      // mid-match: an AI council member takes the chair so the match stays fair for everyone else
      // (after a grace period, so a reload doesn't cost you your chair)
      setTimeout(() => {
        if (m.ws || this.phase !== 'playing' || !this.state || this.state.players[i].persona) return;
        const used = new Set(this.state.players.map((p) => p.persona));
        const p = PERSONAS.find((x) => !used.has(x.id));
        if (p) { m.inputs.push({ takeover: p.id }); m.tookOver = true; }
      }, 15_000).unref();
    }
    if (!this.members.some((x) => x.ws)) {
      // nobody left watching: an unfinished match plays itself out (so it settles); a lobby closes
      if (this.phase !== 'playing') this.close();
      return;
    }
    if (this.phase === 'lobby') this.broadcastLobby();
  }

  /** Hand this seat to an AI council member (the e2e test, or a player who wants to watch). */
  autopilot(ws: WebSocket): void {
    const i = this.seatOf(ws);
    const s = this.state;
    if (i < 0 || !s || this.phase !== 'playing' || s.players[i].persona) return;
    const used = new Set(s.players.map((p) => p.persona));
    const p = PERSONAS.find((x) => !used.has(x.id));
    if (p) this.members[i].inputs.push({ takeover: p.id });
  }

  input(ws: WebSocket, raw: Partial<Input>): void {
    const i = this.seatOf(ws);
    if (i < 0 || this.phase !== 'playing') return;
    const m = this.members[i];
    if (++m.sent > 12) return;
    m.inputs.push(clean(raw));
  }

  chat(ws: WebSocket, text: string): void {
    const i = this.seatOf(ws);
    const s = this.state;
    if (i < 0 || !s || !s.meeting || s.players[i].status !== 'alive' || !this.rec) return;
    const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!t) return;
    const entry = { seat: i, text: t, at: Date.now(), meeting: s.meeting.n };
    this.rec.chat.push(entry);
    this.broadcast({ t: 'chat', seat: i, text: t, signed: false, human: true });
    // someone answers back now and then
    if (this.replies < 3 && s.meeting.phase === 'discuss') {
      const named = s.players.find((p) => p.persona && p.status === 'alive' && t.toLowerCase().includes(p.name.toLowerCase()));
      const any = s.players.filter((p) => p.persona && p.status === 'alive');
      const who = named ?? any[Math.floor(Math.random() * any.length)];
      if (who) { this.replies++; void this.speak(who.seat); }
    }
  }

  private broadcast(msg: unknown): void { for (const m of this.members) send(m.ws, msg); }

  private broadcastLobby(): void {
    const seats = this.members.map((m) => ({ name: m.name, ai: !!m.persona, ready: m.ready, signedIn: !!m.account, here: !!m.ws || !!m.persona }));
    this.members.forEach((m, i) => send(m.ws, { t: 'lobby', code: this.code, seats, you: i, host: i === this.hostIdx }));
  }

  private start(): void {
    if (this.phase !== 'lobby') return;
    // fill the empty chairs with the AI council
    const used = new Set(this.members.map((m) => m.persona));
    for (const p of PERSONAS) {
      if (this.members.length >= SEATS) break;
      if (used.has(p.id)) continue;
      this.members.push({ ws: null, token: '', name: p.name, account: null, ready: true, persona: p.id, inputs: [], sent: 0 });
    }
    this.phase = 'playing';
    this.rec = newRecord(this.solo ? 'solo' : 'room', this.members.map((m) => ({
      kind: m.persona ? 'ai' : 'human', name: m.name, persona: m.persona ?? undefined, account: m.account ?? undefined,
      label: m.persona ? `ai:${m.persona}` : m.account ? `account:${m.account}` : `guest:${m.name}`.slice(0, 48),
    })));
    saveMatch(this.rec);
    byMatch.set(this.rec.id, this);
    this.state = createState(this.rec.setup);
    this.chain = new ChainMatch(this.rec, () => this.pushChain());
    this.members.forEach((_, i) => this.sendStart(i));
    this.loop();
  }

  /** Tells one seat its own role and the salt that opens its commitment (and nothing about anyone else's). */
  private sendStart(i: number): void {
    const m = this.members[i];
    const s = this.state;
    if (!m.ws || !s || !this.rec) return;
    send(m.ws, {
      t: 'start', matchId: this.rec.id, code: this.code, you: i, token: m.token,
      role: s.players[i].role, salt: roleSalt(this.rec.setup.seed, i), commits: this.rec.roleCommits, seedHash: this.rec.seedHash,
      seats: this.rec.seats.map((x, k) => ({ name: x.name, ai: x.kind === 'ai', persona: x.persona ?? null, desk: x.desk, color: SEAT_COLORS[k], signedIn: !!x.account })),
      contract: config.contract, dao: config.dao, chain: this.chain?.on ?? false,
    });
    if (s.phase === 'over') send(m.ws, this.results());
    else send(m.ws, { t: 'view', v: viewFor(s, i), ev: [] });
    for (const l of this.rec.lines) send(m.ws, { t: 'chat', seat: l.seat, text: l.text, signed: !!l.signature, human: false });
  }

  private loop(): void {
    let next = Date.now();
    const tick = (): void => {
      const s = this.state!;
      const inputs: (Input | undefined)[] = this.members.map((m) => {
        if (!m.inputs.length) return undefined;
        const merged = m.inputs.reduce<Input>((a, b) => ({ ...a, ...b }), {});
        m.inputs = [];
        return merged;
      });
      this.members.forEach((m, i) => { m.sent = 0; if (inputs[i]) this.rec!.log.push({ t: s.tick + 1, c: i, i: inputs[i]! }); });
      const ev = step(s, inputs);
      this.onEvents(ev);
      this.members.forEach((m, i) => {
        if (!m.ws) return;
        const mine = ev.filter((e) => this.visibleTo(e, i));
        send(m.ws, { t: 'view', v: viewFor(s, i), ev: mine });
      });
      if (s.phase === 'over') { this.finish(); return; }
      next += 1000 / TICK_HZ;
      this.timer = setTimeout(tick, Math.max(0, next - Date.now()));
    };
    tick();
  }

  /** Who may hear about an event. A freeze is news only to its victim and the Insider; a duty only to its doer. */
  private visibleTo(e: SimEvent, seat: number): boolean {
    const s = this.state!;
    if (e.t === 'frozen') return e.victim === seat || s.insider === seat;
    if (e.t === 'duty') return e.seat === seat;
    return true;
  }

  private onEvents(ev: SimEvent[]): void {
    const s = this.state!;
    for (const e of ev) {
      if (e.t === 'filed') this.chain!.file(s.proposals[e.n]);
      else if (e.t === 'voted') this.chain!.daoVote(e.seat, s.proposals[e.n], e.approve);
      else if (e.t === 'ballot') {
        // the match may already be over in this same tick (the meeting is gone, its tally stays)
        const live = s.meeting && s.meeting.n === e.n ? s.meeting.ballots[e.seat]?.eject : undefined;
        this.chain!.commitVote(e.n, e.seat, live ?? s.meetings.find((t) => t.n === e.n)?.votes[e.seat] ?? -1);
      }
      else if (e.t === 'tally') this.chain!.tally(e.tally.n, e.tally.votes, s.players.map((p, k) => p.status === 'alive' || e.tally.ejected === k));
      else if (e.t === 'meeting') this.meetingStarted();
      else if (e.t === 'phase' && e.phase === 'vote') this.aiBallots();
    }
  }

  private meetingStarted(): void {
    const s = this.state!;
    this.picks.clear();
    this.replies = 0;
    s.players.filter((p) => p.persona && p.status === 'alive').forEach((p, k) => {
      setTimeout(() => void this.speak(p.seat), 600 + k * 1400);
    });
  }

  private async speak(seat: number): Promise<void> {
    const s = this.state;
    if (!s || !s.meeting || this.talking.has(seat) || !this.rec) return;
    this.talking.add(seat);
    try {
      const chat = this.rec.chat.filter((c) => c.meeting === s.meeting!.n);
      const { line, pick } = await talk(s, seat, chat);
      if (!s.meeting) return;
      this.picks.set(seat, pick);
      this.rec.lines.push({ ...line, at: Date.now() });
      saveMatch(this.rec);
      this.broadcast({ t: 'chat', seat, text: line.text, signed: !!line.signature, human: false });
    } finally { this.talking.delete(seat); }
  }

  /** The AI members' ballots, decided by the planner (which may accept the model's suspect). Logged as their input. */
  private aiBallots(): void {
    const s = this.state!;
    s.players.forEach((p, i) => {
      if (!p.persona || p.status !== 'alive') return;
      const ballot = botBallot(structuredClone(s), i, this.picks.get(i) ?? null);
      this.members[i].inputs.push({ ballot });
    });
  }

  private pushChain(): void {
    if (!this.rec) return;
    this.broadcast({ t: 'chain', txs: this.rec.txs.map((x) => ({ ...x, url: explorerTx(x.hash) })), error: this.rec.chainError ?? null, settled: this.rec.settled, outcome: this.rec.settleOutcome ?? null });
  }

  private results(final = false): unknown {
    const s = this.state!;
    const r = this.rec!;
    return {
      t: 'results', matchId: r.id, winner: s.winner, reason: s.reason, insider: s.insider, seed: r.setup.seed,
      roles: s.players.map((p) => p.role), filers: s.proposals.map((p) => p.filer), drains: s.proposals.map((p) => p.drain),
      txs: r.txs.map((x) => ({ ...x, url: explorerTx(x.hash) })), settled: r.settled, error: r.chainError ?? null, outcome: r.settleOutcome ?? null,
      final: final || r.settled || !this.chain?.on,
    };
  }

  private finish(): void {
    const s = this.state!;
    const r = this.rec!;
    this.stop();
    this.phase = 'over';
    r.result = { winner: s.winner!, reason: s.reason!, insider: s.insider, tick: s.tick, stateHash: stateHash(s) };
    saveMatch(r);
    this.broadcast(this.results());
    void this.chain!.settle(s).then(() => { this.broadcast(this.results(true)); });
    setTimeout(() => this.close(), 15 * 60_000).unref();
  }

  private stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private close(): void {
    this.stop();
    rooms.delete(this.code);
    if (this.rec) byMatch.delete(this.rec.id);
  }
}

export const activeRooms = (): number => rooms.size;
export { personaById };
