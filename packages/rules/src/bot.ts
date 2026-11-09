import { SKIM_PAYEES, SHELLS, LOOKALIKES, dutyDef, FREEZE_RANGE, REPORT_RANGE } from './content.ts';
import { STATIONS, dist, path, roomAt, standTiles, stationById, type RoomId, type StationId } from './map.ts';
import { rand, randInt, sight, type Ballot, type Input, type Proposal, type State } from './sim.ts';

// The AI council members' planner. It runs inside the sim (seeded, so a match replays exactly) and it
// plays fair: it only uses what its own seat could see (sight()), public facts (proposals, votes,
// meetings), and its own role. A crew bot does not know who the Insider is; it builds suspicion
// from its own sightings. The language model never touches any of this: it only talks, and may name
// a suspect, which botBallot() accepts only if the planner's own suspicion backs it.

export interface Sighting { seat: number; tick: number; x: number; y: number; room: RoomId | null }
export interface BotMem {
  path: [number, number][];
  goal: StationId | null;
  arrived: number;
  lastX: number; lastY: number; stuck: number;
  sightings: Sighting[];
  sus: number[];
  seenProps: number;
  seenResolved: number[];
  seenMeetings: number;
  bodiesSeen: number[];
  ballotDelay: number;
  hunt: number | null;
}

export const newBotMem = (): BotMem => ({
  path: [], goal: null, arrived: -1, lastX: 0, lastY: 0, stuck: 0, sightings: [], sus: [0, 0, 0, 0, 0],
  seenProps: 0, seenResolved: [], seenMeetings: 0, bodiesSeen: [], ballotDelay: 25, hunt: null,
});

const stands = new Map<StationId, [number, number][]>();
const standOf = (id: StationId): [number, number][] => {
  let s = stands.get(id);
  if (!s) { s = standTiles(id); stands.set(id, s); }
  return s;
};
const ROOM_OF_TERMINAL = { vault: 'vault', payroll: 'payroll' } as const;

function goTo(s: State, seat: number, mem: BotMem, goal: StationId): Input {
  const p = s.players[seat];
  const here: [number, number] = [Math.floor(p.x), Math.floor(p.y)];
  if (mem.goal !== goal) { mem.goal = goal; mem.path = []; mem.arrived = -1; }
  if (p.at.station === goal) {
    // settle on the tile centre so we don't jitter at the edge of reach
    if (mem.arrived < 0) mem.arrived = s.tick;
    return {};
  }
  mem.arrived = -1;
  if (!mem.path.length || mem.stuck > 12) {
    mem.path = path(here, goal === 'table' ? standOf('table') : standOf(goal));
    mem.stuck = 0;
  }
  return follow(p.x, p.y, mem);
}

function follow(x: number, y: number, mem: BotMem): Input {
  while (mem.path.length) {
    const [tx, ty] = mem.path[0];
    const dx = tx + 0.5 - x, dy = ty + 0.5 - y;
    if (Math.abs(dx) < 0.16 && Math.abs(dy) < 0.16) { mem.path.shift(); continue; }
    return { mx: Math.abs(dx) >= 0.16 ? Math.sign(dx) : 0, my: Math.abs(dy) >= 0.16 ? Math.sign(dy) : 0 };
  }
  return {};
}

function chase(s: State, seat: number, mem: BotMem, x: number, y: number): Input {
  const p = s.players[seat];
  if (!mem.path.length || mem.stuck > 8 || s.tick % 10 === 0) {
    mem.path = path([Math.floor(p.x), Math.floor(p.y)], [[Math.floor(x), Math.floor(y)]]);
    mem.goal = null;
    mem.stuck = 0;
  }
  return follow(p.x, p.y, mem);
}

