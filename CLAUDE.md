# Inside Job — agent notes

- Hackathon rules: https://nearhackathon.com/HACKATHON.md (deadline 2026-11-14 23:59 UTC; repo must stay public).
- Design source of truth: DESIGN.md. Keep README "do X, see Y" steps current — AI judges run them.
- One of the nine NEAR Arcade games (Sushi Sabotage, Bazaar of Liars, Realm Ledger, Parkwright, Fogwater, Emberfall, Inside Job, Kraterra, Clawtide): its own repo, contract, rules and server. The author's other submission is Signalfire.
- Inspired by Who Rug Us? (genre only). Never copy its code, names, text or art.
- packages/rules is deterministic and isomorphic (browser + Node): no Math.random, no Date, no DOM, no node: imports. Its hashes and audit flags must match contracts/council byte for byte (shared test vector in both test suites).
- The LLM never votes, moves, or decides a spend; packages/rules (bot.ts `botBallot`) does. The model may name a suspect, which the planner only accepts if its own suspicion backs it.
- The match seed and all salts stay on the server until the match is over; the proof bundle is served only then.
- The treasury is the Sputnik DAO `dao.inside-job.testnet`; only the contract may propose, only the desks may vote. Desks have function-call keys only.
- Testnet only. Keys live in .env / ~/.near-credentials, never in the repo.
- Verify NEAR endpoints/SDK versions against docs.near.org/llms.txt and docs.near.ai/llms.txt, not memory.
- Local ports 8841–8849 (other projects use 8787, 8795–8799, 8811–8839).
- Commits: no Co-Authored-By or other AI attribution lines; small granular commits. Every change after the first push goes on a branch, through a PR, and is rebase-merged.
