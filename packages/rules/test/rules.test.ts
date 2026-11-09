import { describe, expect, it } from 'vitest';
import {
  ALL_PAYEES, BUDGET, DRAIN_GOAL, PERSONAS, SEATS, SPAWNS, STATIONS, VENDORS, NEW_VENDORS, SHELLS, LOOKALIKES,
  botBallot, castVote, createState, dealCommits, dealInsider, editDistance, filerCommit, flagsFor, free, path, replay, roleCommit, roleSalt,
  seedHash, sha256Hex, sight, standTiles, stateHash, step, tallyVotes, viewFor, voteCommit,
  type Input, type LogEntry, type Setup, type State,
} from '../src/index.ts';

const SEED = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

const aiSetup = (i: number): Setup => ({ matchId: `t-${i}`, seed: sha256Hex(`t|${i}`), seats: PERSONAS.map((p) => ({ name: p.name, persona: p.id })) });
const humanSetup = (seed = SEED): Setup => ({ matchId: 'm-test', seed, seats: Array.from({ length: SEATS }, (_, i) => ({ name: `P${i}` })) });

function run(s: State, ticks: number, inputs: (Input | undefined)[] = []): void {
  for (let i = 0; i < ticks && s.phase !== 'over'; i++) step(s, inputs);
}

describe('commitments (shared vector with contracts/council)', () => {
  it('matches the vector pinned in the Rust tests', () => {
    expect(seedHash(SEED)).toBe('7fed753ebdfff80d0923fa4bf4b98cae2922dd5600015d116ca27cbba5d66463');
    expect(dealInsider('m-vector', SEED)).toBe(3);
    expect(roleSalt(SEED, 2)).toBe('8b6d6be415e4f9ee6fb22fad1aa411adfcc767a3fd65c1d7307911f2494ccd0d');
    expect(roleCommit('m-vector', 2, 'crew', roleSalt(SEED, 2))).toBe('cba84cceda91bcf5fe0dd77cfeb5b5f3ed62f17c8effb731a742af51c0c248cb');
    expect(voteCommit('m-vector', 1, 3, -1, 'ab'.repeat(32))).toBe('3e4d38d651893572aa9dcd287f485949052d4d9d912d7b3c22162374e24fc23b');
    expect(voteCommit('m-vector', 1, 3, 4, 'ab'.repeat(32))).toBe('80f667c07857fc8ea4212612a6dee0831b3e092f1569df290ce0b7cf365ccaba');
    expect(filerCommit('m-vector', 0, 4, 'cd'.repeat(32))).toBe('2b9c2b82e8bf056b1cfa4f36154c08ad190471ce52c88f6a9426e0f125038008');
  });
  it('deals exactly one Insider, the one the seed fixes', () => {
    const commits = dealCommits('m-vector', SEED);
    const insider = dealInsider('m-vector', SEED);
    for (let s = 0; s < SEATS; s++) expect(commits[s]).toBe(roleCommit('m-vector', s, s === insider ? 'insider' : 'crew', roleSalt(SEED, s)));
    expect(createState({ ...humanSetup(), matchId: 'm-vector' }).insider).toBe(insider);
  });
  it('a different seed gives different, unlinkable commitments', () => {
    const a = dealCommits('m', SEED);
    const b = dealCommits('m', sha256Hex('other'));
    expect(a.some((x, i) => x === b[i])).toBe(false);
  });
});

describe('the office', () => {
  it('every spawn is free and every station can be reached from the council room', () => {
    for (const [x, y] of SPAWNS) expect(free(x, y)).toBe(true);
    for (const st of STATIONS) {
      expect(standTiles(st.id).length).toBeGreaterThan(0);
      expect(path([16, 12], standTiles(st.id)).length).toBeGreaterThan(0);
    }
  });
});

describe('the audit flags', () => {
  it('flags lookalikes, new payees, big amounts, the vault terminal and bursts', () => {
    for (const v of VENDORS) expect(flagsFor(v, 5, 'payroll', 100, null)).toEqual([]);
    for (const v of NEW_VENDORS) expect(flagsFor(v, 5, 'payroll', 100, null)).toEqual(['new_payee']);
    for (const v of SHELLS) expect(flagsFor(v, 5, 'payroll', 100, null)).toEqual(['new_payee']);
    for (const v of LOOKALIKES) expect(flagsFor(v, 5, 'payroll', 100, null)).toEqual(['lookalike', 'new_payee']);
    expect(flagsFor('lumen-power', 9, 'vault', 300, 150)).toEqual(['over_cap', 'vault_terminal', 'burst']);
    expect(flagsFor('lumen-power', 9, 'vault', 400, 150)).toEqual(['over_cap', 'vault_terminal']);
    expect(editDistance('quill-legal', 'quil-legal')).toBe(1);
    expect(ALL_PAYEES.length).toBe(16);
  });
});