/** Update a bot's memory from what it can see and from public facts. */
function observe(s: State, seat: number, mem: BotMem): void {
  const me = s.players[seat];
  if (Math.abs(me.x - mem.lastX) + Math.abs(me.y - mem.lastY) < 0.01) mem.stuck++;
  else mem.stuck = 0;
  mem.lastX = me.x; mem.lastY = me.y;
  const seen = sight(s, seat);
  if (s.tick % 5 === 0 && s.phase === 'play') {
    for (const o of seen.players) if (!o.ghost) mem.sightings.push({ seat: o.seat, tick: s.tick, x: o.x, y: o.y, room: roomAt(o.x, o.y) });
    if (mem.sightings.length > 400) mem.sightings.splice(0, mem.sightings.length - 400);
  }
  if (me.role === 'insider') return;
  const bump = (who: number, by: number): void => { if (who !== seat && s.players[who].status === 'alive') mem.sus[who] += by; };
  const near = (x: number, y: number, r: number, t0: number, t1: number): number[] =>
    [...new Set(mem.sightings.filter((g) => g.tick >= t0 && g.tick <= t1 && dist(g.x, g.y, x, y) <= r).map((g) => g.seat))];
  // a body I can see: whoever I saw near that spot lately is suspect
  for (const b of seen.bodies) {
    if (mem.bodiesSeen.includes(b.seat)) continue;
    mem.bodiesSeen.push(b.seat);
    for (const w of near(b.x, b.y, 3.5, s.tick - 120, s.tick)) bump(w, 2.5);
  }
  // a body someone else reported (its spot is announced in the meeting)
  if (s.meeting && s.meeting.body !== null && !mem.bodiesSeen.includes(s.meeting.body)) {
    const v = s.players[s.meeting.body];
    mem.bodiesSeen.push(v.seat);
    if (v.body) for (const w of near(v.body[0], v.body[1], 3, s.tick - 150, s.tick)) bump(w, 2);
  }
  // a new spend: who did I see at that terminal when it was filed?
  while (mem.seenProps < s.proposals.length) {
    const pr = s.proposals[mem.seenProps++];
    if (pr.filer === seat) continue;
    const st = stationById(pr.terminal === 'vault' ? 'terminal' : 'payroll');
    const loud = pr.flags.includes('lookalike') || pr.flags.includes('vault_terminal') || pr.flags.includes('over_cap');
    for (const w of near(st.x + 0.5, st.y + 0.5, 2.2, pr.tick - 20, pr.tick + 10)) bump(w, loud ? 3 : 0.3);
    for (const w of mem.sightings.filter((g) => g.room === ROOM_OF_TERMINAL[pr.terminal] && Math.abs(g.tick - pr.tick) <= 40).map((g) => g.seat)) bump(w, loud ? 0.5 : 0);
  }
  // public votes (they're onchain): approving a loud spend is a tell, approving what turned out to be a drain more so
  for (const pr of s.proposals) {
    if (pr.status === 'pending' || mem.seenResolved.includes(pr.n)) continue;
    mem.seenResolved.push(pr.n);
    const loud = pr.flags.includes('lookalike') || pr.flags.includes('vault_terminal') || pr.flags.includes('over_cap');
    const w = (loud ? 1.2 : 0) + (pr.status === 'approved' && pr.drain ? 1.4 : 0);
    if (w > 0) pr.votes.forEach((v, who) => { if (v === true && pr.filer !== seat) bump(who, me.trait === 'careful' ? w * 1.3 : w); });
  }
}

/** How a council member votes on one spend. */
export function judge(s: State, seat: number, pr: Proposal): boolean {
  const me = s.players[seat];
  const r = rand(s);
  if (me.role === 'insider') return pr.filer === seat ? true : r < 0.75;
  if (pr.filer === seat) return true;
  const trait = me.trait ?? 'steady';
  const mem = s.bots[seat];
  const f = pr.flags;
  let reject = 0.05;
  if (f.includes('lookalike')) reject = Math.max(reject, trait === 'careful' ? 0.97 : trait === 'steady' ? 0.85 : 0.5);
  if (f.includes('vault_terminal') || f.includes('over_cap')) reject = Math.max(reject, trait === 'careful' ? 0.9 : trait === 'steady' ? 0.75 : 0.45);
  if (f.includes('new_payee') && reject < 0.3) reject = trait === 'careless' ? 0.15 : 0.3;
  if (f.includes('burst')) reject = Math.min(0.99, reject + 0.15);
  // did I see someone I already suspect at that terminal when it was filed?
  if (mem) {
    const st = stationById(pr.terminal === 'vault' ? 'terminal' : 'payroll');
    const there = mem.sightings.filter((g) => Math.abs(g.tick - pr.tick) <= 20 && dist(g.x, g.y, st.x + 0.5, st.y + 0.5) <= 2.2);
    if (there.some((g) => mem.sus[g.seat] >= 3)) reject = Math.max(reject, 0.9);
  }
  return r >= reject;
}

