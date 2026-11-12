# Inside Job

A social-deduction night shift at a DAO, in voxels, on NEAR. Five council members run the treasury through the night; one of them is secretly the **Insider**, draining it with fake vendor invoices. The crew does its duties, vets every spend before it leaves a **real Sputnik DAO** on testnet, and votes the Insider out. Every role and every eject vote is **sealed onchain**; the AI council members talk through a **TEE model on NEAR AI** and vote through **desk accounts that can't move money**.

**Play it: https://inside-job.lopeselio.online** (in the browser; guests need no wallet and nothing to install).

Part of the **NEAR Arcade** submission for NEAR HACKATHON ([arcade.lopeselio.online](https://arcade.lopeselio.online), [github.com/lopeselio/near-arcade](https://github.com/lopeselio/near-arcade)). The author's other submission is **Signalfire** ([github.com/lopeselio/signalfire](https://github.com/lopeselio/signalfire)).

Tracks: **Games**, **Social Money**, **AI Security & Defense**, **Privacy & Private AI**, **Agents** (what the agents do and don't do is spelled out [below](#what-the-ai-council-members-do)). Design: [DESIGN.md](DESIGN.md).

- Contract (testnet): [`inside-job.testnet`](https://testnet.nearblocks.io/address/inside-job.testnet). Treasury: the Sputnik DAO v2 [`dao.inside-job.testnet`](https://testnet.nearblocks.io/address/dao.inside-job.testnet).
- AI council desks (function-call keys only): `seat1` … `seat5.inside-job.testnet`. Referee: `inside-job-ref.testnet`. Gasless relayer: `inside-job-relay.testnet`.

## Try it (do X, see Y)

Steps 1–9 run on the hosted game, **https://inside-job.lopeselio.online**. Steps 7 and 10 also need the repo (`git clone https://github.com/lopeselio/inside-job && cd inside-job && pnpm install`). To run your own server, see [Running it locally](#running-it-locally).

1. **Play with the AI council.** Type a name, press **Play with the AI council**. A walkthrough explains the game (once; **How to play** reopens it). In a solo match the clock waits while the walkthrough or your role card is open; it starts when you press **Start the night shift**. Your sealed role appears: *You are crew* or *You are the Insider*, with "✓ it opens with your salt": your browser checked your role against the commitment the server posted before you saw it.
2. **Walk and do a duty.** **WASD** / arrows (a joystick on touch screens). A gold ring marks a usable station; press **E**. Each duty is a small puzzle (sort receipts, patch wires, brew coffee). "Prepare a vendor invoice" asks you to pick the vendor's *exact* account among lookalikes, then files an honest spend.
3. **Watch the treasury.** The right panel shows every spend: payee, amount, terminal, time, the contract's **audit flags** (`lookalike`, `new payee`, `over cap`, `vault terminal`, `burst`) and each seat's vote. Go to the **Audit desk** (Audit office) and approve or reject: each vote goes from your seat's desk account to the DAO as `act_proposal`. Three approvals pay a spend out; if it was a drain, it shows **DRAINED**.
4. **Meetings.** Every 75 s, or when someone reports a frozen member (**R**) or rings the bell at the council table (**E**), the meeting opens. The AI members speak (lines marked **✓ NEAR AI TEE** are signed by the enclave). Type to accuse; they answer. Press **Ready to vote**, click a seat to eject (or skip), approve or reject the open spends, **Seal my vote**. The tally shows who voted for whom.
5. **As the Insider:** **F** at the vault terminal (Vault) or payroll desk (Payroll) to file a skim: pick a shell company or a lookalike, and an amount, and you see which flags it will get (anywhere else, F tells you where to go), **Q** to freeze a crew member next to you, **L** for lights out (the crew's vision shrinks until someone fixes the breaker). Don't wait it out: the AI crew finishes all 20 duties in about two to three minutes, and that is a crew win.
6. **The end.** The result names the Insider and unseals every spend's filer. With chain writes on, "✓ Settled onchain" appears once the contract has opened the seed and every filer and read each spend's status from the DAO. **Proof bundle (JSON)** has the seed, every salt, the input log and the signed AI lines. Reloading after the end goes back to the title, where the match is listed under **Recent nights**.
7. **Check it yourself**, with no keys and without trusting our server. It fetches the proof bundle from the hosted game, then reads the contract and the DAO over public RPC (it moves on to the next public RPC, and backs off, when one is rate-limited). The match id is on the result screen, with the exact command. A real match on the hosted game:

   ```
   $ pnpm verify m-mw9m9fu0-42d3a6
   ✓ seed matches the hash committed at create_match (inside-job.testnet)
   ✓ all 5 sealed roles open; the seed deals the Insider to seat 4 (Sable)
   ✓ replaying 9 logged inputs reaches the recorded end: crew win by ejected at 110 s
   ✓ all 7 spends in the audit log match the replay, flags included; every sealed filer opens (3 filed by the Insider)
   ✓ 8 sealed eject votes open to what was cast; the contract's 2 tallies match the replay (seat 4 ejected)
   ✓ the Sputnik DAO (dao.inside-job.testnet) holds the same 28 council votes and statuses as the replay
   ✓ the contract settled it: crew win by ejected, Insider seat 4, 21 credits drained
   · 8 AI lines in the bundle, 8 signed by the NEAR AI TEE (request, response and signature included)
   ```

   `--host <url>` checks a match on another server (e.g. `--host http://localhost:8841`).
8. **Play with friends.** **Create a room**, send the link (`/r/CODE`) or the 4-letter code. Friends **Join** as guests (no wallet). The host can **Add an AI member**; everyone presses **Ready** (or the host presses **Start now**). Empty chairs go to the AI council. If someone drops, an AI holds their chair after 15 s and hands it back when they reconnect.
9. **Sign in with NEAR** (top right; NEAR Connect: Meteor, Intear, HOT, MyNearWallet, …). The wallet signs "Sign in to <host>" (NEP-413); Better Auth + better-near-auth start a session. Your seat is labelled with your account, and a few seconds into the match your wallet **claims the seat** (`claim_seat`, a gasless NEP-366 meta-transaction paid by `inside-job-relay.testnet`), so the result counts on **the ledger** (`leaderboard` on the contract; "The ledger" on the title screen).

   Onchain evidence from a signed-in run on the hosted game (step 10's `--signed-in` run, where a fresh testnet account stands in for the wallet): match `m-mwdkhtwr-efc4fd`. The player's gasless [`claim_seat`](https://testnet.nearblocks.io/txns/25SUtyHqkX3RvxDHwiGS5C5KKYKQCez24qsyUUWSYnoC) was relayed by `inside-job-relay.testnet`, then [`settle`](https://testnet.nearblocks.io/txns/2KkvsYaDUgAo4HeoFzLA76ibdVnadKKsuqPYPikemgwZ) wrote its row to the ledger: `stats_of e2e-mwdkhkg9.inside-job.testnet` → `{"games":1,"wins":1,"losses":0,…}`. Checking it:

   ```
   $ pnpm verify m-mwdkhtwr-efc4fd
   ✓ seed matches the hash committed at create_match (inside-job.testnet)
   ✓ all 5 sealed roles open; the seed deals the Insider to seat 2 (Wren)
   ✓ replaying 8 logged inputs reaches the recorded end: crew win by ejected at 174 s
   ✓ all 7 spends in the audit log match the replay, flags included; every sealed filer opens (4 filed by the Insider)
   ✓ 7 sealed eject votes open to what was cast; the contract's 2 tallies match the replay (seat 2 ejected)
   ✓ the Sputnik DAO (dao.inside-job.testnet) holds the same 23 council votes and statuses as the replay
   ✓ the contract settled it: crew win by ejected, Insider seat 2, 22 credits drained
   · seat 1 belongs to e2e-mwdkhkg9.inside-job.testnet: claimed from that wallet (claim_seat), so the result counts on the ledger
   · 7 AI lines in the bundle, 7 signed by the NEAR AI TEE (request, response and signature included)
   ```

   <!-- A run signed in with a real wallet goes here: match id, claim_seat and settle links, and the verify output. -->

10. **Headless, against testnet:** `pnpm e2e --host https://inside-job.lopeselio.online` sits down in a solo match like a browser (as a guest), checks its sealed role, hands its chair to the AI planner, and prints every transaction once the match is settled. Add `--signed-in` to play as a signed-in player instead: a fresh testnet account signs in with NEP-413, claims its seat through the relayer, and its ledger row is printed at the end. Without `--host` it plays against a local server (`http://localhost:8841`). `GET /api/status` shows each desk's balance and remaining key allowance.

   <details><summary>The full signed-in run on the hosted game (every transaction)</summary>

   ```
   $ pnpm e2e --host https://inside-job.lopeselio.online --signed-in
   player e2e-mwdkhkg9.inside-job.testnet (a fresh testnet account standing in for a wallet)
   signed in (NEP-413 "Sign in to inside-job.lopeselio.online"); the server sees e2e-mwdkhkg9.inside-job.testnet
      1s  match m-mwdkhtwr-efc4fd: seat 1, role crew; my role opens my sealed commitment
      1s  play; treasury 100, duties 0/20, spends 0
      8s  claim_seat (gasless, NEP-366 through the relayer) https://testnet.nearblocks.io/txns/25SUtyHqkX3RvxDHwiGS5C5KKYKQCez24qsyUUWSYnoC
     76s  meeting 1 (session) discuss; treasury 85, duties 11/20, spends 5
     77s    seat 2: Spend three lacks my vote. Basil approved payees not on file. Basil should be ejected.  [signed by NEAR AI TEE]
     78s    seat 3: I'm with Wren on that hunch, but the fake vendor invoices are suspicious too. Who voted on that unfiled Tidewater payment?  [signed by NEAR AI TEE]
     80s    seat 4: E2E approved two suspicious invoices instantly. They are the only one voting yes on flagged items while awake.  [signed by NEAR AI TEE]
     81s    seat 5: I'm so sorry, but Basil approved that suspicious courier spend with E2E. I think Basil is the Insider.  [signed by NEAR AI TEE]
     85s  meeting 1 (session) vote; treasury 85, duties 11/20, spends 5
     85s  meeting 1 (session) reveal; treasury 74, duties 11/20, spends 5
     85s    tally: · #3 skip skip skip → nobody
     92s  play; treasury 74, duties 11/20, spends 5
    165s  meeting 2 (report) discuss; treasury 63, duties 17/20, spends 7
    167s    seat 2: Pax voted yes on all drains. Pax is the Insider.  [signed by NEAR AI TEE]
    168s    seat 4: Basil voted for the shell companies, so they are compromised. The Insider must be one of the remaining voters on those drains: Wren or Pax.  [signed by NEAR AI TEE]
    169s    seat 5: I'm so sorry, but Wren voted yes on Spend 3 while Sable voted yes too, and Wren voted yes on Spend 4 which Sable opposed. Wren seems suspicious to me.  [signed by NEAR AI TEE]
    174s  meeting 2 (report) vote; treasury 63, duties 17/20, spends 7
    175s  over; treasury 63, duties 17/20, spends 7
    175s    tally: · #5 · #2 #2 → seat 2 ejected
    175s  over: crew by ejected (Insider: seat 2); waiting for the settlement…
    182s  over: crew by ejected (Insider: seat 2)
    182s  settled onchain: {"winner":"crew","reason":"ejected","insider":1,"drained":22,"seed":"76cd4104e8a4137b80c1d15364cd1dcd0009befb4e9238c2bccf630684ce9fac","filers":[0,4,2,1,1,1,1],"disputed":false,"settled_ms":1794489310160}
     create_match                             https://testnet.nearblocks.io/txns/GD727ByjLYNBZUijLc5UxnPtbHwB83WJdFL7X1dJRWfx
     file_spend #0                            https://testnet.nearblocks.io/txns/E8fWqFXQgF2CHkJv93p7kNpqdJ2nQSHgv95EVEaD6ky3
     file_spend #1                            https://testnet.nearblocks.io/txns/9uWbbsewww6YXKAWPgY4W2dd94z1Jtc67UEb6pvfbziE
     file_spend #2                            https://testnet.nearblocks.io/txns/EsQUCHZ13B6yWgSjPzTvLbTZysbhRsH9C3rRWdGZm4Uh
     file_spend #3                            https://testnet.nearblocks.io/txns/HHGqfGz6NbjmkY9cy5DpBjvp2WcD6HeHywuY5icxRezJ
     seat 3 approves #0 (DAO)                 https://testnet.nearblocks.io/txns/4keFTGTmRf5bTouCBjWBDYaxGvsS3v3HGGs1DvQhVCi2
     seat 3 approves #1 (DAO)                 https://testnet.nearblocks.io/txns/2GxWWt71fanbYh2XrAkCd1zSuEfr8eDGtabcNHKsLpXj
     seat 2 approves #0 (DAO)                 https://testnet.nearblocks.io/txns/3ZQhRZZ1n1ZaAXgRDDP13pcb8FAdQBL25W5sfGix24im
     seat 5 approves #1 (DAO)                 https://testnet.nearblocks.io/txns/DCoDV8knFCPt1Kw2te9vnzWr6xAp8ab89epbXZaMPjnD
     seat 1 approves #2 (DAO)                 https://testnet.nearblocks.io/txns/7TwuYqgtY2PEVu5TasECqWCnA87BErXxGTPbnZ1eZLcv
     seat 5 approves #0 (DAO)                 https://testnet.nearblocks.io/txns/HhPy4x1sJLFGcgFdTnVdGDDfo7JWKUEEnMBNURUX9jK8
     seat 1 approves #1 (DAO)                 https://testnet.nearblocks.io/txns/HRs7SwnDw59fSHvrZeRAcD6fEYrqL4CACmQ2xV9vrriL
     seat 5 approves #2 (DAO)                 https://testnet.nearblocks.io/txns/A5rS5iJRUiCQcmLR3UdC7JGgyW5w3K4Wd3vajvxUUvAa
     seat 4 rejects #2 (DAO)                  https://testnet.nearblocks.io/txns/9TbJKfa44BviwZqVDWx7dqdjXg18Nnmy9pzNHWb7ucwV
     seat 3 approves #2 (DAO)                 https://testnet.nearblocks.io/txns/747QNrL1kF7vwKwoWLHC9Am5nkPzw6TtqpAQAnv285Um
     file_spend #4                            https://testnet.nearblocks.io/txns/FugyL5QBJkfUuqUpoHscYDMBxLsBHW1gqR9uvzgNrEAM
     seat 2 approves #3 (DAO)                 https://testnet.nearblocks.io/txns/HrCoAGig4hf2JyjgLrs9hSPVzvdz8DtAye6HyWSdX1s1
     seat 2 seals its vote (meeting 1)        https://testnet.nearblocks.io/txns/8fsXL74C1B8Yaq5DojjnawT4PpPXV7A7NCgpMKk5UynY
     seat 3 seals its vote (meeting 1)        https://testnet.nearblocks.io/txns/7PYNto8PiPT3is6yTRpUJwJ1BykFJ5vk2gkH56HRsarZ
     seat 4 seals its vote (meeting 1)        https://testnet.nearblocks.io/txns/CF4mVFUa4AFJDrQTK2pVBZgWGiLTFeWjgfJAo61bqDNn
     seat 5 seals its vote (meeting 1)        https://testnet.nearblocks.io/txns/87EozMZyEGcKcsUEuqJ45iaJtacZywE16QKPkFJDvKZv
     seat 2 approves #4 (DAO)                 https://testnet.nearblocks.io/txns/MaY12BCWu16LS8oEYjJsUep1Jj97WELkj2CjXfrkBdP
     tally_meeting 1                          https://testnet.nearblocks.io/txns/86fnVcXNJ171sgxZsXcQEmVkL64sZW9omLTtHcGetJCr
     seat 3 approves #3 (DAO)                 https://testnet.nearblocks.io/txns/2zTZffnbamGi8suhYXV2XjJnwBK2DZDaRZy3TP2Ht5Wo
     seat 3 approves #4 (DAO)                 https://testnet.nearblocks.io/txns/J2DTvf4wpqEaRArGkVAQJiyJsPNhmw7a1usPoUgbMG6r
     seat 4 approves #3 (DAO)                 https://testnet.nearblocks.io/txns/86Se9fws6Ukwi3A8WN4mZ9BSBc983QjAzzwGrLqKx5CX
     seat 4 rejects #4 (DAO)                  https://testnet.nearblocks.io/txns/98ZG6d9F57zXzGRD4w35z83wUFMSuz1e31gnT3jm1es2
     seat 5 approves #4 (DAO)                 https://testnet.nearblocks.io/txns/Eqahfqo7C4Erk8eDnb5sJrpmeUThZ4hGMM6mZYwpJNwP
     file_spend #5                            https://testnet.nearblocks.io/txns/GMgMai3HeG765N3edquEWZPt9maU1on5tfp3tfAMvMcX
     seat 5 approves #5 (DAO)                 https://testnet.nearblocks.io/txns/ENpKJpWfSu47zPkxafn8o1cv7Jbb3YpghaGyDkSLfuwy
     seat 4 approves #5 (DAO)                 https://testnet.nearblocks.io/txns/5uwGXQ9vhrtoEXU4dRkkNaXJEMWw9VRikcsmEkqd8gU5
     file_spend #6                            https://testnet.nearblocks.io/txns/HHibUdHJduuMuh5UFtTGwRJ7KXegm2Y2gRPx7rKvX559
     seat 3 approves #5 (DAO)                 https://testnet.nearblocks.io/txns/AWEd3rcZS8GPngMc5AoPZ6isAyX4nvEjhRvkSQYp438s
     seat 3 approves #6 (DAO)                 https://testnet.nearblocks.io/txns/A2Ee6bMN2Wfem3EsZvvFdxivHZobggtBWdA2jq1LEcDg
     seat 4 approves #6 (DAO)                 https://testnet.nearblocks.io/txns/AKJmrvhh1u1yF15Rn4ZshWy6r3N4qrY93d3x2nFr15Ee
     seat 5 approves #6 (DAO)                 https://testnet.nearblocks.io/txns/3eQ8W6snpNg3mSmYU81zfvytqnm2ezRrxv4Q5nUufBVs
     seat 2 seals its vote (meeting 2)        https://testnet.nearblocks.io/txns/5a1zphRjCoWgnZEXQJJrqrD7VRAQCiyj9V94tm1MvM4A
     seat 5 seals its vote (meeting 2)        https://testnet.nearblocks.io/txns/9ndU7XXpArKEcqoS29beswCqnmVBHup1M95JR5TPcNNN
     seat 4 seals its vote (meeting 2)        https://testnet.nearblocks.io/txns/7YmPRS8u15xDzzcMg5JtadMuZyW62Umktu77gwEJZHf
     tally_meeting 2 (ejects seat 2)          https://testnet.nearblocks.io/txns/D4oF2GGfy5H53MyQS1UJZfy8rvTw3ft1YH3g1AY5CAog
     settle                                   https://testnet.nearblocks.io/txns/2KkvsYaDUgAo4HeoFzLA76ibdVnadKKsuqPYPikemgwZ
     claim_seat (player, gasless)             https://testnet.nearblocks.io/txns/25SUtyHqkX3RvxDHwiGS5C5KKYKQCez24qsyUUWSYnoC
   the ledger (stats_of e2e-mwdkhkg9.inside-job.testnet): {"games":1,"wins":1,"losses":0,"insider_games":0,"insider_wins":0,"caught":0}
   check it: pnpm verify m-mwdkhtwr-efc4fd
   ```

   </details>

## How it works

```
apps/web           three.js voxel office + React HUD (Vite); duty puzzles; NEAR Connect wallet; guests need no wallet
apps/server        rooms over WebSocket (authoritative 10 Hz sim), the chain mirror, AI talk, Better Auth, verify + e2e + setup CLIs
packages/rules     the deterministic sim: map, duties, spends, audit flags, freezes, meetings, wins, views, replay; commitments; the AI planner
contracts/council  Rust near-sdk 5.29: sealed roles and votes, the spend policy + audit log, Sputnik DAO filings, tallies, settlement, ledger
```

- **The treasury is a real Sputnik DAO** (Social Money). `dao.inside-job.testnet` runs the Sputnik DAO v2 code (deployed from the global contract `dao.globals.primitives.testnet`, as in the [NEAR docs](https://docs.near.org/primitives/dao)). Its policy: only the contract (`terminal` role) may add a Transfer proposal; only the five desks (`council` role) may vote; 3 of 5 approve. Each spend in the game is a proposal there; each council vote is an `act_proposal` from that seat's desk; an approved drain really moves testnet NEAR (1 credit = 0.001 NEAR) to a shell account.
- **Policy, audit log and agents** (AI Security). Every spend passes the contract's `file_spend` first: payee must be one of the game's 16 named accounts, 1–15 credits, at most 16 spends and 100 credits per match. The contract then writes the audit log entry with its flags (onchain and as a `spend_filed` event) and puts the flags in the DAO proposal's description. The AI council members sit at desk accounts that the contract created with **two function-call keys and nothing else** (`commit_vote` here, `act_proposal` on the DAO, each with a gas allowance): they can vote, and can't send money or call anything else. Telling real invoices from drains (lookalike accounts, shells, wrong terminal, bursts) is the crew's whole job.
- **Sealed roles, votes and filers** (Privacy). At `create_match` the referee posts the seed's hash and five role commitments; the seed itself decides the Insider, so it can't be picked after seeing who sat down. Each player gets only their own role and salt. Eject votes are committed by each desk during the vote and opened at the tally, where the contract counts them. Who filed each spend is committed too; spends reach the DAO from the contract, so the proposer never reveals the filer. `settle` opens everything, re-checks it, and reads every spend's status from the DAO itself (cross-contract `get_proposal`) to add up the drain. Where it can prove the outcome (Insider ejected, 25+ drained), it overrides the referee.
- **Private AI.** The AI members' meeting talk comes from a TEE-hosted model on NEAR AI Cloud; each line is stored with its exact request, response and the enclave's signature. The model is told only what that seat could know (its own role, its own sightings, the public record, the chat) and answers `{say, suspect}`. The rules engine casts the vote: a crew member's planner accepts the model's suspect only if its own suspicion backs it. `/api/attestation` returns a fresh attestation report.
- **Deterministic rules.** `packages/rules` has no `Math.random`, `Date` or DOM. The server logs every input; `replay()` reproduces the match and its state hash. The AI planner plays from its own seat's sight only.

### What the AI council members do

Plainly: they are **players and voters, not traders**. Each AI member sits at its own desk account (`seat1…seat5.inside-job.testnet`) and, during a match:

- **talks** in meetings through a TEE-hosted model on NEAR AI Cloud (each line signed by the enclave, kept in the proof bundle);
- **votes on every spend** on the real Sputnik DAO (`act_proposal` from its desk: approve or reject a Transfer), and **seals its eject vote** on the game contract (`commit_vote`);
- **walks, does duties, and (when dealt the Insider) skims, freezes and lies**: the deterministic planner in `packages/rules/src/bot.ts` decides every move, ballot and spend; the model only supplies words and may name a suspect, which the planner accepts only if its own suspicion backs it.

They don't hold or earn money of their own: their desk keys are function-call keys that can't transfer NEAR, and any money that moves goes from the DAO treasury by a 3-of-5 vote. An approved spend really moves testnet NEAR to a payee account, but the "earning" in this game is the treasury paying invoices, not the agents getting rich. The point is the security side: agents that can act on a treasury only through narrow, auditable keys, and a policy engine and audit log they can't skip.

### What the chain does *not* prove

- **Movement, duties and freezes** happen in the server's sim. They're reproducible from the public input log (`pnpm verify` replays them), but the contract doesn't re-run the sim; for "duties", "outnumbered" and "closed" endings it records the referee's claim.
- **The server knows every role**: it runs the sim and the AI. The seals stop it from *changing* a role, a vote or a filer after the fact, and stop other players and chain watchers from learning them early. Moving the referee into a TEE would close the rest; it isn't done.
- **Human seats' desk keys are held by the server**, which casts their DAO votes and vote commitments as the player chose. Signed-in players claim their seat from their own wallet, but their in-game votes still go through the desk.
- `alive` at a tally is the referee's word (freezes are offchain).
- **The treasury DAO still has a full-access key.** `dao.inside-job.testnet` keeps the full-access key it was deployed with, so whoever holds it could redeploy the DAO, change its members or move its NEAR without a vote. It is kept on purpose for the hackathon (testnet money, and so the DAO can still be fixed). Deleting it would make the 3-of-5 council vote the only way money moves, at the cost of never being able to upgrade the DAO; that is the planned next step.

## Running it locally

```bash
pnpm install
pnpm build            # the web app
pnpm start            # http://localhost:8841 (server + built web app)
```

With no NEAR keys, run `CHAIN=0 pnpm start`: everything plays the same, nothing is written onchain. A match played on your own server is verified with `pnpm verify <matchId> --host http://localhost:8841`.

## Tests

```bash
pnpm --filter @inside-job/rules test   # 16: shared hash vector, audit flags, 3-of-5 votes, tallies, freezes, skims, views, AI ballots, replay
pnpm contract:test                     # 18: hash vector, flags, policy refusals, desks' keys, sealed votes, tallies, settlement against DAO statuses
pnpm typecheck                         # rules, server, web
pnpm sim 300                           # AI-only balance: crew ≈64% (duties 50, ejected 14), Insider ≈36% (outnumbered 23, drained 13), ≈3.3 min
pnpm e2e --host <url> [--signed-in]   # a full match on testnet, as a guest or as a signed-in player (default host: localhost:8841)
pnpm verify <matchId> [--host <url>]  # re-check a finished match against the contract and the DAO (default host: the hosted game)
```

## Deploying

- **Accounts:** `near account create-account sponsor-by-faucet-service <id> autogenerate-new-keypair save-to-legacy-keychain network-config testnet create` for `inside-job`, `inside-job-ref`, `inside-job-relay`.
- **DAO:** create `dao.inside-job.testnet` from `inside-job.testnet` (fund it: that's the treasury), then `near contract deploy dao.inside-job.testnet use-global-account-id dao.globals.primitives.testnet with-init-call new json-args '{"config":…,"policy":{"roles":[{"name":"terminal","kind":{"Group":["inside-job.testnet"]},"permissions":["transfer:AddProposal"],"vote_policy":{}},{"name":"council","kind":{"Group":["seat1.inside-job.testnet",…]},"permissions":["transfer:VoteApprove","transfer:VoteReject","transfer:Finalize"],"vote_policy":{}}],"default_vote_policy":{"weight_kind":"RoleWeight","quorum":"0","threshold":[1,2]},"proposal_bond":"0","proposal_period":"3600000000000","bounty_bond":"0","bounty_forgiveness_period":"86400000000000"}}' …`.
- **Contract:** `pnpm contract:build`, then `near contract deploy inside-job.testnet use-file contracts/council/target/near/inside_job_council.wasm with-init-call new json-args '{"owner":"inside-job.testnet","referee":"inside-job-ref.testnet","dao":"dao.inside-job.testnet"}' …` (later: `without-init-call`).
- **Desks and payees:** `pnpm setup:agents` (idempotent): creates `seat1…seat5` with their two function-call keys and the 16 keyless payee accounts.
- **Hosting:** `scripts/deploy-azure.sh` (Azure Container Apps, resource group `inside-job`, one replica: rooms live in memory). `scripts/azure-storage.sh` mounts an Azure Files share at `/data` once, so match records and proof bundles survive redeploys.

## Lineage and disclosures

- **Inspiration.** The social-deduction genre, and the idea of putting one on a chain, come from games we admired, especially [Who Rug Us?](https://github.com/AiltonSavio/who-rug-us-monorepo) (Solana/MagicBlock). Inside Job reuses **no code, names, rooms, text or art** from it: the office, the treasury-and-spends mechanic, the DAO integration, the contract and the visuals are our own.
- **The NEAR Arcade.** Inside Job is one of the nine games in the author's NEAR Arcade submission ([arcade.lopeselio.online](https://arcade.lopeselio.online)): Sushi Sabotage, Bazaar of Liars, Realm Ledger, Parkwright, Fogwater, Emberfall, Inside Job, Kraterra and Clawtide. Each game has its own repo, contract, rules, art and server; they share a stack and a sign-in pattern (Better Auth + better-near-auth). The author's other NEAR HACKATHON submission is [Signalfire](https://github.com/lopeselio/signalfire).
- **AI-written code:** written with an AI coding assistant (Claude Code) and reviewed by the author.
- **Libraries:** three.js, React, better-auth and better-near-auth, near-api-js, near-kit, @noble/hashes, ws, Vite, near-sdk (Rust). The treasury runs the Sputnik DAO v2 contract (near-daos/sputnik-dao-contract) via NEAR's global contract.
- **Assets:** every model is procedural boxes in `apps/web/src/scene.ts`; sounds are synthesised in WebAudio; fonts are Inter and Silkscreen (Google Fonts, OFL).

## License

MIT
