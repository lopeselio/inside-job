import { useState } from 'react';

// The first-match walkthrough. Shown once (remembered in localStorage); "How to play" reopens it.

const KEY = 'inside-job:onboarded';
export const onboarded = (): boolean => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const remember = (): void => { try { localStorage.setItem(KEY, '1'); } catch { /* fine */ } };

const STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: 'Five council members. One Insider.',
    body: <>
      <p>It’s night at a small DAO. Five council members are still in the office: you and four others (AI council members, or friends in a room). One of you is secretly the <b>Insider</b>, here to drain the treasury.</p>
      <p>Your role card (top left) says which you are. Nobody else sees it: not the other players, not the AI, and the server can’t change it, because every role was <b>sealed onchain</b> before anyone saw theirs.</p>
    </>,
  },
  {
    title: 'Duties',
    body: <>
      <p>Walk with <kbd>WASD</kbd> or the arrow keys (a joystick on touch screens). A gold ring marks a station you can use: press <kbd>E</kbd>.</p>
      <p>Crew have five duties: count the reserves, patch the validator, brew the night coffee… each is a small puzzle. When every crew duty is done, <b>the crew wins</b>. Frozen members finish theirs as ghosts.</p>
      <p>The Insider has fake duties to stand at, to blend in.</p>
    </>,
  },
  {
    title: 'The treasury is a real Sputnik DAO',
    body: <>
      <p>Money leaves only as <b>spends</b>: Transfer proposals on a Sputnik DAO on NEAR testnet. Honest ones come from the “Prepare a vendor invoice” duty at the payroll desk. The Insider files fake ones (“skims”) to shell companies or lookalike accounts.</p>
      <p>Every spend needs <b>3 of 5 council approvals</b>. Vote at the <b>Audit desk</b> or in meetings. The contract writes every spend to an <b>audit log</b> with flags (lookalike payee, not on file, over the cap, filed from the vault terminal, burst). Flags are hints: new honest vendors get flagged too.</p>
      <p>If {25} credits of drains get approved, <b>the Insider wins</b>.</p>
    </>,
  },
  {
    title: 'Meetings and votes',
    body: <>
      <p>A meeting starts when someone finds a frozen member (<kbd>R</kbd>), rings the bell at the council table (once each), or every 75 seconds for the council session.</p>
      <p>First talk (type in the chat; the AI members speak too, their lines signed by a TEE model on NEAR AI). Then vote: eject someone or skip, and approve or reject the open spends. Your eject vote is <b>sealed onchain</b> from your desk account, then opened and <b>counted by the contract</b>.</p>
      <p>Vote the Insider out and <b>the crew wins</b>.</p>
    </>,
  },
  {
    title: 'If you’re the Insider',
    body: <>
      <p><kbd>F</kbd> at the vault terminal or payroll desk: file a skim. Pick a shell or a lookalike and an amount, then get it approved.</p>
      <p><kbd>Q</kbd>: freeze a crew member who is right next to you. Freeze enough and the crew is outnumbered: you win.</p>
      <p><kbd>L</kbd>: lights out. The crew can barely see until someone fixes the breaker in the server room.</p>
      <p>Who filed each spend is sealed too. Only you know which are yours, until the end.</p>
    </>,
  },
  {
    title: 'What’s onchain (and what isn’t)',
    body: <>
      <p><b>Onchain:</b> the seed’s hash and all five sealed roles; every spend with its audit flags (contract <code>inside-job.testnet</code>); every council vote on the DAO (<code>dao.inside-job.testnet</code>), sent from that seat’s own desk account, a sub-account with function-call keys only; every sealed eject vote and the contract’s tally; the settlement, which opens the seed and every filer and reads the DAO.</p>
      <p><b>Not onchain:</b> where people walked, duties, and freezes. The server runs those, and it logs every input, so <code>pnpm verify &lt;match&gt;</code> can replay the whole match and check it against the contract and the DAO.</p>
      <p>Guests need no wallet. <b>Sign in with NEAR</b> to claim your seat from your own wallet (gasless) and be ranked.</p>
    </>,
  },
];

export function Onboarding({ onClose }: { onClose: () => void }) {
  const [k, setK] = useState(0);
  const done = (): void => { remember(); onClose(); };
  const s = STEPS[k];
  return (
    <div className="modal-back" onClick={done}>
      <div className="modal onboarding" onClick={(e) => e.stopPropagation()}>
        <header><small>How to play · {k + 1} / {STEPS.length}</small><button className="ghost small" onClick={done}>Skip</button></header>
        <h2>{s.title}</h2>
        <div className="ob-body">{s.body}</div>
        <div className="dots">{STEPS.map((_, i) => <i key={i} className={i === k ? 'on' : ''} onClick={() => setK(i)} />)}</div>
        <div className="row">
          {k > 0 && <button className="ghost" onClick={() => setK(k - 1)}>Back</button>}
          {k < STEPS.length - 1 ? <button className="primary" onClick={() => setK(k + 1)}>Next</button> : <button className="primary" onClick={done}>Got it</button>}
        </div>
      </div>
    </div>
  );
}
