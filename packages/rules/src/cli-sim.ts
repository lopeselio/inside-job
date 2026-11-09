declare const process: { argv: string[] };
import { PERSONAS } from './content.ts';
import { sha256Hex } from './hash.ts';
import { createState, step } from './sim.ts';

// Headless AI-only matches, for balance: who wins, how, and how long it takes.
//   pnpm sim [matches]
const n = Number(process.argv[2] ?? 200);
const wins: Record<string, number> = {};
let ticks = 0, meetings = 0, drained = 0, filed = 0;
for (let i = 0; i < n; i++) {
  const s = createState({ matchId: `sim-${i}`, seed: sha256Hex(`sim|${i}`), seats: PERSONAS.map((p) => ({ name: p.name, persona: p.id })) });
  while (s.phase !== 'over' && s.tick < 20_000) step(s, []);
  const k = `${s.winner} by ${s.reason}`;
  wins[k] = (wins[k] ?? 0) + 1;
  ticks += s.tick; meetings += s.meetings.length; drained += s.drained; filed += s.proposals.length;
}
console.log(`${n} AI-only matches`);
for (const [k, v] of Object.entries(wins).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${((100 * v) / n).toFixed(1)}%`);
console.log(`  mean length ${(ticks / n / 10 / 60).toFixed(1)} min, ${(meetings / n).toFixed(1)} meetings, ${(filed / n).toFixed(1)} spends filed, ${(drained / n).toFixed(1)} credits drained`);
