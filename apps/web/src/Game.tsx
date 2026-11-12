import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DRAIN_GOAL, FLAG_CAP, FLAG_TEXT, FREEZE_RANGE, PAYEE_LABEL, REPORT_RANGE, SHELLS, LOOKALIKES, SKIM_MAX, SKIM_MIN, SPEED, TICK_HZ,
  dutyDef, free, roleCommit, roomAt, roomName, stationAt, type Ballot, type DutyKind, type Input, type PublicProposal, type StationId, type View,
} from '@inside-job/rules';
import { sfx, startHum } from './audio.ts';
import { Minigame } from './Minigames.tsx';
import { net, type Msg } from './net.ts';
import type { Office } from './scene.ts';
import { call as walletCall } from './wallet.ts';

export interface SeatInfo { name: string; ai: boolean; persona: string | null; desk: string; color: number; signedIn: boolean }
export interface StartMsg { matchId: string; code: string; you: number; token: string; role: 'crew' | 'insider'; salt: string; commits: string[]; seedHash: string; seats: SeatInfo[]; contract: string; dao: string; chain: boolean }
interface ChatLine { seat: number; text: string; signed: boolean; human: boolean; n: number }
interface Tx { what: string; hash: string; url: string }
interface Results { winner: 'crew' | 'insider'; reason: string; insider: number; seed: string; roles: string[]; filers: number[]; drains: boolean[]; txs: Tx[]; settled: boolean; error: string | null; outcome: { winner: string; reason: string; drained: number; disputed: boolean } | null; final: boolean; matchId: string }

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
const clock = (ticks: number): string => { const s = Math.ceil(ticks / TICK_HZ); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const REASON: Record<string, string> = {
  ejected: 'The council voted the Insider out.',
  drained: `The Insider drained ${DRAIN_GOAL}+ credits past the council.`,
  outnumbered: 'Too few honest members were left standing.',
  duties: 'The crew finished every duty: the books balance.',
  closed: 'The night ran out and the books closed with the treasury intact.',
};
const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

export function Game({ office, start, account, onLeave, onHelp, reading = false }: { office: Office; start: StartMsg; account: string | null; onLeave: () => void; onHelp: () => void; reading?: boolean }) {
  const [view, setView] = useState<View | null>(null);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [chain, setChain] = useState<{ txs: Tx[]; error: string | null; settled: boolean }>({ txs: [], error: null, settled: false });
  const [results, setResults] = useState<Results | null>(null);
  const [panel, setPanel] = useState<null | { t: 'duty'; kind: DutyKind } | { t: 'audit' } | { t: 'skim' }>(null);
  const [toasts, setToasts] = useState<{ id: number; text: string; tone: string }[]>([]);
  const [splash, setSplash] = useState(true);
  const splashChecked = useRef(false);
  const [claim, setClaim] = useState<string>('');
  const me = start.you;
  const seats = start.seats;
  const name = (k: number): string => seats[k]?.name ?? `Seat ${k + 1}`;
  const insider = start.role === 'insider';
  const sealOk = useMemo(() => roleCommit(start.matchId, me, start.role, start.salt) === start.commits[me], [start, me]);

  const viewRef = useRef<View | null>(null);
  const pos = useRef<{ x: number; y: number } | null>(null);
  const keys = useRef({ mx: 0, my: 0 });
  const joy = useRef({ mx: 0, my: 0 });
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const meetingN = useRef(-1);
  // for scripted smoke tests: where this browser thinks you are
  (globalThis as { __insideJob?: unknown }).__insideJob = { pos, view: viewRef };

  const toast = useCallback((text: string, tone = 'info'): void => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  const send = (i: Input): void => net.send({ t: 'input', i: i as unknown as Record<string, unknown> } as Msg);

  // ---------- messages ----------
  useEffect(() => {
    office.setMode('play');
    startHum();
    const off = net.on((m) => {
      if (m.t === 'view') {
        const v = m.v as View;
        viewRef.current = v;
        setView(v);
        if (!splashChecked.current) { splashChecked.current = true; if (v.tick > 80) setSplash(false); }
        if (!pos.current || v.phase !== 'play' || Math.hypot(pos.current.x - v.you.x, pos.current.y - v.you.y) > 1.2) pos.current = { x: v.you.x, y: v.you.y };
        else { pos.current.x += (v.you.x - pos.current.x) * 0.12; pos.current.y += (v.you.y - pos.current.y) * 0.12; }
        if (v.meeting && v.meeting.n !== meetingN.current) { meetingN.current = v.meeting.n; setPanel(null); }
        for (const e of m.ev as { t: string; [k: string]: unknown }[]) onEvent(e, v);
      } else if (m.t === 'chat') {
        setChat((c) => [...c, { seat: m.seat as number, text: m.text as string, signed: !!m.signed, human: !!m.human, n: meetingN.current }]);
      } else if (m.t === 'chain') {
        setChain({ txs: m.txs as Tx[], error: (m.error as string) ?? null, settled: !!m.settled });
      } else if (m.t === 'results') {
        const r = m as unknown as Results;
        setResults((prev) => { if (!prev) (r.winner === (insider ? 'insider' : 'crew') ? sfx.win : sfx.lose)(); return r; });
        setChain({ txs: r.txs, error: r.error, settled: r.settled });
        setPanel(null);
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onEvent(e: { t: string; [k: string]: unknown }, v: View): void {
    switch (e.t) {
      case 'filed': { const p = v.proposals[e.n as number]; sfx.filed(); toast(`Spend #${p.n} filed at the ${p.terminal === 'vault' ? 'vault terminal' : 'payroll desk'}: ${p.amount} cr to ${p.payee}${p.flags.length ? ` (${p.flags.length} flag${p.flags.length > 1 ? 's' : ''})` : ''}`, p.flags.some((f) => f !== 'new_payee') ? 'warn' : 'info'); break; }
      case 'resolved': { const p = v.proposals[e.n as number]; if (e.status === 'approved') { if (p.drain) { sfx.drain(); toast(`Spend #${p.n} went through, and ${p.payee} is a shell. ${p.amount} credits drained.`, 'bad'); } else { sfx.approve(); toast(`Spend #${p.n} paid to ${p.payee}.`, 'good'); } } else { sfx.reject(); toast(`Spend #${p.n} rejected by the council.`); } break; }
      case 'frozen': sfx.freeze(); office.burst(e.x as number, e.y as number, 0x9fe8ff, 40); if (e.victim === me) toast('You were frozen. You can still finish your duties as a ghost.', 'bad'); else toast(`You froze ${name(e.victim as number)}.`, 'warn'); break;
      case 'meeting': sfx.meeting(); break;
      case 'phase': if (e.phase === 'reveal') sfx.reveal(); break;
      case 'lights': if (e.out) { sfx.lightsOut(); toast(insider ? 'Lights out. They can barely see.' : 'Lights out! Fix the breaker in the server room.', 'warn'); } else { sfx.lightsOn(); } break;
      case 'duty': if (e.seat === me) { const st = viewRef.current; if (st) office.burst(st.you.x, st.you.y, 0xffd36b, 14); } break;
      case 'over': break;
    }
  }

  // ---------- scene sync ----------
  useEffect(() => {
    if (!view) return;
    const actors = view.seen.map((o) => ({ seat: o.seat, x: o.x, y: o.y, dir: o.dir, moving: o.moving, ghost: o.ghost, color: seats[o.seat].color, name: name(o.seat) }));
    const p = pos.current ?? { x: view.you.x, y: view.you.y };
    actors.push({ seat: me, x: p.x, y: p.y, dir: view.you.dir, moving: keys.current.mx !== 0 || keys.current.my !== 0 || joy.current.mx !== 0 || joy.current.my !== 0, ghost: view.you.status !== 'alive', color: seats[me].color, name: `${name(me)} (you)`, me: true } as never);
    office.setActors(actors);
    office.setBodies(view.bodies.map((b) => ({ ...b, color: seats[b.seat].color, name: name(b.seat) })));
    office.setDark(view.dark);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  useEffect(() => () => { office.clearActors(); office.highlight(null); office.setDark(false); }, [office]);

  // ---------- movement: keys, joystick, prediction ----------
  useEffect(() => {
    const held = new Set<string>();
    const recalc = (): void => {
      keys.current.mx = (held.has('d') || held.has('arrowright') ? 1 : 0) - (held.has('a') || held.has('arrowleft') ? 1 : 0);
      keys.current.my = (held.has('s') || held.has('arrowdown') ? 1 : 0) - (held.has('w') || held.has('arrowup') ? 1 : 0);
    };
    const down = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { held.add(k); recalc(); e.preventDefault(); return; }
      if (panelRef.current) return;
      if (k === 'e' || k === ' ') { act(); e.preventDefault(); }
      if (k === 'q') freeze();
      if (k === 'r') report();
      if (k === 'f') skimOpen();
      if (k === 'l') lights();
    };
    const up = (e: KeyboardEvent): void => { held.delete(e.key.toLowerCase()); recalc(); };
    const blur = (): void => { held.clear(); recalc(); };
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    addEventListener('blur', blur);
    let last = { mx: 0, my: 0 };
    const sendLoop = setInterval(() => {
      const v = viewRef.current;
      const blocked = !!panelRef.current || !v || v.phase !== 'play';
      const mx = blocked ? 0 : keys.current.mx || joy.current.mx;
      const my = blocked ? 0 : keys.current.my || joy.current.my;
      if (mx || my || last.mx || last.my) send({ mx, my });
      last = { mx, my };
    }, 1000 / TICK_HZ);
    let raf = 0;
    let prev = performance.now();
    const loop = (now: number): void => {
      const dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      const v = viewRef.current;
      const p = pos.current;
      if (v && p && v.phase === 'play' && !panelRef.current) {
        const mx = keys.current.mx || joy.current.mx, my = keys.current.my || joy.current.my;
        if (mx || my) {
          const len = Math.hypot(mx, my);
          const sp = SPEED * TICK_HZ * dt * (v.you.status === 'alive' ? 1 : 1.15);
          const nx = p.x + (mx / len) * sp;
          if (free(nx, p.y)) p.x = nx;
          const ny = p.y + (my / len) * sp;
          if (free(p.x, ny)) p.y = ny;
        }
        office.setMe(me, p.x, p.y);
        office.highlight(stationAt(p.x, p.y));
      } else office.highlight(null);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { removeEventListener('keydown', down); removeEventListener('keyup', up); removeEventListener('blur', blur); clearInterval(sendLoop); cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- actions ----------
  const here = (): StationId | null => (pos.current ? stationAt(pos.current.x, pos.current.y) : null);
  const myDutyAt = (st: StationId | null): DutyKind | null => {
    const v = viewRef.current;
    if (!v || !st) return null;
    return v.you.duties.find((d) => d.state === 'todo' && dutyDef(d.kind).station === st)?.kind ?? null;
  };
  function act(): void {
    const v = viewRef.current;
    if (!v || v.phase !== 'play') return;
    const st = here();
    const duty = myDutyAt(st);
    if (duty) { setPanel({ t: 'duty', kind: duty }); return; }
    if (st === 'audit') { setPanel({ t: 'audit' }); return; }
    if (v.you.status !== 'alive') return;
    if (st === 'breaker' && v.lightsOut && !insider) { send({ fix: true }); return; }
    if (st === 'table' && !v.you.bellUsed) { send({ bell: true }); return; }
    if ((st === 'terminal' || st === 'payroll') && insider) skimOpen();
  }
  function nearestCrew(): number | null {
    const v = viewRef.current;
    const p = pos.current;
    if (!v || !p) return null;
    let best: number | null = null, bd = FREEZE_RANGE;
    for (const o of v.seen) { if (o.ghost) continue; const d = Math.hypot(o.x - p.x, o.y - p.y); if (d <= bd) { bd = d; best = o.seat; } }
    return best;
  }
  function freeze(): void {
    const v = viewRef.current;
    if (!insider || !v || v.you.status !== 'alive' || (v.you.cd?.freeze ?? 1) > 0) return;
    const t = nearestCrew();
    if (t === null) { toast('Nobody close enough to freeze.'); return; }
    send({ freeze: t });
  }
  function bodyNear(): boolean {
    const v = viewRef.current, p = pos.current;
    return !!v && !!p && v.bodies.some((b) => Math.hypot(b.x - p.x, b.y - p.y) <= REPORT_RANGE);
  }
  function report(): void { if (bodyNear()) send({ report: true }); }
  function lights(): void { const v = viewRef.current; if (insider && v && (v.you.cd?.lights ?? 1) === 0 && !v.lightsOut) send({ lights: true }); }
  function skimOpen(): void {
    const v = viewRef.current;
    const st = here();
    if (!insider || !v || v.you.status !== 'alive' || v.phase !== 'play') return;
    if (st !== 'terminal' && st !== 'payroll') { toast('Skims are filed from the vault terminal (Vault) or the payroll desk (Payroll): go to one and press F.'); return; }
    if ((v.you.cd?.skim ?? 1) > 0) { toast(`The books are watched: skim again in ${clock(v.you.cd!.skim)}.`); return; }
    setPanel({ t: 'skim' });
  }

  // finishing a duty: the server wants you at the station long enough, so retry until it counts
  const doneTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const finishDuty = (kind: DutyKind): void => {
    setPanel(null);
    let tries = 0;
    send({ done: kind });
    if (doneTimer.current) clearInterval(doneTimer.current);
    doneTimer.current = setInterval(() => {
      const d = viewRef.current?.you.duties.find((x) => x.kind === kind);
      if (!d || d.state !== 'todo' || ++tries > 12) { clearInterval(doneTimer.current!); return; }
      send({ done: kind });
    }, 400);
  };

  // while the walkthrough or the role card is open, a solo match's clock waits (the server ignores this in rooms with friends)
  const holding = (splash || reading) && !results;
  useEffect(() => { net.send({ t: 'hold', on: holding }); }, [holding]);

  // claim the seat from the wallet (signed-in players): gasless, makes this match count on the ledger
  useEffect(() => {
    if (!account || !start.chain || !seats[me]?.signedIn) return;
    const t = setTimeout(() => {
      setClaim('Claiming your seat from your wallet (gasless)…');
      walletCall('claim_seat', { match_id: start.matchId, seat: me })
        .then((r) => setClaim(`✓ Seat claimed from ${account}${r.gasless ? ', gasless' : ''}`))
        .catch((e: Error) => setClaim(`Seat not claimed: ${e.message}`));
    }, 6000);
    return () => clearTimeout(t);
  }, [account, start, me, seats]);

  if (!view) return <div className="center-msg">Taking your seat…</div>;
  const v = view;
  const st = here();
  const duty = myDutyAt(st);
  const alive = v.you.status === 'alive';
  const prompt = v.phase !== 'play' ? null
    : duty ? `E: ${dutyDef(duty).name}`
    : st === 'audit' ? 'E: Review the spends'
    : st === 'breaker' && v.lightsOut && !insider && alive ? 'E: Fix the lights'
    : st === 'table' && alive && !v.you.bellUsed ? 'E: Ring the bell (call a meeting)'
    : (st === 'terminal' || st === 'payroll') && insider && alive ? `F: Skim${v.you.cd && v.you.cd.skim > 0 ? ` (${clock(v.you.cd.skim)})` : ''}`
    : null;
  const pending = v.proposals.filter((p) => p.status === 'pending');

  return (
    <>
      <div className={`vision ${v.dark ? 'dark' : ''} ${alive ? '' : 'ghost'}`} />
      <aside className="hud left">
        <div className={`role ${start.role}`}>
          <small>Seat {me + 1} · {start.seats[me].desk}</small>
          <b>{insider ? 'You are the INSIDER' : 'You are CREW'}</b>
          <span>{insider ? 'Drain 25 credits past the vote, or freeze the crew. Don’t get voted out.' : 'Finish your duties, vet every spend, and vote the Insider out.'}</span>
          <em className={sealOk ? 'ok' : 'bad'} title={`commitment ${start.commits[me].slice(0, 16)}…`}>{sealOk ? '✓ Your role opens your sealed commitment' : '✗ Role does not match its commitment'}</em>
          {!alive && <em className="bad">{v.you.status === 'frozen' ? 'Frozen: you’re a ghost. Finish your duties.' : 'Ejected: you’re a ghost. Finish your duties.'}</em>}
        </div>
        <div className="panel duties">
          <h4>{insider ? 'Cover duties (fake)' : 'Your duties'}</h4>
          <ul>{v.you.duties.map((d, i) => <li key={i} className={d.state}>{d.state === 'done' ? '✓' : d.state === 'filed' ? '…' : '○'} {dutyDef(d.kind).name}<small>{d.state === 'filed' ? 'awaiting approval' : roomName(roomAt(STATION_POS[dutyDef(d.kind).station][0], STATION_POS[dutyDef(d.kind).station][1]))}</small></li>)}</ul>
        </div>
        {insider && v.you.cd && (
          <div className="panel tools">
            <h4>Insider tools</h4>
            <button disabled={!alive || v.you.cd.freeze > 0} onClick={freeze}>Q Freeze {v.you.cd.freeze > 0 ? clock(v.you.cd.freeze) : ''}</button>
            <button disabled={!alive || v.you.cd.skim > 0} onClick={skimOpen}>F Skim {v.you.cd.skim > 0 ? clock(v.you.cd.skim) : ''}</button>
            <button disabled={!alive || v.you.cd.lights > 0 || v.lightsOut} onClick={lights}>L Lights out {v.you.cd.lights > 0 ? clock(v.you.cd.lights) : ''}</button>
          </div>
        )}
      </aside>

      <aside className="hud right">
        <div className="panel treasury">
          <h4>Treasury <small><a href={`https://testnet.nearblocks.io/address/${start.dao}`} target="_blank" rel="noreferrer">{start.dao}</a></small></h4>
          <div className="bar">
            <i className="paid" style={{ width: `${v.paid}%` }} />
            <i className="drained" style={{ width: `${v.drained}%` }} />
            <i className="goal" style={{ left: `${100 - DRAIN_GOAL}%` }} />
          </div>
          <div className="nums"><span>{v.treasury} cr left</span><span className="bad">drained {v.drained}/{DRAIN_GOAL}</span></div>
          <div className="bar duty"><i style={{ width: `${(100 * v.duties.done) / v.duties.total}%` }} /></div>
          <div className="nums"><span>crew duties {v.duties.done}/{v.duties.total}</span><span>session in {clock(v.sessionIn)}</span></div>
          <div className="nums dim"><span>night ends in {clock(v.playLeft)}</span><span>{v.lightsOut ? '⚠ lights out' : ''}</span></div>
        </div>
        <div className="panel spends">
          <h4>Spends ({pending.length} open) <small>3 of 5 approve on the DAO</small></h4>
          {v.proposals.length === 0 && <p className="dim">No spends yet. Payroll invoices and anything else filed tonight show up here, with the contract’s audit flags.</p>}
          <ul>{[...v.proposals].reverse().slice(0, 6).map((p) => <SpendRow key={p.n} p={p} seats={seats} />)}</ul>
        </div>
        <div className="panel roster">
          {v.roster.map((r) => <span key={r.seat} className={`chip ${r.status}`} style={{ borderColor: hex(seats[r.seat].color) }}><i style={{ background: hex(seats[r.seat].color) }} />{name(r.seat)}{r.seat === me ? ' (you)' : ''}{seats[r.seat].ai ? <small>AI</small> : null}</span>)}
        </div>
        <ChainFeed txs={chain.txs} error={chain.error} on={start.chain} />
        {claim && <p className="claim">{claim}</p>}
      </aside>

      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}</div>
      {prompt && !panel && <div className="prompt" onClick={act}>{prompt}</div>}
      {v.phase === 'play' && alive && bodyNear() && <button className="report" onClick={report}>R · Report the frozen member</button>}

      {touch && v.phase === 'play' && <Joystick onMove={(mx, my) => { joy.current = { mx, my }; }} />}
      {touch && v.phase === 'play' && (
        <div className="touch-actions">
          <button onClick={act}>Use</button>
          {insider && <button onClick={freeze}>Freeze</button>}
          {insider && <button onClick={skimOpen}>Skim</button>}
          {insider && <button onClick={lights}>Lights</button>}
          <button onClick={report}>Report</button>
        </div>
      )}

      {panel?.t === 'duty' && <Minigame kind={panel.kind} onDone={() => finishDuty(panel.kind)} onClose={() => setPanel(null)} />}
      {panel?.t === 'audit' && <AuditDesk v={v} seats={seats} me={me} alive={alive} onVote={(n, approve) => { send({ vote: { n, approve } }); sfx.vote(); }} onClose={() => setPanel(null)} />}
      {panel?.t === 'skim' && <Skim at={st === 'terminal' ? 'vault' : 'payroll'} onSkim={(payee, amount) => { send({ skim: { payee, amount } }); setPanel(null); }} onClose={() => setPanel(null)} />}

      {v.meeting && !results && <Meeting v={v} seats={seats} me={me} chat={chat.filter((c) => c.n === v.meeting!.n)} insider={insider} />}
      {results && <ResultsView r={results} v={v} seats={seats} me={me} start={start} chain={chain} onLeave={onLeave} />}
      {splash && !results && (
        <div className="modal-back" onClick={() => setSplash(false)}>
          <div className={`modal splash ${start.role}`} onClick={(e) => e.stopPropagation()}>
            <small>Your sealed role</small>
            <h2>{insider ? 'You are the Insider' : 'You are crew'}</h2>
            <p>{insider
              ? 'Nobody else knows. Skim the treasury with fake invoices at the vault terminal or payroll desk, freeze members who are alone, and talk your way through the meetings.'
              : 'One of the other four is the Insider. Do your duties, approve honest invoices, reject the drains, and find out who is lying.'}</p>
            <p className="dim">Your role was committed onchain before you saw it: <code>{start.commits[me].slice(0, 20)}…</code> {sealOk ? '✓ it opens with your salt' : '✗'}. Nobody, not even the server, can change it now.</p>
            <div className="row"><button className="primary" onClick={() => setSplash(false)}>Start the night shift</button><button className="ghost" onClick={() => { setSplash(false); onHelp(); }}>How to play</button></div>
          </div>
        </div>
      )}
    </>
  );
}

const STATION_POS: Record<string, [number, number]> = {
  terminal: [3.5, 2.5], keys: [9.5, 5.5], node: [14.5, 2.5], breaker: [20.5, 2.5], audit: [27.5, 3.5], files: [2.5, 14.5], payroll: [28.5, 13.5], mail: [31.5, 16.5], coffee: [1.5, 8.5], table: [17, 14.5],
};

function SpendRow({ p, seats }: { p: PublicProposal; seats: SeatInfo[] }) {
  return (
    <li className={`spend ${p.status} ${p.drain ? 'drain' : ''}`}>
      <div className="sp-top"><b>#{p.n}</b><span className="payee" title={`${p.payee}.inside-job.testnet`}>{PAYEE_LABEL[p.payee]}<code>{p.payee}</code></span><b className="amt">{p.amount} cr</b></div>
      <div className="meta">
        <span>{p.terminal === 'vault' ? '🔒 vault terminal' : '🧾 payroll desk'} · {clock(p.tick)}</span>
        <span className="votes">{p.votes.map((x, k) => <i key={k} style={{ background: x === null ? 'transparent' : hex(seats[k].color), borderColor: hex(seats[k].color) }} title={`${seats[k].name}: ${x === null ? 'not voted' : x ? 'approve' : 'reject'}`}>{x === null ? '' : x ? '✓' : '✗'}</i>)}</span>
        <em>{p.status === 'pending' ? 'open' : p.status === 'approved' ? (p.drain ? 'DRAINED' : 'paid') : 'rejected'}</em>
      </div>
      {p.flags.length > 0 && <div className="flags">{p.flags.map((f) => <span key={f} className={`flag ${f}`} title={FLAG_TEXT[f]}>{f.replace('_', ' ')}</span>)}</div>}
      {p.mine && <small className="mine">{p.drain === undefined ? 'you filed this' : p.drain ? 'your drain' : 'your invoice'}</small>}
    </li>
  );
}

function AuditDesk({ v, seats, me, alive, onVote, onClose }: { v: View; seats: SeatInfo[]; me: number; alive: boolean; onVote: (n: number, approve: boolean) => void; onClose: () => void }) {
  const open = v.proposals.filter((p) => p.status === 'pending');
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal audit" onClick={(e) => e.stopPropagation()}>
        <header><h3>Audit desk</h3><button className="ghost small" onClick={onClose}>✕</button></header>
        <p className="dim">Each vote goes from your desk account to the Sputnik DAO (<code>act_proposal</code>). Three approvals pay a spend out; three rejections kill it. Votes are public. Flags come from the contract’s audit log: hints, not verdicts.</p>
        {!alive && <p className="bad">Ghosts can’t vote.</p>}
        {open.length === 0 && <p>Nothing open right now.</p>}
        <ul className="audit-list">
          {open.map((p) => (
            <li key={p.n}>
              <SpendRow p={p} seats={seats} />
              <ul className="why">{p.flags.map((f) => <li key={f}>⚑ {FLAG_TEXT[f]}</li>)}{p.flags.length === 0 && <li>No flags: a vendor on file, a normal amount, from the payroll desk.</li>}</ul>
              {alive && p.votes[me] === null ? <div className="row"><button className="good" onClick={() => onVote(p.n, true)}>Approve</button><button className="bad" onClick={() => onVote(p.n, false)}>Reject</button></div> : <small className="dim">{p.votes[me] === null ? '' : `You voted ${p.votes[me] ? 'approve' : 'reject'}.`}</small>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Skim({ at, onSkim, onClose }: { at: 'vault' | 'payroll'; onSkim: (payee: string, amount: number) => void; onClose: () => void }) {
  const [payee, setPayee] = useState<string>(SHELLS[0]);
  const [amount, setAmount] = useState(6);
  const flags = [LOOKALIKES.includes(payee as never) ? 'lookalike' : null, 'new payee', amount > FLAG_CAP ? 'over cap' : null, at === 'vault' ? 'vault terminal' : null].filter(Boolean);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal skim" onClick={(e) => e.stopPropagation()}>
        <header><h3>File a “vendor invoice”</h3><button className="ghost small" onClick={onClose}>✕</button></header>
        <p className="dim">It goes to the DAO like any spend, from the anonymous {at === 'vault' ? 'vault terminal' : 'payroll desk'}. It still needs three approvals, yours included. The contract will flag it: {flags.join(', ')}.</p>
        <div className="payees">
          <small>Shell companies (flag: new payee)</small>
          {SHELLS.map((s) => <label key={s} className={payee === s ? 'on' : ''}><input type="radio" checked={payee === s} onChange={() => setPayee(s)} />{PAYEE_LABEL[s]} <code>{s}</code></label>)}
          <small>Lookalikes of vendors on file (flag: lookalike)</small>
          {LOOKALIKES.map((s) => <label key={s} className={payee === s ? 'on' : ''}><input type="radio" checked={payee === s} onChange={() => setPayee(s)} />{PAYEE_LABEL[s]} <code>{s}</code></label>)}
        </div>
        <label className="amount">Amount: <b>{amount} credits</b><input type="range" min={SKIM_MIN} max={SKIM_MAX} value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></label>
        <div className="row"><button className="primary" onClick={() => onSkim(payee, amount)}>File it</button><button className="ghost" onClick={onClose}>Not now</button></div>
      </div>
    </div>
  );
}

function Meeting({ v, seats, me, chat, insider }: { v: View; seats: SeatInfo[]; me: number; chat: ChatLine[]; insider: boolean }) {
  const m = v.meeting!;
  const [text, setText] = useState('');
  const [eject, setEject] = useState<number | null>(null);
  const [props, setProps] = useState<Record<string, boolean>>({});
  const [sent, setSent] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { log.current?.scrollTo(0, 1e6); }, [chat.length]);
  useEffect(() => { setSent(false); setEject(null); setProps({}); }, [m.n]);
  const alive = v.you.status === 'alive';
  const open = v.proposals.filter((p) => p.status === 'pending' && p.votes[me] === null);
  const title = m.kind === 'report' && m.body !== null ? `${seats[m.by!].name} found ${seats[m.body].name} frozen` : m.kind === 'bell' ? `${seats[m.by!].name} rang the bell` : 'Council session';
  const ballot = (): void => {
    const b: Ballot = { eject: eject ?? -1, props: Object.fromEntries(open.map((p) => [String(p.n), props[p.n] ?? false])) };
    net.send({ t: 'input', i: { ballot: b } } as unknown as Msg);
    setSent(true);
    sfx.vote();
  };
  return (
    <div className="meeting">
      <div className="meeting-card">
        <header>
          <div><small>Meeting {m.n + 1}</small><h2>{title}</h2></div>
          <div className="phase">{m.phase === 'discuss' ? 'Discussion' : m.phase === 'vote' ? 'Vote' : 'Result'}<b>{clock(Math.max(0, m.until - v.tick))}</b></div>
        </header>
        <div className="seats">
          {v.roster.map((r) => (
            <button key={r.seat} disabled={m.phase !== 'vote' || !alive || sent || r.status !== 'alive'} className={`seat ${r.status} ${eject === r.seat ? 'picked' : ''}`} style={{ borderColor: hex(seats[r.seat].color) }} onClick={() => setEject(r.seat)}>
              <i style={{ background: hex(seats[r.seat].color) }} />
              <b>{seats[r.seat].name}{r.seat === me ? ' (you)' : ''}</b>
              <small>{r.status !== 'alive' ? r.status : m.voted[r.seat] ? 'voted ✓' : seats[r.seat].ai ? 'AI' : ''}{m.tally && m.tally.counts[r.seat] ? ` · ${m.tally.counts[r.seat]} vote${m.tally.counts[r.seat] > 1 ? 's' : ''}` : ''}</small>
            </button>
          ))}
        </div>
        <div className="chatlog" ref={log}>
          {chat.length === 0 && <p className="dim">The council members are gathering their thoughts…</p>}
          {chat.map((c, i) => <p key={i}><b style={{ color: hex(seats[c.seat]?.color ?? 0xffffff) }}>{seats[c.seat]?.name}</b> {c.text}{c.signed && <span className="tee" title="This line came from a TEE-hosted model on NEAR AI Cloud; its request, response and enclave signature are in the proof bundle.">✓ NEAR AI TEE</span>}</p>)}
        </div>
        {m.phase !== 'reveal' && alive && (
          <form className="say" onSubmit={(e) => { e.preventDefault(); if (text.trim()) net.send({ t: 'chat', text }); setText(''); }}>
            <input value={text} maxLength={140} placeholder={insider ? 'Say something convincing…' : 'Where were you? What did you see?'} onChange={(e) => setText(e.target.value)} />
            <button>Say</button>
          </form>
        )}
        {m.phase === 'discuss' && alive && <button className="primary" disabled={m.ready[me]} onClick={() => net.send({ t: 'input', i: { ready: true } } as unknown as Msg)}>{m.ready[me] ? 'Waiting for the others…' : 'Ready to vote'}</button>}
        {m.phase === 'vote' && alive && !sent && (
          <div className="ballot">
            <p>Eject: <b>{eject === null ? 'skip (nobody)' : seats[eject].name}</b> {eject !== null && <button className="ghost small" onClick={() => setEject(null)}>skip instead</button>}</p>
            {open.length > 0 && <p className="dim">And the open spends (your vote goes to the DAO):</p>}
            {open.map((p) => (
              <div key={p.n} className="ballot-spend">
                <span>#{p.n} {p.amount} cr → <code>{p.payee}</code> {p.flags.map((f) => <i key={f} className={`flag ${f}`}>{f.replace('_', ' ')}</i>)}</span>
                <span className="row"><button className={props[p.n] === true ? 'good on' : 'good'} onClick={() => setProps({ ...props, [p.n]: true })}>Approve</button><button className={props[p.n] !== true ? 'bad on' : 'bad'} onClick={() => setProps({ ...props, [p.n]: false })}>Reject</button></span>
              </div>
            ))}
            <button className="primary" onClick={ballot}>Seal my vote</button>
            <small className="dim">Your eject vote is sealed onchain (<code>commit_vote</code> from your desk) and opened at the tally; the contract counts it.</small>
          </div>
        )}
        {m.phase === 'vote' && sent && <p className="ok">Vote sealed. Waiting for the others…</p>}
        {m.phase === 'reveal' && m.tally && (
          <div className="tally">
            <p>{m.tally.votes.map((x, k) => (x === null ? null : <span key={k}><b style={{ color: hex(seats[k].color) }}>{seats[k].name}</b> → {x < 0 ? 'skip' : seats[x].name}</span>)).filter(Boolean)}</p>
            <h3>{m.tally.ejected === null ? 'Nobody was ejected.' : `${seats[m.tally.ejected].name} was ejected.`}</h3>
          </div>
        )}
        {!alive && <p className="dim">Ghosts watch in silence.</p>}
      </div>
    </div>
  );
}

function ChainFeed({ txs, error, on }: { txs: Tx[]; error: string | null; on: boolean }) {
  if (!on) return <div className="panel chain"><h4>Onchain</h4><p className="dim">Chain writes are off on this server (CHAIN=0).</p></div>;
  return (
    <div className="panel chain">
      <h4>Onchain <small>{txs.length} tx</small></h4>
      <ul>{txs.slice(-5).reverse().map((t) => <li key={t.hash}><a href={t.url} target="_blank" rel="noreferrer">{t.what}</a></li>)}</ul>
      {error && <small className="bad" title={error}>a chain call failed (the game goes on)</small>}
    </div>
  );
}

function ResultsView({ r, v, seats, me, start, chain, onLeave }: { r: Results; v: View; seats: SeatInfo[]; me: number; start: StartMsg; chain: { txs: Tx[]; settled: boolean; error: string | null }; onLeave: () => void }) {
  const won = r.winner === (start.role === 'insider' ? 'insider' : 'crew');
  return (
    <div className="modal-back results-back">
      <div className={`modal results ${won ? 'won' : 'lost'}`}>
        <small>{won ? 'You won' : 'You lost'}</small>
        <h2>{r.winner === 'crew' ? 'The crew wins' : 'The Insider wins'}</h2>
        <p>{REASON[r.reason]}</p>
        <p className="reveal">The Insider was <b style={{ color: hex(seats[r.insider].color) }}>{seats[r.insider].name}</b>{r.insider === me ? ' (you)' : ''}.</p>
        <div className="grid2">
          <div>
            <h4>Every spend, unsealed</h4>
            <ul className="unsealed">{v.proposals.map((p) => <li key={p.n} className={r.drains[p.n] ? 'drain' : ''}>#{p.n} {p.amount} cr → <code>{p.payee}</code> · {p.status} · filed by {seats[r.filers[p.n]].name}{r.drains[p.n] ? ' (drain)' : ''}</li>)}{v.proposals.length === 0 && <li className="dim">none</li>}</ul>
            <h4>Meetings</h4>
            <ul className="unsealed">{v.meetings.map((t) => <li key={t.n}>#{t.n + 1}: {t.ejected === null ? 'nobody ejected' : `${seats[t.ejected].name} ejected`}</li>)}{v.meetings.length === 0 && <li className="dim">none</li>}</ul>
          </div>
          <div>
            <h4>What the contract checked</h4>
            {!start.chain && <p className="dim">Chain writes are off on this server.</p>}
            {start.chain && !chain.settled && <p className="dim">Settling… the referee opens the seed and every filer; the contract re-checks all five role commitments and reads each spend’s status from the Sputnik DAO.</p>}
            {r.outcome && <p className="ok">✓ Settled onchain: {r.outcome.winner} by {r.outcome.reason}, {r.outcome.drained} credits drained{r.outcome.disputed ? ' (the contract overruled the referee’s claim)' : ''}.</p>}
            <ul className="txs">{chain.txs.map((t) => <li key={t.hash}><a href={t.url} target="_blank" rel="noreferrer">{t.what}</a></li>)}</ul>
            <p className="dim">Check it yourself: <code>pnpm verify {r.matchId}{location.origin === 'https://inside-job.lopeselio.online' ? '' : ` --host ${location.origin}`}</code></p>
          </div>
        </div>
        <div className="row">
          <a className="btn" href={`/api/match/${r.matchId}/proof`} target="_blank" rel="noreferrer">Proof bundle (JSON)</a>
          <button className="primary" onClick={onLeave}>Back to the lobby</button>
        </div>
      </div>
    </div>
  );
}

function Joystick({ onMove }: { onMove: (mx: number, my: number) => void }) {
  const base = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const move = (e: React.PointerEvent): void => {
    const r = base.current!.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const d = Math.min(1, Math.hypot(dx, dy) / (r.width / 2));
    const a = Math.atan2(dy, dx);
    setKnob({ x: Math.cos(a) * d * 40, y: Math.sin(a) * d * 40 });
    const dead = 0.3;
    onMove(d < dead ? 0 : Math.abs(Math.cos(a)) > 0.38 ? Math.sign(Math.cos(a)) : 0, d < dead ? 0 : Math.abs(Math.sin(a)) > 0.38 ? Math.sign(Math.sin(a)) : 0);
  };
  const end = (): void => { setKnob({ x: 0, y: 0 }); onMove(0, 0); };
  return (
    <div className="joystick" ref={base} onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); move(e); }} onPointerMove={(e) => { if (e.buttons || e.pointerType === 'touch') move(e); }} onPointerUp={end} onPointerCancel={end}>
      <div className="knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
    </div>
  );
}
