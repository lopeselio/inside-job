import { useEffect, useMemo, useRef, useState } from 'react';
import { PAYEE_LABEL, VENDORS, NEW_VENDORS, dutyDef, type DutyKind } from '@inside-job/rules';
import { sfx } from './audio.ts';

// The duties: small hands-on puzzles at the stations. They run in the browser; the server only checks
// that you stood at the station long enough. The invoice one doubles as scam-spotting practice.

const shuffle = <T,>(a: T[]): T[] => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

export function Minigame({ kind, onDone, onClose }: { kind: DutyKind; onDone: () => void; onClose: () => void }) {
  const def = dutyDef(kind);
  const [won, setWon] = useState(false);
  const finish = (): void => { if (won) return; setWon(true); sfx.duty(); setTimeout(onDone, 450); };
  useEffect(() => {
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className={`modal minigame ${won ? 'won' : ''}`} onClick={(e) => e.stopPropagation()}>
        <header><h3>{def.name}</h3><button className="ghost small" onClick={onClose}>✕</button></header>
        <p className="dim">{def.how}</p>
        <div className="mg-body">
          {kind === 'reserves' && <Reserves onWin={finish} />}
          {kind === 'keys' && <Dial onWin={finish} />}
          {kind === 'node' && <Wires onWin={finish} />}
          {kind === 'files' && <Sort onWin={finish} bins={['Sep', 'Oct', 'Nov']} item="receipt" />}
          {kind === 'mail' && <Sort onWin={finish} bins={['Legal', 'Ops', 'Treasury']} item="letter" />}
          {kind === 'coffee' && <Coffee onWin={finish} />}
          {kind === 'payroll' && <Invoice onWin={finish} />}
        </div>
        {won && <p className="ok">Done ✓</p>}
      </div>
    </div>
  );
}

function Reserves({ onWin }: { onWin: () => void }) {
  const stacks = useMemo(() => shuffle([2, 3, 5, 7, 9, 11]), []);
  const [next, setNext] = useState(0);
  const order = [...stacks].sort((a, b) => a - b);
  return (
    <div className="stacks">
      {stacks.map((h, i) => {
        const done = order.indexOf(h) < next;
        return (
          <button key={i} className={`stack ${done ? 'done' : ''}`} onClick={() => {
            if (done) return;
            if (h === order[next]) { sfx.click(); if (next + 1 === order.length) onWin(); setNext(next + 1); } else { sfx.error(); setNext(0); }
          }}>
            {Array.from({ length: h }, (_, k) => <i key={k} />)}
          </button>
        );
      })}
    </div>
  );
}

function Dial({ onWin }: { onWin: () => void }) {
  const code = useMemo(() => [0, 0, 0].map(() => Math.floor(Math.random() * 10)), []);
  const [at, setAt] = useState(0);
  const [k, setK] = useState(0);
  const turn = (d: number): void => { sfx.click(); setAt((at + d + 10) % 10); };
  const set = (): void => {
    if (at !== code[k]) { sfx.error(); return; }
    sfx.vote();
    if (k + 1 === code.length) onWin();
    setK(k + 1);
  };
  return (
    <div className="dial">
      <div className="code">{code.map((c, i) => <b key={i} className={i < k ? 'done' : i === k ? 'now' : ''}>{c}</b>)}</div>
      <div className="wheel" style={{ transform: `rotate(${at * 36}deg)` }}><span>▲</span></div>
      <div className="row"><button onClick={() => turn(-1)}>⟲</button><b className="big">{at}</b><button onClick={() => turn(1)}>⟳</button></div>
      <button className="primary" onClick={set}>Set</button>
    </div>
  );
}

const WIRE = ['#ff5a5a', '#5ac8ff', '#ffd25a', '#7bff8a'];
function Wires({ onWin }: { onWin: () => void }) {
  const right = useMemo(() => shuffle([0, 1, 2, 3]), []);
  const [pick, setPick] = useState<number | null>(null);
  const [done, setDone] = useState<number[]>([]);
  return (
    <div className="wires">
      <div className="col">{[0, 1, 2, 3].map((c) => <button key={c} className={`wire ${done.includes(c) ? 'done' : ''} ${pick === c ? 'on' : ''}`} style={{ background: WIRE[c] }} onClick={() => { sfx.click(); setPick(c); }} />)}</div>
      <div className="mid">{pick !== null ? '→' : ''}</div>
      <div className="col">{right.map((c) => <button key={c} className={`port ${done.includes(c) ? 'done' : ''}`} style={{ borderColor: WIRE[c] }} onClick={() => {
        if (pick === null || done.includes(c)) return;
        if (pick === c) { sfx.vote(); const d = [...done, c]; setDone(d); setPick(null); if (d.length === 4) onWin(); } else { sfx.error(); setPick(null); }
      }} />)}</div>
    </div>
  );
}

function Sort({ onWin, bins, item }: { onWin: () => void; bins: string[]; item: string }) {
  const items = useMemo(() => shuffle([0, 1, 2, 0, 1, 2].map((b, i) => ({ id: i, bin: b }))), []);
  const [held, setHeld] = useState<number | null>(null);
  const [left, setLeft] = useState(items);
  return (
    <div className="sort">
      <div className="pile">{left.map((x) => <button key={x.id} className={`paper ${held === x.id ? 'on' : ''}`} onClick={() => { sfx.click(); setHeld(x.id); }}>{item}<small>{bins[x.bin]}</small></button>)}</div>
      <div className="bins">{bins.map((b, i) => <button key={b} className="bin" onClick={() => {
        const x = left.find((y) => y.id === held);
        if (!x) return;
        if (x.bin !== i) { sfx.error(); setHeld(null); return; }
        sfx.vote();
        const l = left.filter((y) => y.id !== x.id);
        setLeft(l); setHeld(null);
        if (!l.length) onWin();
      }}>{b}</button>)}</div>
    </div>
  );
}

function Coffee({ onWin }: { onWin: () => void }) {
  const [fill, setFill] = useState(0);
  const holding = useRef(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    const id = setInterval(() => { if (holding.current) setFill((f) => Math.min(100, f + 2.2)); }, 40);
    return () => clearInterval(id);
  }, []);
  const release = (): void => {
    if (!holding.current) return;
    holding.current = false;
    if (fill >= 78 && fill <= 92) onWin();
    else { sfx.error(); setMsg(fill > 92 ? 'Overflowed. Try again.' : 'Not full yet. Try again.'); setFill(0); }
  };
  return (
    <div className="coffee">
      <div className="cup"><div className="liquid" style={{ height: `${fill}%` }} /><div className="zone" /></div>
      <button className="primary" onPointerDown={() => { holding.current = true; setMsg(''); }} onPointerUp={release} onPointerLeave={release}>Hold the lever</button>
      <small className="dim">{msg || 'Stop in the gold band.'}</small>
    </div>
  );
}

