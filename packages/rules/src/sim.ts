import { flagsFor, type Flag, type Terminal } from './audit.ts';
import { botInput, newBotMem, type BotMem } from './bot.ts';
import {
  ALL_PAYEES, APPROVALS, BUDGET, DISCUSS_TICKS, DRAIN_GOAL, DUTIES, DUTIES_EACH, FREEZE_CD, FREEZE_FIRST, FREEZE_RANGE, LIGHTS_CD,
  LIGHTS_FIRST, LIGHTS_TIME, MAX_SPENDS, NEW_VENDORS, PERSONAS, PLAY_LIMIT, REPORT_RANGE, REVEAL_TICKS, SESSION_EVERY, SKIM_CD,
  SKIM_FIRST, SKIM_MAX, SKIM_MIN, SKIM_PAYEES, SPEED, VENDORS, VISION, VISION_DARK, VOTE_TICKS, dutyDef, type DutyKind, type Trait,
} from './content.ts';
import { SEATS, dealInsider, sha256Hex, type Role } from './hash.ts';
import { SPAWNS, dist, free, roomAt, stationAt, type StationId } from './map.ts';
import { rng } from './rng.ts';

// The whole match as a deterministic state machine: step(state, inputs) once per tick (10 Hz).
// No Math.random, no Date, no DOM: the same setup and input log always give the same match, so the
// server's input log is a full replay (`replay()`), and anyone can re-run it.

export interface SeatSetup { name: string; persona?: string | null }
export interface Setup { matchId: string; seed: string; seats: SeatSetup[] }

export type Status = 'alive' | 'frozen' | 'ejected';
export interface Duty { kind: DutyKind; state: 'todo' | 'filed' | 'done'; proposal: number | null }
export interface Player {
  seat: number; name: string; persona: string | null; trait: Trait | null; role: Role;
  x: number; y: number; dir: number; moving: boolean;
  status: Status; reported: boolean; body: [number, number] | null;
  duties: Duty[];
  at: { station: StationId | null; since: number };
  cd: { freeze: number; skim: number; lights: number };
  bellUsed: boolean;
}
export interface Proposal {
  n: number; tick: number; terminal: Terminal; payee: string; amount: number; memo: string; flags: Flag[];
  /** secret until the end: who filed it, and whether it's a drain */
  filer: number; drain: boolean;
  votes: (boolean | null)[]; status: 'pending' | 'approved' | 'rejected'; closedTick: number | null;
}
export interface Ballot { eject: number; props: Record<string, boolean> }
export interface Tally { n: number; kind: MeetingKind; votes: (number | null)[]; counts: number[]; skip: number; ejected: number | null }
export type MeetingKind = 'report' | 'bell' | 'session';
export interface Meeting {
  n: number; kind: MeetingKind; by: number | null; body: number | null; phase: 'discuss' | 'vote' | 'reveal';
  start: number; phaseStart: number; until: number; ready: boolean[]; ballots: (Ballot | null)[]; tally: Tally | null;
}
export interface Input {
  mx?: number; my?: number;
  done?: DutyKind;
  vote?: { n: number; approve: boolean };
  freeze?: number;
  skim?: { payee: string; amount: number };
  lights?: boolean; fix?: boolean; report?: boolean; bell?: boolean;
  ready?: boolean; ballot?: Ballot;
  /** an AI council member takes over this seat (a player left) */
  takeover?: string;
}
export type Winner = 'crew' | 'insider';
export type Reason = 'ejected' | 'drained' | 'outnumbered' | 'duties' | 'closed';
export type SimEvent =
  | { t: 'filed'; n: number }
  | { t: 'voted'; n: number; seat: number; approve: boolean }
  | { t: 'resolved'; n: number; status: 'approved' | 'rejected' }
  | { t: 'frozen'; victim: number; x: number; y: number }
  | { t: 'meeting'; n: number; kind: MeetingKind; by: number | null; body: number | null }
  | { t: 'phase'; phase: 'discuss' | 'vote' | 'reveal' | 'play' }
  | { t: 'ballot'; seat: number }
  | { t: 'tally'; tally: Tally }
  | { t: 'lights'; out: boolean }
  | { t: 'duty'; seat: number; kind: DutyKind }
  | { t: 'over'; winner: Winner; reason: Reason };