function topSuspect(s: State, seat: number): number | null {
  const mem = s.bots[seat];
  if (!mem) return null;
  let best: number | null = null;
  for (let k = 0; k < mem.sus.length; k++) {
    if (k === seat || s.players[k].status !== 'alive') continue;
    if (best === null || mem.sus[k] > mem.sus[best]) best = k;
  }
  return best;
}

/**
 * A bot's ballot. `pick` is the suspect the language model named (or null). The planner keeps the last
 * word: a crew bot only follows the model if its own suspicion of that seat is at least 1; an Insider bot
 * follows any legal pick (it's lying anyway). Otherwise the planner's own choice stands.
 */
export function botBallot(s: State, seat: number, pick: number | null): Ballot {
  const me = s.players[seat];
  const mem = s.bots[seat];
  const props: Record<string, boolean> = {};
  for (const pr of s.proposals) if (pr.status === 'pending' && pr.votes[seat] === null) props[String(pr.n)] = judge(s, seat, pr);
  const legal = (k: number | null): k is number => k !== null && Number.isInteger(k) && k >= 0 && k < 5 && k !== seat && s.players[k].status === 'alive';
  let eject = -1;
  if (me.role === 'insider') {
    if (legal(pick)) eject = pick;
    else {
      // pile onto whoever the last meeting voted against most, else a random crew member half the time
      const last = s.meetings[s.meetings.length - 1];
      const heat = last ? last.counts.map((c, k) => (legal(k) ? c : -1)) : [];
      const top = heat.length ? heat.indexOf(Math.max(...heat)) : -1;
      if (top >= 0 && heat[top] > 0) eject = top;
      else if (rand(s) < 0.5) {
        const crew = s.players.filter((p) => legal(p.seat)).map((p) => p.seat);
        if (crew.length) eject = crew[Math.floor(rand(s) * crew.length)];
      }
    }
  } else if (mem) {
    const top = topSuspect(s, seat);
    if (legal(pick) && mem.sus[pick] >= 1) eject = pick;
    else if (top !== null && mem.sus[top] >= 3 && mem.sus.every((v, k) => k === top || k === seat || s.players[k].status !== 'alive' || mem.sus[top] - v >= 1)) eject = top;
  }
  return { eject, props };
}

/** The planner's suspicion of each seat, for the model's prompt (only what this bot itself knows). */
export function botNotes(s: State, seat: number): { sus: number[]; recent: Sighting[] } {
  const mem = s.bots[seat];
  return { sus: mem ? mem.sus.map((v) => Math.round(v * 10) / 10) : [0, 0, 0, 0, 0], recent: mem ? mem.sightings.slice(-60) : [] };
}