function Invoice({ onWin }: { onWin: () => void }) {
  const vendor = useMemo(() => { const pool = Math.random() < 0.65 ? VENDORS : NEW_VENDORS; return pool[Math.floor(Math.random() * pool.length)]; }, []);
  const options = useMemo(() => {
    const fakes = new Set<string>();
    while (fakes.size < 3) {
      const i = 1 + Math.floor(Math.random() * (vendor.length - 2));
      const swaps: Record<string, string> = { o: '0', l: '1', i: '1', e: '3', a: '4', s: '5' };
      const ch = vendor[i];
      const v = Math.random() < 0.5 && swaps[ch] ? vendor.slice(0, i) + swaps[ch] + vendor.slice(i + 1) : vendor.slice(0, i) + vendor.slice(i + 1);
      if (v !== vendor) fakes.add(v);
    }
    return shuffle([vendor, ...fakes]);
  }, [vendor]);
  const [wrong, setWrong] = useState<string[]>([]);
  return (
    <div className="invoice">
      <div className="paperslip"><b>INVOICE</b><span>{PAYEE_LABEL[vendor]}</span><small>Pay to account on their letterhead:</small><code>{vendor}</code></div>
      <p className="dim">Which account in the address book is theirs, exactly?</p>
      <div className="opts">{options.map((o) => <button key={o} className={wrong.includes(o) ? 'bad' : ''} onClick={() => { if (o === vendor) onWin(); else { sfx.error(); setWrong([...wrong, o]); } }}><code>{o}</code></button>)}</div>
    </div>
  );
}
