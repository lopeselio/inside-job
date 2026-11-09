import { FLAG_TEXT, PERSONAS, botBallot, botNotes, roomName, type Persona, type State } from '@inside-job/rules';
import { voice, type SignedLine } from './nearai.ts';

// What an AI council member says in a meeting. The words come from a TEE-hosted model on NEAR AI
// Cloud (signed; the request, the response and the signature go into the proof bundle). The model is
// told only what that seat could know: its own role, its own sightings and the public record (spends,
// their flags, the onchain votes, past meetings, the chat). It may name a suspect; botBallot() in
// packages/rules decides whether the planner accepts that pick. The model never casts a vote itself.

export const personaById = (id: string | null | undefined): Persona | undefined => PERSONAS.find((p) => p.id === id);

const clock = (tick: number): string => {
  const sec = Math.floor(tick / 10);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};

/** The facts one seat may give its model. */
export function factsFor(s: State, seat: number, chat: { seat: number; text: string }[]): string {
  const me = s.players[seat];
  const name = (k: number): string => `${s.players[k].name} (seat ${k + 1})`;
  const m = s.meeting;
  const lines: string[] = [];
  lines.push(`Time ${clock(s.tick)}. Meeting #${(m?.n ?? 0) + 1}: ${m?.kind === 'report' && m.body !== null ? `${name(m.by!)} found ${name(m.body)} frozen` : m?.kind === 'bell' ? `${name(m.by!)} rang the bell` : 'the scheduled council session'}.`);
  lines.push(`Still at the table: ${s.players.filter((p) => p.status === 'alive').map((p) => name(p.seat)).join(', ')}.`);
  const out = s.players.filter((p) => p.status !== 'alive' && (p.reported || p.status === 'ejected'));
  if (out.length) lines.push(`Out: ${out.map((p) => `${name(p.seat)} (${p.status})`).join(', ')}.`);
  lines.push(`Treasury ${s.treasury}/100 credits. Drained so far (known): ${s.proposals.filter((p) => p.status === 'approved' && p.drain).reduce((a, p) => a + p.amount, 0)}.`);
  for (const pr of s.proposals.slice(-6)) {
    const votes = pr.votes.map((v, k) => (v === null ? null : `${s.players[k].name} ${v ? 'yes' : 'no'}`)).filter(Boolean).join(', ');
    lines.push(`Spend #${pr.n} at ${clock(pr.tick)} from the ${pr.terminal === 'vault' ? 'vault terminal' : 'payroll desk'}: ${pr.amount} credits to ${pr.payee}; flags: ${pr.flags.map((f) => FLAG_TEXT[f]).join('; ') || 'none'}; status ${pr.status}${pr.status === 'approved' && pr.drain ? ' (it was a DRAIN: the payee was a shell)' : ''}${pr.filer === seat ? ' (you filed this one)' : ''}; votes: ${votes || 'none yet'}.`);
  }
  const notes = botNotes(s, seat);
  const last = new Map<number, { tick: number; room: string }>();
  for (const g of notes.recent) last.set(g.seat, { tick: g.tick, room: roomName(g.room) });
  if (last.size) lines.push(`You saw: ${[...last.entries()].map(([k, v]) => `${s.players[k].name} in the ${v.room} at ${clock(v.tick)}`).join('; ')}.`);
  if (me.role === 'crew') {
    const sus = notes.sus.map((v, k) => [k, v] as const).filter(([k, v]) => k !== seat && v > 0.5 && s.players[k].status === 'alive').sort((a, b) => b[1] - a[1]);
    if (sus.length) lines.push(`Your hunch (strongest first): ${sus.map(([k]) => s.players[k].name).join(', ')}.`);
  } else {
    const mine = s.proposals.filter((p) => p.filer === seat && p.drain).map((p) => `#${p.n}`);
    lines.push(`SECRET (never say it): you are the Insider. ${mine.length ? `Your drains: ${mine.join(', ')}.` : 'No drains yet.'} ${s.players.some((p) => p.status === 'frozen') ? 'You froze the frozen ones.' : ''}`);
  }
  for (const t of s.meetings.slice(-2)) {
    lines.push(`Meeting #${t.n + 1} votes: ${t.votes.map((v, k) => (v === null ? null : `${s.players[k].name}→${v < 0 ? 'skip' : s.players[v].name}`)).filter(Boolean).join(', ')}${t.ejected !== null ? `; ${s.players[t.ejected].name} was ejected` : '; nobody was ejected'}.`);
  }
  if (chat.length) lines.push(`Chat so far:\n${chat.slice(-8).map((c) => `${s.players[c.seat].name}: ${c.text.slice(0, 140)}`).join('\n')}`);
  return lines.join('\n');
}

function fallback(s: State, seat: number, pick: number | null): string {
  const me = s.players[seat];
  const p = personaById(me.persona);
  const target = pick !== null ? s.players[pick].name : null;
  const pool = me.role === 'insider'
    ? [target ? `I was on my duties. ${target} has been drifting between rooms all night.` : 'I was on my duties the whole time. Let’s not throw a vote away.', 'Check the payroll desk log before you point at me.']
    : target ? [`I saw ${target} where the trouble was. My vote is ${target}.`, `${target}, explain that last spend.`] : ['Nothing solid yet. I’d skip unless someone saw something.', 'I was on my duties. Flagged spends get a no from me.'];
  const line = pool[(seat + s.tick) % pool.length];
  return p?.trait === 'careless' ? `${line} Probably.` : line;
}

/**
 * One AI member's line in a meeting, and the suspect the model named (or null).
 * The model's reply must be JSON: {"say": "...", "suspect": <seat number 1-5, or 0 for nobody>}.
 */
export async function talk(s: State, seat: number, chat: { seat: number; text: string }[]): Promise<{ line: SignedLine; pick: number | null }> {
  const me = s.players[seat];
  const p = personaById(me.persona);
  const plannerPick = botBallot(structuredClone(s), seat, null).eject;
  const fb = fallback(s, seat, plannerPick >= 0 ? plannerPick : null);
  const system = [
    `You are ${p?.persona ?? me.name}, one of five council members of a small DAO, in an emergency meeting at night.`,
    'One member is secretly the Insider, draining the treasury with fake vendor invoices and freezing members. The crew wins by voting the Insider out.',
    me.role === 'insider'
      ? 'You ARE the Insider. Never admit it. Deflect, sound helpful, and cast doubt on a crew member using the facts given.'
      : 'You are crew. You do not know who the Insider is. Reason only from the facts given.',
    'Use only the facts given. Do not invent sightings. Refer to people by name, or as they/them. No emojis, no hashtags.',
    'Reply with JSON only: {"say": "<one or two sentences, under 30 words, in character>", "suspect": <the seat number 1-5 you want ejected, or 0 to skip>}',
  ].join(' ');
  const line = await voice(me.name, system, factsFor(s, seat, chat), fb, 120);
  line.seat = seat;
  let pick: number | null = null;
  if (line.raw) {
    const j = /\{[\s\S]*\}/.exec(line.raw);
    try {
      const o = JSON.parse(j?.[0] ?? '{}') as { say?: unknown; suspect?: unknown };
      if (typeof o.say === 'string' && o.say.trim()) line.text = o.say.trim().slice(0, 240);
      else line.text = fb;
      const n = Number(o.suspect);
      if (Number.isInteger(n) && n >= 1 && n <= 5) pick = n - 1;
    } catch { line.text = line.raw.replace(/[{}"]/g, '').slice(0, 200) || fb; }
  } else if (plannerPick >= 0) pick = plannerPick;
  return { line, pick };
}