export function botInput(s: State, seat: number): Input {
  const p = s.players[seat];
  const mem = s.bots[seat];
  if (!mem || s.phase === 'over') return {};
  observe(s, seat, mem);

  if (s.phase === 'meeting' && s.meeting) {
    const m = s.meeting;
    if (p.status === 'alive' && m.phase === 'vote' && !m.ballots[seat] && s.tick >= m.phaseStart + mem.ballotDelay) return { ballot: botBallot(s, seat, null) };
    return {};
  }

  const seen = sight(s, seat);
  const insider = p.role === 'insider';

  // ghosts finish their duties and nothing else
  if (p.status !== 'alive') return dutyStep(s, seat, mem) ?? {};

  if (insider) {
    const crewSeen = seen.players.filter((o) => !o.ghost && s.players[o.seat].role === 'crew');
    if (s.tick >= p.cd.freeze && crewSeen.length === 1 && s.playTicks > 400 && roomAt(crewSeen[0].x, crewSeen[0].y) !== 'hall') {
      const v = crewSeen[0];
      if (dist(p.x, p.y, v.x, v.y) <= FREEZE_RANGE - 0.1) { mem.hunt = null; mem.path = []; return { freeze: v.seat }; }
      if (dist(p.x, p.y, v.x, v.y) < 5) { mem.hunt = v.seat; return chase(s, seat, mem, v.x, v.y); }
    }
    mem.hunt = null;
    if (s.tick >= p.cd.lights && !s.lightsOut && rand(s) < 0.004) return { lights: true };
    if (s.tick >= p.cd.skim && s.filedTotal < 90) {
      const at = p.at.station;
      if ((at === 'payroll' || at === 'terminal') && crewSeen.length === 0) {
        const lookalike = rand(s) < (at === 'terminal' ? 0.4 : 0.15);
        const pool = lookalike ? LOOKALIKES : SHELLS;
        const payee = pool[Math.floor(rand(s) * pool.length)];
        const amount = at === 'payroll' ? randInt(s, 5, 8) : randInt(s, 6, 12);
        if (SKIM_PAYEES.includes(payee)) return { skim: { payee, amount } };
      }
      const target: StationId = (Math.floor(s.tick / 600) + seat) % 4 === 0 ? 'terminal' : 'payroll';
      return goTo(s, seat, mem, target);
    }
    const audit = auditStep(s, seat, mem, 3);
    if (audit) return audit;
    return dutyStep(s, seat, mem) ?? wander(s, seat, mem);
  }

  // crew: report a body, fix the lights, ring the bell on a strong suspicion, audit, duties
  for (const b of seen.bodies) {
    if (dist(p.x, p.y, b.x, b.y) <= REPORT_RANGE - 0.2) return { report: true };
    return chase(s, seat, mem, b.x, b.y);
  }
  if (s.lightsOut) {
    const fixer = s.players.filter((o) => o.role !== 'insider' && o.status === 'alive' && o.persona).sort((a, b) =>
      dist(a.x, a.y, 20.5, 2.5) - dist(b.x, b.y, 20.5, 2.5))[0];
    if (fixer?.seat === seat) {
      if (p.at.station === 'breaker') return { fix: true };
      return goTo(s, seat, mem, 'breaker');
    }
  }
  const top = topSuspect(s, seat);
  if (!p.bellUsed && top !== null && mem.sus[top] >= 6.5 && s.nextSession - s.tick > 250) {
    if (p.at.station === 'table') return { bell: true };
    return goTo(s, seat, mem, 'table');
  }
  const audit = auditStep(s, seat, mem, 2);
  if (audit) return audit;
  return dutyStep(s, seat, mem) ?? auditStep(s, seat, mem, 1) ?? wander(s, seat, mem);
}

/** Go to the Audit desk and vote on open spends once `minOpen` of them wait for this seat's vote. */
function auditStep(s: State, seat: number, mem: BotMem, minOpen: number): Input | null {
  const open = s.proposals.filter((pr) => pr.status === 'pending' && pr.votes[seat] === null && s.tick - pr.tick > 60);
  if (open.length < minOpen) return null;
  const p = s.players[seat];
  if (p.at.station === 'audit') {
    if (s.tick - p.at.since < 15) return {};
    const pr = open[0];
    return { vote: { n: pr.n, approve: judge(s, seat, pr) } };
  }
  return goTo(s, seat, mem, 'audit');
}

function dutyStep(s: State, seat: number, mem: BotMem): Input | null {
  const p = s.players[seat];
  const d = p.duties.find((x) => x.state === 'todo');
  if (!d) return null;
  const def = dutyDef(d.kind);
  const step = goTo(s, seat, mem, def.station);
  if (p.at.station === def.station && s.tick - p.at.since >= def.ticks + 25 + (seat * 7) % 17) return { done: d.kind };
  return step;
}

function wander(s: State, seat: number, mem: BotMem): Input {
  const p = s.players[seat];
  if (!mem.goal || (p.at.station === mem.goal && mem.arrived >= 0 && s.tick - mem.arrived > 40)) {
    const options = STATIONS.map((x) => x.id).filter((x) => x !== mem.goal);
    mem.goal = options[Math.floor(rand(s) * options.length)];
    mem.path = [];
  }
  return goTo(s, seat, mem, mem.goal);
}