export interface State {
  matchId: string; seed: string; tick: number; playTicks: number;
  phase: 'play' | 'meeting' | 'over';
  insider: number;
  players: Player[];
  proposals: Proposal[];
  treasury: number; drained: number; paid: number; filedTotal: number; lastFiled: number | null;
  meeting: Meeting | null; meetings: Tally[];
  lightsOut: boolean; lightsUntil: number; nextSession: number;
  winner: Winner | null; reason: Reason | null;
  rng: number;
  bots: (BotMem | null)[];
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const clampDir = (v: unknown): number => (v === 1 || v === -1 ? v : 0);

/** Seeded uniform [0,1) from the state's own stream (mulberry32). */
export function rand(s: State): number {
  s.rng = (s.rng + 0x6d2b79f5) >>> 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export const randInt = (s: State, lo: number, hi: number): number => lo + Math.floor(rand(s) * (hi - lo + 1));

export function createState(setup: Setup): State {
  if (setup.seats.length !== SEATS) throw new Error(`a council has ${SEATS} seats`);
  const insider = dealInsider(setup.matchId, setup.seed);
  const r = rng(`${setup.seed}|duties`);
  const players: Player[] = setup.seats.map((st, seat) => {
    const persona = st.persona ? PERSONAS.find((p) => p.id === st.persona) ?? null : null;
    // four duties from the seven, at least one away from the Vault; a crew member gets the invoice duty half the time
    const pool = DUTIES.map((d) => d.kind).filter((k) => k !== 'payroll');
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const kinds: DutyKind[] = r() < 0.6 ? ['payroll', ...pool.slice(0, DUTIES_EACH - 1)] : pool.slice(0, DUTIES_EACH);
    const [x, y] = SPAWNS[seat];
    return {
      seat, name: st.name.slice(0, 20) || `Seat ${seat + 1}`, persona: persona?.id ?? null, trait: persona?.trait ?? null,
      role: seat === insider ? 'insider' : 'crew', x, y, dir: 0, moving: false,
      status: 'alive', reported: false, body: null,
      duties: kinds.map((kind) => ({ kind, state: 'todo', proposal: null })),
      at: { station: null, since: 0 },
      cd: { freeze: FREEZE_FIRST, skim: SKIM_FIRST, lights: LIGHTS_FIRST },
      bellUsed: false,
    };
  });
  const s: State = {
    matchId: setup.matchId, seed: setup.seed, tick: 0, playTicks: 0, phase: 'play', insider, players,
    proposals: [], treasury: BUDGET, drained: 0, paid: 0, filedTotal: 0, lastFiled: null,
    meeting: null, meetings: [], lightsOut: false, lightsUntil: 0, nextSession: SESSION_EVERY,
    winner: null, reason: null, rng: 0, bots: [],
  };
  s.rng = Math.floor(r() * 4294967296) >>> 0;
  s.bots = players.map((p) => (p.persona ? newBotMem() : null));
  return s;
}

export const crewDuties = (s: State): { done: number; total: number } => {
  const crew = s.players.filter((p) => p.role === 'crew');
  return { done: crew.reduce((a, p) => a + p.duties.filter((d) => d.state === 'done').length, 0), total: crew.length * DUTIES_EACH };
};

function move(p: Player, inp: Input): void {
  const mx = clampDir(inp.mx), my = clampDir(inp.my);
  if (!mx && !my) { p.moving = false; return; }
  const len = Math.hypot(mx, my);
  const sp = p.status === 'alive' ? SPEED : SPEED * 1.15;
  const nx = round3(p.x + (mx / len) * sp);
  if (free(nx, p.y)) p.x = nx;
  const ny = round3(p.y + (my / len) * sp);
  if (free(p.x, ny)) p.y = ny;
  p.dir = mx > 0 ? 1 : mx < 0 ? 3 : my > 0 ? 2 : 0;
  p.moving = true;
}

/** Files a spend. Returns its number, or null if the policy refuses it (same rules as the contract). */
function file(s: State, filer: number, terminal: Terminal, payee: string, amount: number, drain: boolean, ev: SimEvent[]): number | null {
  if (!ALL_PAYEES.includes(payee)) return null;
  if (s.proposals.length >= MAX_SPENDS || s.filedTotal + amount > BUDGET) return null;
  const n = s.proposals.length;
  const flags = flagsFor(payee, amount, terminal, s.tick, s.lastFiled);
  s.proposals.push({
    n, tick: s.tick, terminal, payee, amount, memo: `Invoice #${1041 + n * 7}`, flags, filer, drain,
    votes: new Array(SEATS).fill(null), status: 'pending', closedTick: null,
  });
  s.lastFiled = s.tick;
  s.filedTotal += amount;
  ev.push({ t: 'filed', n });
  return n;
}

/** One council member's vote on a pending spend (what a desk sends to the DAO as act_proposal). */
export function castVote(s: State, seat: number, n: number, approve: boolean, ev: SimEvent[]): boolean {
  const p = s.players[seat];
  const pr = s.proposals[n];
  if (!p || p.status !== 'alive' || !pr || pr.status !== 'pending' || pr.votes[seat] !== null) return false;
  pr.votes[seat] = !!approve;
  ev.push({ t: 'voted', n, seat, approve: !!approve });
  const yes = pr.votes.filter((v) => v === true).length;
  const no = pr.votes.filter((v) => v === false).length;
  if (yes >= APPROVALS) {
    pr.status = 'approved';
    pr.closedTick = s.tick;
    s.treasury -= pr.amount;
    if (pr.drain) s.drained += pr.amount;
    else {
      s.paid += pr.amount;
      const d = s.players[pr.filer].duties.find((x) => x.proposal === n);
      if (d) d.state = 'done';
    }
    ev.push({ t: 'resolved', n, status: 'approved' });
  } else if (no >= APPROVALS) {
    pr.status = 'rejected';
    pr.closedTick = s.tick;
    const d = s.players[pr.filer].duties.find((x) => x.proposal === n);
    if (d) { d.state = 'todo'; d.proposal = null; }
    ev.push({ t: 'resolved', n, status: 'rejected' });
  }
  return true;
}

function doDuty(s: State, p: Player, kind: DutyKind, ev: SimEvent[]): void {
  const d = p.duties.find((x) => x.kind === kind && x.state === 'todo');
  if (!d) return;
  const def = dutyDef(kind);
  if (p.at.station !== def.station || s.tick - p.at.since < def.ticks) return;
  if (kind === 'payroll' && p.role === 'crew') {
    // an honest invoice: a vendor on file most of the time, a new one sometimes
    const r = rand(s);
    const pool = r < 0.65 ? VENDORS : NEW_VENDORS;
    const payee = pool[Math.floor(rand(s) * pool.length)];
    const n = file(s, p.seat, 'payroll', payee, randInt(s, 3, 6), false, ev);
    if (n === null) d.state = 'done';
    else { d.state = 'filed'; d.proposal = n; }
  } else d.state = 'done';
  ev.push({ t: 'duty', seat: p.seat, kind });
}

function startMeeting(s: State, kind: MeetingKind, by: number | null, body: number | null, ev: SimEvent[]): void {
  s.phase = 'meeting';
  const m: Meeting = {
    n: s.meetings.length, kind, by, body, phase: 'discuss', start: s.tick, phaseStart: s.tick, until: s.tick + DISCUSS_TICKS,
    ready: new Array(SEATS).fill(false), ballots: new Array(SEATS).fill(null), tally: null,
  };
  s.meeting = m;
  for (const p of s.players) {
    if (p.status === 'frozen') p.reported = true;
    if (p.status === 'alive') { [p.x, p.y] = SPAWNS[p.seat]; p.moving = false; p.at = { station: 'table', since: s.tick }; }
  }
  s.lightsOut = false;
  ev.push({ t: 'meeting', n: m.n, kind, by, body });
}

function cleanBallot(s: State, b: Ballot): Ballot {
  const eject = Number.isInteger(b?.eject) && b.eject >= 0 && b.eject < SEATS && s.players[b.eject].status === 'alive' ? b.eject : -1;
  const props: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(b?.props ?? {})) {
    const n = Number(k);
    if (Number.isInteger(n) && s.proposals[n]?.status === 'pending') props[String(n)] = !!v;
  }
  return { eject, props };
}

/** Eject tally exactly as the contract computes it from the openings: the unique top count, above skips. */
export function tallyVotes(votes: (number | null)[]): { counts: number[]; skip: number; ejected: number | null } {
  const counts = new Array(SEATS).fill(0);
  let skip = 0;
  for (const v of votes) {
    if (v === null) continue;
    if (v < 0) skip++;
    else counts[v]++;
  }
  const top = Math.max(...counts);
  const ejected = top > 0 && top > skip && counts.filter((c) => c === top).length === 1 ? counts.indexOf(top) : null;
  return { counts, skip, ejected };
}

function reveal(s: State, m: Meeting, ev: SimEvent[]): void {
  m.phase = 'reveal';
  m.phaseStart = s.tick;
  m.until = s.tick + REVEAL_TICKS;
  // the spends first, voter by voter (the same votes go to the DAO), then the ejection
  for (let seat = 0; seat < SEATS; seat++) {
    const b = m.ballots[seat];
    if (!b || s.players[seat].status !== 'alive') continue;
    for (const [k, v] of Object.entries(b.props)) castVote(s, seat, Number(k), v, ev);
  }
  const votes = m.ballots.map((b, seat) => (b && s.players[seat].status === 'alive' ? b.eject : null));
  const t = tallyVotes(votes);
  const tally: Tally = { n: m.n, kind: m.kind, votes, ...t };
  m.tally = tally;
  s.meetings.push(tally);
  if (t.ejected !== null) s.players[t.ejected].status = 'ejected';
  ev.push({ t: 'phase', phase: 'reveal' }, { t: 'tally', tally });
}

function checkWin(s: State, ev: SimEvent[]): void {
  if (s.phase === 'over') return;
  const ins = s.players[s.insider];
  const crewAlive = s.players.filter((p) => p.role === 'crew' && p.status === 'alive').length;
  const { done, total } = crewDuties(s);
  let w: [Winner, Reason] | null = null;
  if (ins.status === 'ejected') w = ['crew', 'ejected'];
  else if (s.drained >= DRAIN_GOAL) w = ['insider', 'drained'];
  else if (crewAlive <= 1) w = ['insider', 'outnumbered'];
  else if (done >= total) w = ['crew', 'duties'];
  else if (s.playTicks >= PLAY_LIMIT && s.phase === 'play') w = ['crew', 'closed'];
  if (!w) return;
  s.phase = 'over';
  s.meeting = null;
  [s.winner, s.reason] = w;
  ev.push({ t: 'over', winner: w[0], reason: w[1] });
}

export function step(s: State, inputs: (Input | undefined)[]): SimEvent[] {
  const ev: SimEvent[] = [];
  if (s.phase === 'over') return ev;
  s.tick++;
  inputs.forEach((inp, i) => {
    const p = s.players[i];
    const persona = inp?.takeover ? PERSONAS.find((x) => x.id === inp.takeover) : null;
    if (p && persona && !p.persona) { p.persona = persona.id; p.trait = persona.trait; s.bots[i] = newBotMem(); }
  });
  const ins: Input[] = s.players.map((p, i) => {
    const given = inputs[i];
    if (!p.persona) return given ?? {};
    const b = botInput(s, i);
    return given ? { ...b, ...given } : b;
  });

  if (s.phase === 'play') {
    s.playTicks++;
    let call: { kind: MeetingKind; by: number | null; body: number | null } | null = null;
    for (const p of s.players) {
      const inp = ins[p.seat];
      move(p, inp);
      const st = stationAt(p.x, p.y);
      if (st !== p.at.station) p.at = { station: st, since: s.tick };
      if (inp.done) doDuty(s, p, inp.done, ev);
      if (inp.vote && p.at.station === 'audit') castVote(s, p.seat, Number(inp.vote.n), !!inp.vote.approve, ev);
      if (p.status !== 'alive') continue;
      if (inp.fix && s.lightsOut && p.at.station === 'breaker') { s.lightsOut = false; ev.push({ t: 'lights', out: false }); }
      if (p.role === 'insider') {
        if (inp.freeze !== undefined && s.tick >= p.cd.freeze) {
          const v = s.players[inp.freeze];
          if (v && v.role === 'crew' && v.status === 'alive' && dist(p.x, p.y, v.x, v.y) <= FREEZE_RANGE) {
            v.status = 'frozen';
            v.body = [v.x, v.y];
            v.reported = false;
            v.moving = false;
            p.cd.freeze = s.tick + FREEZE_CD;
            ev.push({ t: 'frozen', victim: v.seat, x: v.x, y: v.y });
          }
        }
        if (inp.skim && s.tick >= p.cd.skim && (p.at.station === 'terminal' || p.at.station === 'payroll')) {
          const amount = Math.floor(Number(inp.skim.amount));
          if (SKIM_PAYEES.includes(inp.skim.payee) && amount >= SKIM_MIN && amount <= SKIM_MAX) {
            if (file(s, p.seat, p.at.station === 'terminal' ? 'vault' : 'payroll', inp.skim.payee, amount, true, ev) !== null) p.cd.skim = s.tick + SKIM_CD;
          }
        }
        if (inp.lights && s.tick >= p.cd.lights && !s.lightsOut) {
          s.lightsOut = true;
          s.lightsUntil = s.tick + LIGHTS_TIME;
          p.cd.lights = s.tick + LIGHTS_CD;
          ev.push({ t: 'lights', out: true });
        }
      }
      if (!call && inp.report) {
        const body = s.players.find((o) => o.status === 'frozen' && !o.reported && o.body && dist(p.x, p.y, o.body[0], o.body[1]) <= REPORT_RANGE);
        if (body) call = { kind: 'report', by: p.seat, body: body.seat };
      }
      if (!call && inp.bell && !p.bellUsed && p.at.station === 'table') { p.bellUsed = true; call = { kind: 'bell', by: p.seat, body: null }; }
    }
    if (s.lightsOut && s.tick >= s.lightsUntil) { s.lightsOut = false; ev.push({ t: 'lights', out: false }); }
    if (!call && s.tick >= s.nextSession) call = { kind: 'session', by: null, body: null };
    checkWin(s, ev);
    if (call && s.phase === 'play') startMeeting(s, call.kind, call.by, call.body, ev);
  } else if (s.phase === 'meeting' && s.meeting) {
    const m = s.meeting;
    for (const p of s.players) {
      if (p.status !== 'alive') continue;
      const inp = ins[p.seat];
      if (m.phase === 'discuss' && inp.ready) m.ready[p.seat] = true;
      if (m.phase === 'vote' && inp.ballot && !m.ballots[p.seat]) {
        m.ballots[p.seat] = cleanBallot(s, inp.ballot);
        ev.push({ t: 'ballot', seat: p.seat });
      }
    }
    const alive = s.players.filter((p) => p.status === 'alive');
    if (m.phase === 'discuss' && (s.tick >= m.until || alive.every((p) => p.persona || m.ready[p.seat]))) {
      m.phase = 'vote';
      m.phaseStart = s.tick;
      m.until = s.tick + VOTE_TICKS;
      ev.push({ t: 'phase', phase: 'vote' });
    } else if (m.phase === 'vote' && (s.tick >= m.until || alive.every((p) => m.ballots[p.seat]))) {
      reveal(s, m, ev);
    } else if (m.phase === 'reveal' && s.tick >= m.until) {
      s.phase = 'play';
      s.meeting = null;
      s.nextSession = s.tick + SESSION_EVERY;
      for (const p of s.players) {
        p.cd.freeze = Math.max(p.cd.freeze, s.tick + Math.floor(FREEZE_CD * 0.7));
        p.cd.skim = Math.max(p.cd.skim, s.tick + Math.floor(SKIM_CD * 0.5));
        p.cd.lights = Math.max(p.cd.lights, s.tick + Math.floor(LIGHTS_CD * 0.5));
      }
      ev.push({ t: 'phase', phase: 'play' });
    }
    checkWin(s, ev);
  }
  return ev;
}

// ---------- what each seat may see ----------

export interface SeenPlayer { seat: number; x: number; y: number; dir: number; moving: boolean; ghost: boolean }

export function canSee(s: State, viewer: Player, x: number, y: number): boolean {
  if (viewer.status !== 'alive' || s.phase === 'meeting') return true;
  const r = s.lightsOut && viewer.role === 'crew' ? VISION_DARK : VISION;
  const d = dist(viewer.x, viewer.y, x, y);
  if (d > r) return false;
  return roomAt(viewer.x, viewer.y) === roomAt(x, y) || d <= 2.5;
}

/** The players and bodies `seat` can see right now. Ghosts are invisible to the living. */
export function sight(s: State, seat: number): { players: SeenPlayer[]; bodies: { seat: number; x: number; y: number }[] } {
  const me = s.players[seat];
  const players: SeenPlayer[] = [];
  const bodies: { seat: number; x: number; y: number }[] = [];
  for (const o of s.players) {
    if (o.status === 'frozen' && o.body && !o.reported && canSee(s, me, o.body[0], o.body[1])) bodies.push({ seat: o.seat, x: o.body[0], y: o.body[1] });
    if (o.seat === seat) continue;
    const ghost = o.status !== 'alive';
    if (ghost && me.status === 'alive') continue;
    if (canSee(s, me, o.x, o.y)) players.push({ seat: o.seat, x: o.x, y: o.y, dir: o.dir, moving: o.moving, ghost });
  }
  return { players, bodies };
}

export interface PublicProposal {
  n: number; tick: number; terminal: Terminal; payee: string; amount: number; memo: string; flags: Flag[];
  votes: (boolean | null)[]; status: Proposal['status']; mine: boolean; drain?: boolean;
}

export function publicProposal(pr: Proposal, seat: number | null, over: boolean): PublicProposal {
  const out: PublicProposal = {
    n: pr.n, tick: pr.tick, terminal: pr.terminal, payee: pr.payee, amount: pr.amount, memo: pr.memo, flags: pr.flags,
    votes: pr.votes, status: pr.status, mine: seat !== null && pr.filer === seat,
  };
  // an approved drain is exposed when its money leaves (the payee never delivers); the filer stays sealed
  if (pr.status === 'approved' || over) out.drain = pr.drain;
  return out;
}

export function viewFor(s: State, seat: number) {
  const me = s.players[seat];
  const over = s.phase === 'over';
  const truth = over || me.status !== 'alive';
  const seen = sight(s, seat);
  const m = s.meeting;
  return {
    tick: s.tick,
    phase: s.phase,
    playLeft: Math.max(0, PLAY_LIMIT - s.playTicks),
    sessionIn: Math.max(0, s.nextSession - s.tick),
    you: {
      seat, role: me.role, status: me.status, x: me.x, y: me.y, dir: me.dir, at: me.at,
      duties: me.duties.map((d) => ({ kind: d.kind, state: d.state })),
      cd: me.role === 'insider' ? { freeze: Math.max(0, me.cd.freeze - s.tick), skim: Math.max(0, me.cd.skim - s.tick), lights: Math.max(0, me.cd.lights - s.tick) } : null,
      bellUsed: me.bellUsed,
    },
    roster: s.players.map((p) => ({
      seat: p.seat, name: p.name, persona: p.persona,
      status: truth || p.seat === seat ? p.status : p.status === 'ejected' || (p.status === 'frozen' && p.reported) ? p.status : 'alive',
    })),
    seen: seen.players,
    bodies: seen.bodies,
    proposals: s.proposals.map((pr) => publicProposal(pr, seat, over)),
    treasury: s.treasury,
    drained: s.proposals.filter((p) => p.status === 'approved' && p.drain).reduce((a, p) => a + p.amount, 0),
    paid: s.paid,
    filedTotal: s.filedTotal,
    duties: crewDuties(s),
    dark: s.lightsOut && me.role === 'crew' && me.status === 'alive',
    lightsOut: s.lightsOut,
    meeting: m && {
      n: m.n, kind: m.kind, by: m.by, body: m.body, phase: m.phase, until: m.until, start: m.start,
      ready: m.ready, voted: m.ballots.map((b) => !!b), myBallot: m.ballots[seat], tally: m.tally,
    },
    meetings: s.meetings,
    winner: s.winner,
    reason: s.reason,
    reveal: over ? { insider: s.insider, roles: s.players.map((p) => p.role) } : null,
  };
}
export type View = ReturnType<typeof viewFor>;

// ---------- replays ----------

export interface LogEntry { t: number; c: number; i: Input }

/** A short hash of everything that decides the match (not the bots' memory). */
export function stateHash(s: State): string {
  return sha256Hex(JSON.stringify({
    tick: s.tick, phase: s.phase, insider: s.insider, treasury: s.treasury, drained: s.drained, winner: s.winner, reason: s.reason,
    players: s.players.map((p) => [p.x, p.y, p.status, p.duties.map((d) => d.state)]),
    proposals: s.proposals.map((p) => [p.payee, p.amount, p.filer, p.drain, p.votes, p.status]),
    meetings: s.meetings,
  })).slice(0, 16);
}

/** Re-runs a match from its setup and input log. */
export function replay(setup: Setup, log: LogEntry[], untilTick?: number): State {
  const s = createState(setup);
  let k = 0;
  const end = untilTick ?? (log.length ? log[log.length - 1].t : 0) + 100_000;
  while (s.phase !== 'over' && s.tick < end) {
    const inputs: (Input | undefined)[] = new Array(SEATS).fill(undefined);
    while (k < log.length && log[k].t === s.tick + 1) { inputs[log[k].c] = log[k].i; k++; }
    step(s, inputs);
  }
  return s;
}
