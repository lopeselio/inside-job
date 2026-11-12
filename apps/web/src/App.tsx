import { useEffect, useRef, useState } from 'react';
import { isMuted, setMuted, sfx } from './audio.ts';
import { Game, type StartMsg } from './Game.tsx';
import { net, setTicket, ticket, type Msg } from './net.ts';
import { Onboarding, onboarded } from './Onboarding.tsx';
import { Office } from './scene.ts';
import { setContract, signIn, signOut } from './wallet.ts';

// The shell: one three.js office behind everything; the title screen, a room's lobby, or a match on top.

interface Persona { id: string; name: string; trait: string; persona: string; color: number }
interface Cfg { contract: string; dao: string; referee: string; chain: boolean; nearAi: boolean; relayer: string | null; personas: Persona[] }
interface Lobby { code: string; seats: { name: string; ai: boolean; ready: boolean; signedIn: boolean; here: boolean }[]; you: number; host: boolean }
interface Recent { id: string; names: string[]; winner: string | null; reason: string | null; insider: string | null; settled: boolean }
interface Stats { games: number; wins: number; losses: number; insider_games: number; insider_wins: number; caught: number }

const getName = (): string => { try { return localStorage.getItem('inside-job:name') ?? ''; } catch { return ''; } };
const saveName = (n: string): void => { try { localStorage.setItem('inside-job:name', n); } catch { /* fine */ } };

export function App() {
  const host = useRef<HTMLDivElement>(null);
  const [office, setOffice] = useState<Office | null>(null);
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [start, setStart] = useState<StartMsg | null>(null);
  const [help, setHelp] = useState(false);
  const [mute, setMute] = useState(isMuted());
  const [err, setErr] = useState('');
  const [online, setOnline] = useState(true);

  useEffect(() => {
    if (!host.current) return;
    const o = new Office(host.current);
    setOffice(o);
    return () => { o.renderer.setAnimationLoop(null); o.renderer.domElement.remove(); };
  }, []);

  useEffect(() => {
    void fetch('/api/config').then((r) => r.json()).then((c: Cfg) => { setCfg(c); setContract(c.contract); }).catch(() => undefined);
    void fetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((m) => setAccount(m?.accountId ?? null)).catch(() => undefined);
    const off = net.on((m: Msg) => {
      if (m.t === 'lobby') setLobby(m as unknown as Lobby);
      else if (m.t === 'joined') setTicket({ code: m.code as string, token: m.token as string });
      else if (m.t === 'start') {
        const s = m as unknown as StartMsg;
        setTicket({ code: s.code, token: s.token });
        setStart(s);
        setLobby(null);
        if (!onboarded()) setHelp(true);
      } else if (m.t === 'error') {
        if (m.message === 'that match is gone') {
          // the match ended (or closed) while this tab was away: back to the title, where it's under "Recent nights"
          setTicket(null);
          setLobby(null);
          setStart((cur) => { if (cur) setErr('That match ended while you were away. Its result is under Recent nights.'); return null; });
        }
        else { setErr(String(m.message)); sfx.error(); }
      } else if (m.t === 'kicked') { setLobby(null); setTicket(null); setErr('The host removed you from the room.'); }
      else if (m.t === 'online') setOnline(true);
      else if (m.t === 'offline') setOnline(false);
    });
    if (ticket() || location.pathname.startsWith('/r/')) net.connect();
    const code = /^\/r\/([A-Z0-9]{4})$/i.exec(location.pathname)?.[1];
    if (code && !ticket()) net.send({ t: 'join', code: code.toUpperCase(), name: getName() || 'Guest' });
    const key = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'm' || e.key === 'M') { const x = !isMuted(); setMuted(x); setMute(x); }
      if (e.key === 'h' || e.key === 'H') setHelp((h) => !h);
    };
    addEventListener('keydown', key);
    return () => { off(); removeEventListener('keydown', key); };
  }, []);

  useEffect(() => { office?.setMode(start ? 'play' : 'title'); }, [office, start]);
  useEffect(() => {
    document.title = start ? 'Inside Job · night shift' : lobby ? `Inside Job · room ${lobby.code}` : 'Inside Job';
    if (lobby && !start && location.pathname !== `/r/${lobby.code}`) history.replaceState(null, '', `/r/${lobby.code}`);
    if ((start || !lobby) && location.pathname !== '/') history.replaceState(null, '', '/');
  }, [lobby, start]);

  const leave = (): void => { net.send({ t: 'leave' }); setTicket(null); setStart(null); setLobby(null); };
  // once a match is over there is nothing to rejoin: a reload goes back to the title, not to "Taking your seat…"
  useEffect(() => net.on((m: Msg) => { if (m.t === 'results') setTicket(null); }), []);

  return (
    <>
      <div ref={host} className="office" />
      <header className="top">
        <a className="logo" href="/" onClick={(e) => { e.preventDefault(); if (!start || confirm('Leave this match? An AI council member takes your chair.')) leave(); }}>INSIDE<span>JOB</span></a>
        {lobby && <span className="code">Room {lobby.code}</span>}
        {!online && <span className="bad small">reconnecting…</span>}
        <span className="grow" />
        <button className="ghost small" onClick={() => setHelp(true)} title="How to play (H)">How to play</button>
        <button className="ghost small" onClick={() => { const x = !mute; setMuted(x); setMute(x); }} title="Sound (M)">{mute ? '♪ off' : '♪ on'}</button>
        <Account account={account} setAccount={setAccount} />
      </header>
      {err && <div className="err-banner" onClick={() => setErr('')}>{err} <small>(dismiss)</small></div>}
      {office && start && <Game key={start.matchId} office={office} start={start} account={account} onLeave={leave} onHelp={() => setHelp(true)} />}
      {!start && lobby && <LobbyView lobby={lobby} onLeave={leave} />}
      {!start && !lobby && <Title cfg={cfg} account={account} />}
      {help && <Onboarding onClose={() => setHelp(false)} />}
    </>
  );
}

