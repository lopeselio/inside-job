import { randomBytes } from 'node:crypto';
import {
  dealCommits, filerCommit, newSecret, seedHash, voteCommit,
  type Proposal, type Setup, type State,
} from '@inside-job/rules';
import { call, callOn, view } from './chain.ts';
import { config, deskOf, hasKey, payeeAccount } from './config.ts';
import { saveMatch, type MatchRecord, type SeatRec } from './store.ts';

// One match's onchain life, mirrored from the sim as it happens. Chain calls never block play: the
// sim is authoritative for the game, the chain records and checks it. If a call fails, the match
// still finishes and its record says why.
//
//   create_match (referee)       seed hash + five role commitments
//   file_spend (referee)         policy check, audit log, Transfer proposal on the Sputnik DAO
//   act_proposal (desk, on DAO)  each council vote on a spend, from that seat's own desk account
//   commit_vote (desk)           each sealed eject vote
//   tally_meeting (referee)      opens the votes; the contract counts them and ejects
//   settle (referee)             opens the seed and every filer; reads the DAO; records the outcome

export const CREDIT_YOCTO = 10n ** 21n;

const newId = (): string => `m-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

export function newRecord(mode: MatchRecord['mode'], seats: Omit<SeatRec, 'desk'>[]): MatchRecord {
  const id = newId();
  const seed = newSecret();
  const setup: Setup = { matchId: id, seed, seats: seats.map((s) => ({ name: s.name, persona: s.kind === 'ai' ? s.persona : null })) };
  return {
    id, mode, createdAt: Date.now(), updatedAt: Date.now(), setup, seedHash: seedHash(seed), roleCommits: dealCommits(id, seed),
    seats: seats.map((s, i) => ({ ...s, desk: deskOf(i) })),
    log: [], filerSalts: [], voteSalts: [], lines: [], chat: [], txs: [], daoIds: [], result: null, settled: false,
  };
}

export class ChainMatch {
  readonly on: boolean;
  private created: Promise<boolean>;
  private filed: Promise<number | null>[] = [];
  private commits: Promise<unknown>[][] = [];
  private votes: Promise<unknown>[] = [];
  /** the last vote sent on each spend: votes on one spend go out in the sim's order (the DAO closes it at the third) */
  private lastVote = new Map<number, Promise<unknown>>();
  private tallies: Promise<unknown>[] = [];
  /** spends recorded by the contract; after a refused filing the rest aren't sent (their numbers would shift) */
  private onchain = 0;
  private broken = false;

  constructor(readonly rec: MatchRecord, private changed: () => void = () => undefined) {
    this.on = config.chainEnabled && hasKey(config.referee);
    this.created = this.on ? this.create() : Promise.resolve(false);
  }

  private note(what: string, hash: string): void {
    this.rec.txs.push({ what, hash });
    saveMatch(this.rec);
    this.changed();
  }
  private fail(what: string, e: unknown): void {
    const msg = `${what}: ${(e as Error).message ?? e}`.slice(0, 300);
    console.warn(`[${this.rec.id}] ${msg}`);
    this.rec.chainError ??= msg;
    const tx = (e as { tx?: string }).tx;
    if (tx) this.rec.txs.push({ what: `${what} (failed)`, hash: tx });
    saveMatch(this.rec);
    this.changed();
  }

  private async create(): Promise<boolean> {
    try {
      const r = await call(config.referee, 'create_match', {
        match_id: this.rec.id,
        seed_hash: this.rec.seedHash,
        seats: this.rec.seats.map((s) => ({ label: s.label, account: s.account ?? null })),
        role_commits: this.rec.roleCommits,
      }, 30);
      this.note('create_match', r.tx);
      return true;
    } catch (e) { this.fail('create_match', e); return false; }
  }

  /** A spend the sim just filed. */
  file(pr: Proposal): void {
    const salt = newSecret();
    this.rec.filerSalts[pr.n] = salt;
    this.rec.daoIds[pr.n] = null;
    saveMatch(this.rec);
    const run = async (): Promise<number | null> => {
      if (!(await this.created)) return null;
      // spends are filed in order: the contract checks ticks never go back
      await (this.filed[pr.n - 1] ?? Promise.resolve(null));
      if (this.broken) return null;
      try {
        const r = await call<number | null>(config.referee, 'file_spend', {
          match_id: this.rec.id, tick: pr.tick, terminal: pr.terminal, payee: pr.payee, amount: pr.amount, memo: pr.memo,
          filer_commit: filerCommit(this.rec.id, pr.n, pr.filer, salt),
        }, 60);
        this.onchain = pr.n + 1;
        this.rec.daoIds[pr.n] = r.value ?? null;
        this.note(`file_spend #${pr.n}`, r.tx);
        return r.value ?? null;
      } catch (e) { this.broken = true; this.fail(`file_spend #${pr.n}`, e); return null; }
    };
    this.filed[pr.n] = this.on ? run() : Promise.resolve(null);
  }

  /** A council member's vote on a spend: from that seat's desk, straight to the Sputnik DAO. */
  daoVote(seat: number, pr: Proposal, approve: boolean): void {
    if (!this.on) return;
    const signer = `${deskOf(seat)}#dao`;
    if (!hasKey(signer)) return;
    const prev = this.lastVote.get(pr.n) ?? Promise.resolve();
    const run = (async () => {
      await prev;
      const id = await this.filed[pr.n];
      if (id === null || id === undefined) return;
      try {
        const r = await callOn(signer, config.dao, 'act_proposal', {
          id,
          action: approve ? 'VoteApprove' : 'VoteReject',
          proposal: { Transfer: { token_id: '', receiver_id: payeeAccount(pr.payee), amount: (BigInt(pr.amount) * CREDIT_YOCTO).toString(), msg: null } },
          memo: `seat ${seat + 1} on spend #${pr.n} (${this.rec.id})`,
        }, 50);
        this.note(`seat ${seat + 1} ${approve ? 'approves' : 'rejects'} #${pr.n} (DAO)`, r.tx);
      } catch (e) { this.fail(`DAO vote seat ${seat + 1} #${pr.n}`, e); }
    })();
    this.lastVote.set(pr.n, run);
    this.votes.push(run);
  }

  /** A sealed eject vote, committed by the seat's own desk account. */
  commitVote(meeting: number, seat: number, choice: number): void {
    const salt = newSecret();
    (this.rec.voteSalts[meeting] ??= [null, null, null, null, null])[seat] = salt;
    saveMatch(this.rec);
    if (!this.on || !hasKey(deskOf(seat))) return;
    (this.commits[meeting] ??= []).push((async () => {
      if (!(await this.created)) return;
      try {
        const r = await call(deskOf(seat), 'commit_vote', { match_id: this.rec.id, meeting, hash: voteCommit(this.rec.id, meeting, seat, choice, salt) }, 15);
        this.note(`seat ${seat + 1} seals its vote (meeting ${meeting + 1})`, r.tx);
      } catch (e) { this.fail(`commit_vote seat ${seat + 1}`, e); }
    })());
  }

  /** Open a meeting's votes; the contract counts them. */
  tally(meeting: number, votes: (number | null)[], alive: boolean[]): void {
    if (!this.on) return;
    const prev = this.tallies[this.tallies.length - 1] ?? Promise.resolve();
    this.tallies.push((async () => {
      await prev;
      if (!(await this.created)) return;
      await Promise.all(this.commits[meeting] ?? []);
      const salts = this.rec.voteSalts[meeting] ?? [];
      // only votes whose commitment went through can be opened (a failed commit counts as no ballot)
      const m = await view<{ meetings: { commits: (string | null)[] }[] } | null>('get_match', { match_id: this.rec.id }).catch(() => null);
      const committed = m?.meetings[meeting]?.commits ?? [];
      const openings = votes.map((v, seat) => (v !== null && salts[seat] && committed[seat] ? { choice: v, salt: salts[seat] } : null));
      try {
        const r = await call<number | null>(config.referee, 'tally_meeting', { match_id: this.rec.id, meeting, openings, alive }, 40);
        this.note(`tally_meeting ${meeting + 1}${r.value !== null && r.value !== undefined ? ` (ejects seat ${r.value + 1})` : ''}`, r.tx);
      } catch (e) { this.fail(`tally_meeting ${meeting + 1}`, e); }
    })());
  }

  /** The end: once every vote has landed, open the seed and the filers; the contract reads the DAO. */
  async settle(s: State): Promise<void> {
    if (!this.on || !s.winner || !s.reason) return;
    if (!(await this.created)) return;
    await Promise.all(this.filed);
    await Promise.all(this.votes);
    await Promise.all(this.tallies);
    const filers = s.proposals.slice(0, this.onchain).map((pr) => ({ seat: pr.filer, salt: this.rec.filerSalts[pr.n] }));
    try {
      const r = await call(config.referee, 'settle', { match_id: this.rec.id, seed: s.seed, filers, winner: s.winner, reason: s.reason }, 250);
      this.rec.settled = true;
      this.rec.settleOutcome = r.value;
      this.note('settle', r.tx);
    } catch (e) { this.fail('settle', e); }
  }
}
