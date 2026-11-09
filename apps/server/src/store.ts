import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry, Reason, Setup, Winner } from '@inside-job/rules';
import { config } from './config.ts';
import type { SignedLine } from './nearai.ts';

// Match records: one JSON file each under DATA_DIR/matches (an Azure Files share when hosted).
// A record holds the match's secrets (the seed, every salt) until it is over; only then does the
// server hand out its proof bundle.

export interface SeatRec {
  kind: 'human' | 'ai';
  name: string;
  /** what the contract calls this seat: "guest:…", "account:…" or "ai:…" */
  label: string;
  account?: string;
  persona?: string;
  desk: string;
}

export interface MatchRecord {
  id: string;
  mode: 'solo' | 'room';
  createdAt: number;
  updatedAt: number;
  setup: Setup;
  seedHash: string;
  roleCommits: string[];
  seats: SeatRec[];
  /** every human input, tick by tick (AI seats are replayed by the sim itself, except ballots, which are logged) */
  log: LogEntry[];
  /** the salt that seals who filed spend n */
  filerSalts: string[];
  /** per meeting, per seat: the salt sealing that seat's eject vote (null: no ballot) */
  voteSalts: (string | null)[][];
  lines: SignedLine[];
  chat: { seat: number; text: string; at: number; meeting: number }[];
  txs: { what: string; hash: string }[];
  daoIds: (number | null)[];
  chainError?: string;
  result: { winner: Winner; reason: Reason; insider: number; tick: number; stateHash: string } | null;
  settled: boolean;
  settleOutcome?: unknown;
}

const dir = join(config.dataDir, 'matches');
mkdirSync(dir, { recursive: true });
const mem = new Map<string, MatchRecord>();

export function saveMatch(m: MatchRecord): void {
  m.updatedAt = Date.now();
  mem.set(m.id, m);
  const file = join(dir, `${m.id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(m));
  renameSync(`${file}.tmp`, file);
}

export const validId = (id: string): boolean => /^[a-z0-9-]{1,40}$/.test(id);

export function loadMatch(id: string): MatchRecord | null {
  if (!validId(id)) return null;
  const hit = mem.get(id);
  if (hit) return hit;
  try {
    const m = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as MatchRecord;
    mem.set(id, m);
    return m;
  } catch { return null; }
}

/** The most recent finished matches. */
export function recentMatches(limit = 12): MatchRecord[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  return files.map(loadMatch).filter((m): m is MatchRecord => !!m && !!m.result).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