function Account({ account, setAccount }: { account: string | null; setAccount: (a: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (account) {
    return (
      <span className="acct">
        <a href={`https://testnet.nearblocks.io/address/${account}`} target="_blank" rel="noreferrer">{account.length > 22 ? `${account.slice(0, 10)}…${account.slice(-8)}` : account}</a>
        <button className="ghost small" onClick={() => { void signOut().then(() => setAccount(null)); }}>Sign out</button>
      </span>
    );
  }
  return (
    <span className="acct">
      {err && <small className="bad" title={err}>sign-in failed</small>}
      <button className="small" disabled={busy} onClick={() => {
        setBusy(true); setErr('');
        signIn().then(setAccount).catch((e: Error) => setErr(e.message)).finally(() => setBusy(false));
      }}>{busy ? 'Waiting for wallet…' : 'Sign in with NEAR'}</button>
    </span>
  );
}

function Title({ cfg, account }: { cfg: Cfg | null; account: string | null }) {
  const [name, setName] = useState(getName());
  const [code, setCode] = useState('');
  const [recent, setRecent] = useState<Recent[]>([]);
  const [board, setBoard] = useState<[string, Stats][]>([]);
  useEffect(() => {
    void fetch('/api/recent').then((r) => r.json()).then(setRecent).catch(() => undefined);
    void fetch('/api/leaderboard').then((r) => r.json()).then(setBoard).catch(() => undefined);
  }, [account]);
  const nm = (): string => { const n = name.trim() || 'Guest'; saveName(n); return n; };
  return (
    <main className="title">
      <section className="hero">
        <h1>INSIDE<span>JOB</span></h1>
        <p className="tag">Five council members run a DAO’s treasury through the night. One of them is draining it.</p>
        <p>Do your duties, vet every spend before it leaves the <b>real Sputnik DAO</b> on NEAR testnet, and vote the Insider out. Roles and votes are <b>sealed onchain</b>; the AI council speaks through a <b>TEE model</b> and votes through accounts that <b>can’t move money</b>.</p>
        <label className="name">Your name <input value={name} maxLength={18} placeholder="Guest" onChange={(e) => setName(e.target.value)} /></label>
        <div className="row">
          <button className="primary big" onClick={() => { sfx.click(); net.send({ t: 'solo', name: nm() }); }}>Play with the AI council</button>
        </div>
        <div className="row">
          <button onClick={() => net.send({ t: 'create', name: nm() })}>Create a room</button>
          <form className="join" onSubmit={(e) => { e.preventDefault(); if (code.trim()) net.send({ t: 'join', code: code.trim().toUpperCase(), name: nm() }); }}>
            <input value={code} maxLength={4} placeholder="CODE" onChange={(e) => setCode(e.target.value.toUpperCase())} />
            <button>Join</button>
          </form>
        </div>
        <p className="dim small">Guests play instantly, no wallet. {account ? `Signed in as ${account}: you’ll claim your seat from your wallet, gasless, and be ranked.` : 'Sign in with NEAR to be ranked.'}</p>
      </section>

      <section className="panel council">
        <h2>Tonight’s AI council</h2>
        <ul className="personas">{(cfg?.personas ?? []).map((p) => <li key={p.id}><i style={{ background: `#${p.color.toString(16).padStart(6, '0')}` }} /><b>{p.name}</b><small>{p.trait}</small><span>{p.persona.replace(/^[^,]+, /, '')}</span></li>)}</ul>
        <p className="dim small">Each sits at a desk account (<code>seat1…seat5.{cfg?.contract ?? 'inside-job.testnet'}</code>) whose only keys are function-call keys: one may seal votes on the game contract, one may vote on the DAO. Their words come from {cfg?.nearAi ? 'a TEE-hosted model on NEAR AI Cloud, signed' : 'templates (no NEAR AI key on this server)'}; their votes come from the rules engine.</p>
      </section>

      <section className="panel onchain">
        <h2>What the chain holds</h2>
        <ul>
          <li><b>Contract</b> <a href={`https://testnet.nearblocks.io/address/${cfg?.contract}`} target="_blank" rel="noreferrer">{cfg?.contract}</a>: sealed roles, the spend policy and audit log, sealed votes and tallies, settlement.</li>
          <li><b>Treasury</b> <a href={`https://testnet.nearblocks.io/address/${cfg?.dao}`} target="_blank" rel="noreferrer">{cfg?.dao}</a>: a Sputnik DAO v2. Only the contract may propose a Transfer; only the five desks may vote; 3 of 5 approve.</li>
          <li>{cfg?.chain ? 'Chain writes are on.' : 'Chain writes are off on this server (CHAIN=0): everything plays, nothing is written.'}</li>
        </ul>
      </section>

      {recent.length > 0 && (
        <section className="panel">
          <h2>Recent nights</h2>
          <ul className="recent">{recent.map((r) => <li key={r.id}><a href={`/api/match/${r.id}/proof`} target="_blank" rel="noreferrer">{r.winner === 'crew' ? 'Crew' : 'Insider'} won ({r.reason})</a> <small>Insider: {r.insider} · {r.names.join(', ')}{r.settled ? ' · settled ✓' : ''}</small></li>)}</ul>
        </section>
      )}
      {board.length > 0 && (
        <section className="panel">
          <h2>The ledger</h2>
          <table className="ledger"><tbody>{board.map(([a, s], i) => <tr key={a}><td>{i + 1}</td><td>{a.length > 24 ? `${a.slice(0, 12)}…` : a}</td><td>{s.wins} W</td><td>{s.losses} L</td><td>{s.insider_wins}/{s.insider_games} as Insider</td><td>{s.caught} catches</td></tr>)}</tbody></table>
        </section>
      )}
      <footer className="foot">Testnet only · no real money · part of the <a href="https://arcade.lopeselio.online/" target="_blank" rel="noreferrer">NEAR Arcade</a></footer>
    </main>
  );
}

function LobbyView({ lobby, onLeave }: { lobby: Lobby; onLeave: () => void }) {
  const me = lobby.seats[lobby.you];
  const link = `${location.origin}/r/${lobby.code}`;
  return (
    <main className="lobby">
      <section className="panel">
        <h2>Room <b className="bigcode">{lobby.code}</b></h2>
        <p>Send this link, or the code: <code>{link}</code> <button className="ghost small" onClick={() => void navigator.clipboard?.writeText(link)}>Copy</button></p>
        <ul className="lobby-seats">
          {Array.from({ length: 5 }, (_, i) => lobby.seats[i]).map((s, i) => (
            <li key={i} className={s ? (s.ready ? 'ready' : '') : 'empty'}>
              <b>{s ? s.name : 'empty chair'}</b>
              <small>{s ? `${s.ai ? 'AI council' : s.signedIn ? 'signed in' : 'guest'}${s.ready ? ' · ready' : ''}${!s.here ? ' · away' : ''}` : 'an AI member takes it at the start'}</small>
              {lobby.host && s && i !== lobby.you && <button className="ghost small" onClick={() => net.send({ t: 'kick', seat: i })}>remove</button>}
            </li>
          ))}
        </ul>
        <div className="row">
          <button className={me?.ready ? '' : 'primary'} onClick={() => net.send({ t: 'ready', ready: !me?.ready })}>{me?.ready ? 'Not ready' : 'Ready'}</button>
          {lobby.host && lobby.seats.length < 5 && <button onClick={() => net.send({ t: 'addAi' })}>Add an AI member</button>}
          {lobby.host && <button onClick={() => net.send({ t: 'start' })}>Start now</button>}
          <button className="ghost" onClick={onLeave}>Leave</button>
        </div>
        <p className="dim small">The match starts when every human is ready (two or more people), or when the host starts it. Empty chairs go to the AI council.</p>
      </section>
    </main>
  );
}
