# Inside Job

A social-deduction night shift at a DAO, in voxels, on NEAR. Five council members run the treasury through the night; one of them is secretly the **Insider**, draining it with fake vendor invoices. The crew does its duties, vets every spend before it leaves a **real Sputnik DAO** on testnet, and votes the Insider out. Every role and every eject vote is **sealed onchain**; the AI council members talk through a **TEE model on NEAR AI** and vote through **desk accounts that can't move money**.

Built for NEAR HACKATHON (Nov 2026). Tracks: **Social Money**, **AI Security & Defense**, **Privacy & Private AI** (and Agents, Games). Design: [DESIGN.md](DESIGN.md).

- Contract (testnet): [`inside-job.testnet`](https://testnet.nearblocks.io/address/inside-job.testnet). Treasury: the Sputnik DAO v2 [`dao.inside-job.testnet`](https://testnet.nearblocks.io/address/dao.inside-job.testnet).
- AI council desks (function-call keys only): `seat1` … `seat5.inside-job.testnet`. Referee: `inside-job-ref.testnet`. Gasless relayer: `inside-job-relay.testnet`.

## Try it (do X, see Y)

```bash
pnpm install
pnpm build            # the web app
pnpm start            # http://localhost:8841 (server + built web app)
```

With no NEAR keys, run `CHAIN=0 pnpm start`: everything plays the same, nothing is written onchain.

1. **Play with the AI council.** Type a name, press **Play with the AI council**. A walkthrough explains the game (once; **How to play** reopens it). Your sealed role appears: *You are crew* or *You are the Insider*, with "✓ it opens with your salt": your browser checked your role against the commitment the server posted before you saw it.
2. **Walk and do a duty.** **WASD** / arrows (a joystick on touch screens). A gold ring marks a usable station; press **E**. Each duty is a small puzzle (sort receipts, patch wires, brew coffee). "Prepare a vendor invoice" asks you to pick the vendor's *exact* account among lookalikes, then files an honest spend.
3. **Watch the treasury.** The right panel shows every spend: payee, amount, terminal, time, the contract's **audit flags** (`lookalike`, `new payee`, `over cap`, `vault terminal`, `burst`) and each seat's vote. Go to the **Audit desk** (Audit office) and approve or reject: each vote goes from your seat's desk account to the DAO as `act_proposal`. Three approvals pay a spend out; if it was a drain, it shows **DRAINED**.
4. **Meetings.** Every 75 s, or when someone reports a frozen member (**R**) or rings the bell at the council table (**E**), the meeting opens. The AI members speak (lines marked **✓ NEAR AI TEE** are signed by the enclave). Type to accuse; they answer. Press **Ready to vote**, click a seat to eject (or skip), approve or reject the open spends, **Seal my vote**. The tally shows who voted for whom.
5. **As the Insider:** **F** at the vault terminal or payroll desk to file a skim (pick a shell company or a lookalike, and an amount; you see which flags it will get), **Q** to freeze a crew member next to you, **L** for lights out (the crew's vision shrinks until someone fixes the breaker).
6. **The end.** The result names the Insider and unseals every spend's filer. With chain writes on, "✓ Settled onchain" appears once the contract has opened the seed and every filer and read each spend's status from the DAO. **Proof bundle (JSON)** has the seed, every salt, the input log and the signed AI lines.
7. **Check it yourself**, with no keys and without trusting our server. It fetches the proof bundle, then reads the contract and the DAO over public RPC. A real testnet match (its record is in `data/` of the machine that played it; pass that server's URL):

   ```
   $ pnpm verify m-mw99bckc-024db6
   ✓ seed matches the hash committed at create_match (inside-job.testnet)
   ✓ all 5 sealed roles open; the seed deals the Insider to seat 4 (Sable)
   ✓ replaying 11 logged inputs reaches the recorded end: crew win by ejected at 130 s
   ✓ all 7 spends in the audit log match the replay, flags included; every sealed filer opens (3 filed by the Insider)
   ✓ 10 sealed eject votes open to what was cast; the contract's 3 tallies match the replay (seat 3 ejected, seat 4 ejected)
   ✓ the Sputnik DAO (dao.inside-job.testnet) holds the same 23 council votes and statuses as the replay
   ✓ the contract settled it: crew win by ejected, Insider seat 4, 0 credits drained
   · 10 AI lines in the bundle, 10 signed by the NEAR AI TEE (request, response and signature included)
   ```
8. **Play with friends.** **Create a room**, send the link (`/r/CODE`) or the 4-letter code. Friends **Join** as guests (no wallet). The host can **Add an AI member**; everyone presses **Ready** (or the host presses **Start now**). Empty chairs go to the AI council. If someone drops, an AI holds their chair after 15 s and hands it back when they reconnect.
9. **Sign in with NEAR** (top right; NEAR Connect: Meteor, Intear, HOT, MyNearWallet, …). The wallet signs "Sign in to <host>" (NEP-413); Better Auth + better-near-auth start a session. Your seat is labelled with your account, and a few seconds into the match your wallet **claims the seat** (`claim_seat`, a gasless NEP-366 meta-transaction paid by `inside-job-relay.testnet`), so the result counts on **the ledger** (`leaderboard` on the contract).
10. **Headless, against testnet:** `pnpm e2e http://localhost:8841` sits down in a solo match like a browser, checks its sealed role, hands its chair to the AI planner, and prints every transaction once the match is settled. `GET /api/status` shows each desk's balance and remaining key allowance.

   A run (abridged):

   ```
      0s  match m-mw99bckc-024db6: seat 1, role crew; my role opens my sealed commitment
     50s  meeting 1 (report) discuss; treasury 82, duties 6/20, spends 5
     55s    seat 2: Pax is frozen. Basil was seen. I suspect Basil.  [signed by NEAR AI TEE]
     59s    tally: #3 skip #1 #3 · → seat 3 ejected
    127s    seat 2: Sable was in the vault at 1:55. Sable approved Spend 5 for 11 credits. Sable is the Insider.  [signed by NEAR AI TEE]
    130s  over: crew by ejected (Insider: seat 4)
      create_match            https://testnet.nearblocks.io/txns/…
      file_spend #0           …   seat 2 approves #0 (DAO)   …   seat 5 seals its vote (meeting 1)   …
      tally_meeting 3 (ejects seat 4)   …   settle   …
   ```

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

### What the chain does *not* prove

- **Movement, duties and freezes** happen in the server's sim. They're reproducible from the public input log (`pnpm verify` replays them), but the contract doesn't re-run the sim; for "duties", "outnumbered" and "closed" endings it records the referee's claim.
- **The server knows every role**: it runs the sim and the AI. The seals stop it from *changing* a role, a vote or a filer after the fact, and stop other players and chain watchers from learning them early. Moving the referee into a TEE would close the rest; it isn't done.
- **Human seats' desk keys are held by the server**, which casts their DAO votes and vote commitments as the player chose. Signed-in players claim their seat from their own wallet, but their in-game votes still go through the desk.
- `alive` at a tally is the referee's word (freezes are offchain).
- **The treasury DAO still has a full-access key.** `dao.inside-job.testnet` keeps the full-access key it was deployed with, so whoever holds it could redeploy the DAO, change its members or move its NEAR without a vote. It is kept on purpose for the hackathon (testnet money, and so the DAO can still be fixed). Deleting it would make the 3-of-5 council vote the only way money moves, at the cost of never being able to upgrade the DAO; that is the planned next step.

## Tests

```bash
pnpm --filter @inside-job/rules test   # 16: shared hash vector, audit flags, 3-of-5 votes, tallies, freezes, skims, views, AI ballots, replay
pnpm contract:test                     # 18: hash vector, flags, policy refusals, desks' keys, sealed votes, tallies, settlement against DAO statuses
pnpm typecheck                         # rules, server, web
pnpm sim 300                           # AI-only balance: crew ≈64% (duties 50, ejected 14), Insider ≈36% (outnumbered 23, drained 13), ≈3.3 min
pnpm e2e http://localhost:8841         # a full match on testnet
pnpm verify <matchId> [baseUrl]        # re-check a finished match against the contract and the DAO
```

## Deploying

- **Accounts:** `near account create-account sponsor-by-faucet-service <id> autogenerate-new-keypair save-to-legacy-keychain network-config testnet create` for `inside-job`, `inside-job-ref`, `inside-job-relay`.
- **DAO:** create `dao.inside-job.testnet` from `inside-job.testnet` (fund it: that's the treasury), then `near contract deploy dao.inside-job.testnet use-global-account-id dao.globals.primitives.testnet with-init-call new json-args '{"config":…,"policy":{"roles":[{"name":"terminal","kind":{"Group":["inside-job.testnet"]},"permissions":["transfer:AddProposal"],"vote_policy":{}},{"name":"council","kind":{"Group":["seat1.inside-job.testnet",…]},"permissions":["transfer:VoteApprove","transfer:VoteReject","transfer:Finalize"],"vote_policy":{}}],"default_vote_policy":{"weight_kind":"RoleWeight","quorum":"0","threshold":[1,2]},"proposal_bond":"0","proposal_period":"3600000000000","bounty_bond":"0","bounty_forgiveness_period":"86400000000000"}}' …`.
- **Contract:** `pnpm contract:build`, then `near contract deploy inside-job.testnet use-file contracts/council/target/near/inside_job_council.wasm with-init-call new json-args '{"owner":"inside-job.testnet","referee":"inside-job-ref.testnet","dao":"dao.inside-job.testnet"}' …` (later: `without-init-call`).
- **Desks and payees:** `pnpm setup:agents` (idempotent): creates `seat1…seat5` with their two function-call keys and the 16 keyless payee accounts.
- **Hosting:** `scripts/deploy-azure.sh` (Azure Container Apps, resource group `inside-job`, one replica: rooms live in memory). `scripts/azure-storage.sh` mounts an Azure Files share at `/data` once, so match records and proof bundles survive redeploys.

## Lineage and disclosures

- **Inspiration.** The social-deduction genre, and the idea of putting one on a chain, come from games we admired, especially [Who Rug Us?](https://github.com/AiltonSavio/who-rug-us-monorepo) (Solana/MagicBlock). Inside Job reuses **no code, names, rooms, text or art** from it: the office, the treasury-and-spends mechanic, the DAO integration, the contract and the visuals are our own.
- **Other projects.** Independent of our other NEAR HACKATHON games (Bazaar of Liars, Realm Ledger, Parkwright, Sushi Sabotage, Fogwater): its own repo, contract, rules, art and server. It reuses their stack and sign-in pattern (Better Auth + better-near-auth) and sits beside them in the NEAR Arcade.
- **AI-written code:** written with an AI coding assistant (Claude Code) and reviewed by the author.
- **Libraries:** three.js, React, better-auth and better-near-auth, near-api-js, near-kit, @noble/hashes, ws, Vite, near-sdk (Rust). The treasury runs the Sputnik DAO v2 contract (near-daos/sputnik-dao-contract) via NEAR's global contract.
- **Assets:** every model is procedural boxes in `apps/web/src/scene.ts`; sounds are synthesised in WebAudio; fonts are Inter and Silkscreen (Google Fonts, OFL).

## License

MIT
