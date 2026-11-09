import { BURST_TICKS, FLAG_CAP, VENDORS } from './content.ts';

// The audit screen: the same five flags the contract writes into its onchain audit log for every
// spend it files (contracts/council/src/lib.rs, `flags_for`). They are hints, not verdicts: an honest
// invoice to a vendor that is new this quarter is flagged `new_payee` too.

export type Flag = 'lookalike' | 'new_payee' | 'over_cap' | 'vault_terminal' | 'burst';
export type Terminal = 'payroll' | 'vault';

export const FLAG_TEXT: Record<Flag, string> = {
  lookalike: 'payee is one or two letters off a vendor on file',
  new_payee: 'payee is not on file',
  over_cap: `more than ${FLAG_CAP} credits`,
  vault_terminal: 'filed from the vault terminal, not the payroll desk',
  burst: 'filed within 20 s of another spend',
};

/** Levenshtein distance (small strings). */
export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function flagsFor(payee: string, amount: number, terminal: Terminal, tick: number, lastTick: number | null): Flag[] {
  const out: Flag[] = [];
  const onFile = (VENDORS as readonly string[]).includes(payee);
  if (!onFile && VENDORS.some((v) => editDistance(v, payee) <= 2)) out.push('lookalike');
  if (!onFile) out.push('new_payee');
  if (amount > FLAG_CAP) out.push('over_cap');
  if (terminal === 'vault') out.push('vault_terminal');
  if (lastTick !== null && tick - lastTick <= BURST_TICKS) out.push('burst');
  return out;
}
