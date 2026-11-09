# Inside Job — design

## Pitch

It's night at a small DAO. Five council members are still in the office, and one of them is the **Insider**,
here to drain the treasury. The crew does its duties, vets every spend before it leaves a **real Sputnik DAO**,
and tries to vote the Insider out. Social deduction, where the deduction is about money moving onchain:
lookalike payee accounts, invoices from the wrong terminal, approvals that shouldn't have happened.

Tracks: **Social Money** (Sputnik DAO treasury, shared budget, named accounts), **AI Security & Defense**
(function-call-key agents, a spend policy engine, an audit log, scam detection as gameplay), **Privacy & Private
AI** (sealed roles, sealed votes, sealed filers, TEE-signed AI talk). Secondary: **Agents**, **Games**.

## Rules (packages/rules)

- **The office.** A 34×19 tile map: Vault, Server room, Audit office on top; a hall; Archive, Council room, Payroll
  below. Rooms only open onto the hall. Movement is continuous at 3 tiles/s, 10 ticks/s.
- **Seats.** Five. The seed deals one Insider (see "Sealed roles"). Everyone else is crew.
- **Duties.** Each seat gets five of seven duties (reserves, vault key, validator, receipts, mail, coffee, vendor
  invoice) at stations. A duty counts when you've stood at its station for its time (2.5–3.5 s) and finished its
  puzzle. The Insider's duties are fake (cover). When all 20 crew duties are done, **the crew wins**. Frozen and
  ejected crew finish theirs as ghosts.
- **Spends.** The treasury holds 100 credits (1 credit = 0.001 NEAR, real testnet money in the DAO). Money leaves
  only as a spend: a Transfer proposal on the DAO. Honest spends come from the "Prepare a vendor invoice" duty (a
  vendor on file 65% of the time, a new honest vendor otherwise, 3–6 credits). The Insider **skims** at the vault
  terminal or the payroll desk: a "vendor invoice" of 4–12 credits to a shell company or a lookalike of a vendor on
  file. Cooldown 24 s. The policy caps a match at 16 spends and 100 credits filed.