describe('treasury votes (the same rule as the Sputnik DAO: 3 of 5)', () => {
  it('executes on the third approval and counts drains', () => {
    const s = createState(humanSetup());
    s.proposals.push({ n: 0, tick: 1, terminal: 'payroll', payee: 'velvet-ops', amount: 9, memo: 'x', flags: ['new_payee'], filer: s.insider, drain: true, votes: [null, null, null, null, null], status: 'pending', closedTick: null });
    const ev: never[] = [];
    expect(castVote(s, 0, 0, true, ev)).toBe(true);
    expect(castVote(s, 0, 0, false, ev)).toBe(false);
    castVote(s, 1, 0, true, ev);
    expect(s.proposals[0].status).toBe('pending');
    castVote(s, 2, 0, true, ev);
    expect(s.proposals[0].status).toBe('approved');
    expect(s.treasury).toBe(BUDGET - 9);
    expect(s.drained).toBe(9);
    expect(castVote(s, 3, 0, false, ev)).toBe(false);
  });
  it('a rejected invoice reopens the filer’s duty', () => {
    const s = createState(humanSetup());
    const crew = s.players.find((p) => p.role === 'crew')!;
    crew.duties[0] = { kind: 'payroll', state: 'filed', proposal: 0 };
    s.proposals.push({ n: 0, tick: 1, terminal: 'payroll', payee: 'lumen-power', amount: 4, memo: 'x', flags: [], filer: crew.seat, drain: false, votes: [null, null, null, null, null], status: 'pending', closedTick: null });
    for (const k of [0, 1, 2]) castVote(s, k, 0, false, []);
    expect(s.proposals[0].status).toBe('rejected');
    expect(crew.duties[0]).toEqual({ kind: 'payroll', state: 'todo', proposal: null });
  });
});

describe('meetings', () => {
  it('ejects only a unique top count above the skips', () => {
    expect(tallyVotes([1, 1, 2, -1, null]).ejected).toBe(1);
    expect(tallyVotes([1, 1, 2, 2, -1]).ejected).toBe(null);
    expect(tallyVotes([1, -1, -1, 3, null]).ejected).toBe(null);
    expect(tallyVotes([null, null, null, null, null]).ejected).toBe(null);
  });
  it('ejecting the Insider wins for the crew', () => {
    const s = createState(humanSetup());
    s.tick = s.nextSession - 1;
    run(s, 1);
    expect(s.phase).toBe('meeting');
    run(s, 1, s.players.map(() => ({ ready: true })));
    expect(s.meeting?.phase).toBe('vote');
    run(s, 1, s.players.map(() => ({ ballot: { eject: s.insider, props: {} } })));
    expect(s.phase).toBe('over');
    expect([s.winner, s.reason]).toEqual(['crew', 'ejected']);
  });
});

describe('the Insider', () => {
  it('can only freeze a crew member in reach, after the cooldown', () => {
    const s = createState(humanSetup());
    const ins = s.players[s.insider];
    const v = s.players.find((p) => p.role === 'crew')!;
    v.x = ins.x + 1; v.y = ins.y; // may not be free but freeze only checks distance
    const inputs: Input[] = [];
    inputs[ins.seat] = { freeze: v.seat };
    run(s, 1, inputs);
    expect(v.status).toBe('alive');
    s.tick = ins.cd.freeze;
    v.x = ins.x + 1; v.y = ins.y;
    run(s, 1, inputs);
    expect(v.status).toBe('frozen');
    // crew can't freeze
    const c2 = s.players.find((p) => p.role === 'crew' && p.status === 'alive')!;
    const other = s.players.find((p) => p.role === 'crew' && p.status === 'alive' && p.seat !== c2.seat)!;
    other.x = c2.x + 0.5; other.y = c2.y;
    const in2: Input[] = [];
    in2[c2.seat] = { freeze: other.seat };
    run(s, 1, in2);
    expect(other.status).toBe('alive');
  });
  it('skims only from the vault terminal or payroll desk, to a skim payee, within the policy', () => {
    const s = createState(humanSetup());
    const ins = s.players[s.insider];
    s.tick = ins.cd.skim;
    const at = (x: number, y: number): void => { ins.x = x; ins.y = y; ins.at = { station: null, since: 0 }; };
    const inputs: Input[] = [];
    at(28.5, 14.5); // next to the payroll desk
    inputs[ins.seat] = { skim: { payee: 'lumen-power', amount: 6 } };
    run(s, 1, inputs);
    expect(s.proposals.length).toBe(0);
    inputs[ins.seat] = { skim: { payee: 'velvet-ops', amount: 40 } };
    run(s, 1, inputs);
    expect(s.proposals.length).toBe(0);
    inputs[ins.seat] = { skim: { payee: 'velvet-ops', amount: 7 } };
    run(s, 1, inputs);
    expect(s.proposals.length).toBe(1);
    expect(s.proposals[0]).toMatchObject({ terminal: 'payroll', drain: true, filer: ins.seat, flags: ['new_payee'] });
  });
});

