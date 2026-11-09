import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

// Sealed roles, votes and filers. Every commitment is sha256 over a "|"-joined UTF-8 string, written
// out as lowercase hex. contracts/council/src/lib.rs builds exactly the same strings; a shared test
// vector in both test suites keeps them byte for byte equal.
//
//   seed hash      sha256("inside-job|seed|<seed>")                          posted at create_match
//   the deal       first 4 bytes of sha256("inside-job|deal|<match>|<seed>") as a big-endian u32, mod 5 = the Insider's seat
//   role salt      hex(sha256("inside-job|salt|<seed>|<seat>"))
//   role commit    sha256("inside-job|role|<match>|<seat>|<crew|insider>|<salt>")
//   vote commit    sha256("inside-job|vote|<match>|<meeting>|<seat>|<choice>|<salt>")   choice = seat index or -1 (skip)
//   filer commit   sha256("inside-job|filer|<match>|<n>|<seat>|<salt>")               who filed spend n

export const sha256Hex = (s: string): string => bytesToHex(sha256(utf8ToBytes(s)));
export const isHex32 = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

export const SEATS = 5;
export type Role = 'crew' | 'insider';

export const seedHash = (seed: string): string => sha256Hex(`inside-job|seed|${seed}`);

/** The Insider's seat, fixed by the seed: nobody can pick it after seeing the seats. */
export function dealInsider(matchId: string, seed: string): number {
  const h = sha256(utf8ToBytes(`inside-job|deal|${matchId}|${seed}`));
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  return n % SEATS;
}

export const roleSalt = (seed: string, seat: number): string => sha256Hex(`inside-job|salt|${seed}|${seat}`);
export const roleCommit = (matchId: string, seat: number, role: Role, salt: string): string =>
  sha256Hex(`inside-job|role|${matchId}|${seat}|${role}|${salt}`);

/** Every seat's role commitment, in seat order (what create_match posts). */
export function dealCommits(matchId: string, seed: string): string[] {
  const insider = dealInsider(matchId, seed);
  return Array.from({ length: SEATS }, (_, s) => roleCommit(matchId, s, s === insider ? 'insider' : 'crew', roleSalt(seed, s)));
}

export const voteCommit = (matchId: string, meeting: number, seat: number, choice: number, salt: string): string =>
  sha256Hex(`inside-job|vote|${matchId}|${meeting}|${seat}|${choice}|${salt}`);
export const filerCommit = (matchId: string, n: number, seat: number, salt: string): string =>
  sha256Hex(`inside-job|filer|${matchId}|${n}|${seat}|${salt}`);

/** 32 random bytes as hex (browser or Node). Only the server and tests call this; the sim never does. */
export function newSecret(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return bytesToHex(b);
}