- **Votes on spends.** Every spend needs **3 of 5 approvals** (the DAO's own rule); 3 rejections kill it. Members
  vote at the Audit desk or in meetings. Votes are public. An honest invoice counts as its duty only once approved; a
  rejected one reopens the duty. An approved drain is exposed when the money leaves (the payee is a shell). When
  **25 credits of drains** are approved, **the Insider wins**.
- **The audit flags** (computed identically by the rules and the contract): `lookalike` (one or two edits from a
  vendor on file), `new_payee` (not on file), `over_cap` (> 8 credits), `vault_terminal`, `burst` (within 20 s of
  the previous spend). Flags are hints: honest invoices to new vendors are flagged `new_payee` too.
- **The Insider's tools.** Freeze a crew member within 1.6 tiles (cooldown 60 s, first after 38 s): they become a
  ghost and leave a frozen body. Lights out (cooldown 50 s): crew vision drops from 6.5 to 2.4 tiles for 25 s or until
  someone fixes the breaker. If only one crew member is left standing, **the Insider wins**.
- **Meetings.** Reporting a body (within 2.6 tiles), ringing the bell at the table (once per seat), or the council
  session every 75 s. Discussion (up to 35 s, at least 9 s; ends early when every human is ready), vote (22 s),
  reveal (7 s). A ballot is an eject choice (a seat or skip) plus approve/reject for open spends. The eject goes to
  the unique top count above the skips. Voting the Insider out: **the crew wins**.
- **The night ends** after 8 minutes of play: the books close and the crew wins.
- **Vision.** You see players within your vision radius in your room (or within 2.5 tiles across a doorway).
  Ghosts are invisible to the living. The server only sends each seat what it can see.

The sim is a pure function of the setup and the input log: no `Math.random`, no `Date`, no DOM. `replay()`
reproduces a match exactly; `stateHash()` pins it.

## Sealed roles, votes and filers

```
seed hash     sha256("inside-job|seed|<seed>")                                         create_match
the deal      u32be(sha256("inside-job|deal|<match>|<seed>")[0..4]) mod 5 = the Insider
role salt     hex(sha256("inside-job|salt|<seed>|<seat>"))
role commit   sha256("inside-job|role|<match>|<seat>|<crew|insider>|<salt>")            create_match, one per seat
vote commit   sha256("inside-job|vote|<match>|<meeting>|<seat>|<choice>|<salt>")        commit_vote, from the seat's desk
filer commit  sha256("inside-job|filer|<match>|<n>|<seat>|<salt>")                       file_spend
```

- At the start each player receives only their own role and salt, and checks it against their commitment.
- Eject votes are committed by each seat's own desk account during the vote and opened by the referee at the
  tally; the contract checks every opening and counts the votes itself (`tally_meeting`).
- Who filed each spend is committed at filing. Spends reach the DAO from the contract (the "terminal"), so the
  DAO's proposer field never reveals the filer.
- `settle` opens the seed, re-derives the deal and every role commitment, opens every filer, then reads every
  spend's status from the DAO (cross-contract `get_proposal`) and adds up what the Insider drained. Where the
  contract can prove the result (the Insider ejected; 25+ drained) it overrides the referee's claim and marks it
  disputed.

`packages/rules/src/hash.ts` and `contracts/council/src/lib.rs` build the same strings; a shared vector pins them.

## Onchain

| Account | What it is |
|---|---|
| `inside-job.testnet` | the council contract (Rust, near-sdk 5.29): matches, policy, audit log, sealed votes, tallies, settlement, ledger |
| `dao.inside-job.testnet` | a Sputnik DAO v2 (deployed from the global contract `dao.globals.primitives.testnet`); the treasury |
| `seat1…seat5.inside-job.testnet` | the five desks; each has only two function-call keys: `commit_vote` on the contract, `act_proposal` on the DAO |
| `inside-job-ref.testnet` | the referee (creates matches, files spends, opens tallies, settles) |
| `inside-job-relay.testnet` | pays gas for signed-in players' meta-transactions (NEP-366) |
| 16 payee sub-accounts | vendors, new vendors, shells, lookalikes; keyless |

**DAO policy.** Role `terminal` = `{inside-job.testnet}` with `transfer:AddProposal`. Role `council` = the five
desks with `transfer:VoteApprove`, `transfer:VoteReject`, `transfer:Finalize`. RoleWeight, threshold 1/2 (→ 3 of 5).
No bond. Nobody can add any other kind of proposal, so the policy can't be changed and no one else can propose a
spend.

**The spend policy** (`file_spend`, every spend): a known game payee account only; 1–15 credits; at most 16 spends
and 100 credits per match; ticks never go back. Then the audit log entry (stored on the match and emitted as a
`spend_filed` event) and the DAO proposal, with the flags in its description.

**The AI council (agents).** The five desks are sub-accounts the contract created (`create_desk`) with exactly two
function-call keys, each with a gas allowance. A desk can seal an eject vote and vote on a DAO proposal, and nothing
else: no transfers, no other contracts, no other methods. Seats occupied by humans use the same desks (the server
holds the keys; that's in "what the chain doesn't prove").

## AI

- The planner (`bot.ts`) moves, does duties, audits spends, reports bodies, rings the bell and fills ballots. It only
  uses its own sight (`sight()`), public facts, and its own role. Crew bots build suspicion from what they saw near
  bodies and terminals and from the public votes. Traits (careful, careless, steady) change how they judge flags.
- The words come from a TEE-hosted model on NEAR AI Cloud. The prompt holds only what that seat knows. The model
  answers `{"say", "suspect"}`; `botBallot()` accepts a crew bot's suspect only if its own suspicion of that seat is
  at least 1. Every line is kept with its request, response and the enclave's signature in the proof bundle.

## Modes

- **With the AI council** (solo): you plus four AI members.
- **Rooms** (2–5 people, by code or link `/r/CODE`): empty chairs go to the AI council. A player who drops is
  replaced by an AI after 15 s, and takes the chair back on reconnect.
- **Sign in with NEAR** (Better Auth + better-near-auth, NEP-413 with a recipient/message/origin check): the seat
  is labelled with your account; your wallet claims it (`claim_seat`, gasless via the relayer) and the match counts
  on the ledger.

## Scene and sound

three.js, procedural voxels: instanced floors per room, walls lower toward the camera, furniture from a voxel
batcher (desks, monitors that flicker, server racks with blinking lights, a round vault door, gold bars, filing
cabinets, the council table, plants), a lit skyline and moon behind the windows, seven lamps that die in a blackout,
a torch on the player. Council members are blocky figures with suits in their seat colour; frozen ones lie in ice.
Sound is synthesised: an air-conditioning hum, cues for duties, spends, drains, freezes, meetings and the vote.