describe('what each seat sees', () => {
  it('hides who filed and whether a pending spend is a drain, and the Insider from the crew', () => {
    const s = createState(humanSetup());
    s.proposals.push({ n: 0, tick: 1, terminal: 'vault', payee: 'quil-legal', amount: 9, memo: 'x', flags: ['lookalike'], filer: s.insider, drain: true, votes: [null, null, null, null, null], status: 'pending', closedTick: null });
    const crew = s.players.find((p) => p.role === 'crew')!;
    const v = viewFor(s, crew.seat);
    expect(v.proposals[0].drain).toBeUndefined();
    expect(v.proposals[0].mine).toBe(false);
    expect(v.reveal).toBeNull();
    expect(JSON.stringify(v)).not.toContain('"insider"');
    expect(viewFor(s, s.insider).proposals[0].mine).toBe(true);
  });
  it('ghosts are invisible to the living, and an unreported body looks alive on the roster', () => {
    const s = createState(humanSetup());
    const crew = s.players.filter((p) => p.role === 'crew');
    crew[0].status = 'frozen';
    crew[0].body = [crew[0].x, crew[0].y];
    const seen = sight(s, crew[1].seat);
    expect(seen.players.some((o) => o.seat === crew[0].seat)).toBe(false);
    expect(seen.bodies.some((b) => b.seat === crew[0].seat)).toBe(true);
    expect(viewFor(s, crew[1].seat).roster[crew[0].seat].status).toBe('alive');
  });
});

describe('the AI council', () => {
  it('a crew bot follows the model’s suspect only when its own suspicion backs it', () => {
    const s = createState(aiSetup(1));
    const crew = s.players.find((p) => p.role === 'crew')!;
    const other = s.players.find((p) => p.seat !== crew.seat)!;
    expect(botBallot(s, crew.seat, other.seat).eject).toBe(-1);
    s.bots[crew.seat]!.sus[other.seat] = 1.5;
    expect(botBallot(s, crew.seat, other.seat).eject).toBe(other.seat);
    expect(botBallot(s, crew.seat, crew.seat).eject).toBe(-1);
  });
  it('AI-only matches finish, with every kind of ending possible', () => {
    const reasons = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const s = createState(aiSetup(i));
      run(s, 20_000);
      expect(s.phase).toBe('over');
      expect(s.drained).toBeLessThanOrEqual(BUDGET);
      reasons.add(`${s.winner}:${s.reason}`);
    }
    expect(reasons.size).toBeGreaterThanOrEqual(3);
  });
});

describe('determinism and replay', () => {
  it('the same setup and inputs give the same match, and the input log replays it', () => {
    const setup: Setup = { ...aiSetup(7), seats: aiSetup(7).seats.map((x, i) => (i === 0 ? { name: 'Human' } : x)) };
    const a = createState(setup);
    const log: LogEntry[] = [];
    for (let t = 0; t < 3000 && a.phase !== 'over'; t++) {
      const inputs: (Input | undefined)[] = [];
      // a human wandering back and forth, readying up and voting skip in meetings
      const i: Input = a.phase === 'meeting' ? { ready: true, ballot: { eject: -1, props: {} } } : { mx: Math.floor(t / 40) % 2 ? 1 : -1, my: Math.floor(t / 70) % 2 ? 1 : -1 };
      inputs[0] = i;
      log.push({ t: a.tick + 1, c: 0, i });
      step(a, inputs);
    }
    const b = replay(setup, log, a.tick);
    expect(stateHash(b)).toBe(stateHash(a));
    const c = replay(setup, log, a.tick);
    expect(stateHash(c)).toBe(stateHash(b));
    expect(DRAIN_GOAL).toBeLessThan(BUDGET);
  });
});
