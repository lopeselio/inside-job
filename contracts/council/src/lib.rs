//! Inside Job: the council contract.
//!
//! Five council members run a small DAO's treasury at night; one of them is secretly the Insider.
//! This contract is the part of the game nobody has to trust the game server for (DESIGN.md):
//!
//! - **Sealed roles.** `create_match` takes the hash of a secret seed and one role commitment per
//!   seat. The seed fixes who the Insider is (`deal`), so the server can't pick the Insider after
//!   seeing who sat down. At `settle` the seed is opened and every commitment is checked.
//! - **Sealed votes.** Each seat's eject vote is committed by that seat's own desk account
//!   (`seat<k>.<this contract>`, function-call key only) and opened by the referee at the tally. The
//!   contract counts the votes and decides the ejection itself.
//! - **A real Sputnik DAO treasury.** The match money sits in a Sputnik DAO v2 (`dao`). Only this
//!   contract may file Transfer proposals there (the DAO policy's `terminal` role), and only the five
//!   desks may vote (3 of 5 approve). So every spend passes this contract's **policy** first: known
//!   payee accounts only, a per-spend hard cap, a per-match ceiling and spend count. Every filing is
//!   written to the **audit log** with its flags (lookalike payee, payee not on file, over the soft
//!   cap, filed from the vault terminal, burst).
//! - **Sealed filers.** Who filed each spend is committed at filing and opened at `settle`, so the
//!   contract can add up exactly what the Insider drained, reading every spend's status from the DAO
//!   itself (cross-contract `get_proposal`) instead of taking the referee's word.
//!
//! The commitment strings are byte-for-byte the ones in packages/rules/src/hash.ts (shared test vector).

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, near, require, AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, PublicKey,
};

#[cfg(test)]
mod tests;

pub const SEATS: usize = 5;
pub const BUDGET: u32 = 100;
pub const HARD_CAP: u32 = 15;
pub const FLAG_CAP: u32 = 8;
pub const BURST_TICKS: u32 = 200;
pub const MAX_SPENDS: usize = 16;
pub const APPROVALS: u32 = 3;
pub const DRAIN_GOAL: u32 = 25;
/// one credit = 0.001 NEAR
pub const CREDIT_YOCTO: u128 = 1_000_000_000_000_000_000_000;
pub const VENDORS: [&str; 4] = ["lumen-power", "quill-legal", "nightowl-guard", "stackhouse-cloud"];
pub const PAYEES: [&str; 16] = [
    "lumen-power", "quill-legal", "nightowl-guard", "stackhouse-cloud",
    "brightline-print", "copperkettle-cafe", "tidewater-courier", "oakmoss-cleaning",
    "harborline-supply", "granite-consult", "velvet-ops", "northpeak-data",
    "lumen-powr", "quil-legal", "night0wl-guard", "stackhouse-c1oud",
];
/// what a desk's game key may call here, and its key on the DAO
pub const DESK_METHODS: &str = "commit_vote";
pub const DESK_DAO_METHODS: &str = "act_proposal";
pub const DESK_ALLOWANCE: NearToken = NearToken::from_near(1);
pub const DESK_DAO_ALLOWANCE: NearToken = NearToken::from_near(3);
const GAS_ADD_PROPOSAL: Gas = Gas::from_tgas(15);
const GAS_ON_FILED: Gas = Gas::from_tgas(10);
const GAS_GET_PROPOSAL: Gas = Gas::from_tgas(8);
const GAS_ON_SETTLE: Gas = Gas::from_tgas(60);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SeatRec {
    /// "guest:<name>", "ai:<persona>" or "account:<id>"
    pub label: String,
    /// a signed-in player who may claim this seat for the ledger
    pub account: Option<AccountId>,
    pub claimed: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SeatIn {
    pub label: String,
    pub account: Option<AccountId>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Spend {
    pub tick: u32,
    pub terminal: String,
    pub payee: String,
    pub amount: u32,
    pub memo: String,
    pub flags: Vec<String>,
    pub filer_commit: String,
    pub dao_id: Option<u64>,
    /// "filing" → "pending" (in the DAO) or "failed"; at settle, the DAO's own status
    pub status: String,
    pub filed_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct MeetingRec {
    pub commits: Vec<Option<String>>,
    /// opened at the tally: each seat's choice (-1 = skip), None = no ballot
    pub votes: Option<Vec<Option<i8>>>,
    pub ejected: Option<u8>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VoteOpening {
    pub choice: i8,
    pub salt: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct FilerOpening {
    pub seat: u8,
    pub salt: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    pub winner: String,
    pub reason: String,
    pub insider: u8,
    pub drained: u32,
    pub seed: String,
    pub filers: Vec<u8>,
    /// the referee claimed a different winner than the contract could prove; the proven one stands
    pub disputed: bool,
    pub settled_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Match {
    pub seats: Vec<SeatRec>,
    pub seed_hash: String,
    pub role_commits: Vec<String>,
    pub created_ms: u64,
    pub spends: Vec<Spend>,
    pub filed_total: u32,
    pub last_tick: Option<u32>,
    pub meetings: Vec<MeetingRec>,
    pub ejected: Vec<u8>,
    /// opened at settle, waiting for the DAO's statuses
    pub settling: Option<Outcome>,
    pub outcome: Option<Outcome>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Stats {
    pub games: u32,
    pub wins: u32,
    pub losses: u32,
    pub insider_games: u32,
    pub insider_wins: u32,
    /// meetings where this seat voted to eject the Insider
    pub caught: u32,
}

#[near(serializers = [json])]
pub struct PolicyView {
    pub dao: AccountId,
    pub budget: u32,
    pub hard_cap: u32,
    pub flag_cap: u32,
    pub burst_ticks: u32,
    pub max_spends: u32,
    pub approvals: u32,
    pub drain_goal: u32,
    pub credit_yocto: U128,
    pub vendors_on_file: Vec<String>,
    pub payees: Vec<String>,
    pub desks: Vec<AccountId>,
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Matches,
    Stats,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Council {
    owner: AccountId,
    referee: AccountId,
    dao: AccountId,
    matches: LookupMap<String, Match>,
    stats: IterableMap<AccountId, Stats>,
    played: u64,
}

// ---------- the same hashes as packages/rules/src/hash.ts ----------

pub fn sha_hex(s: &str) -> String {
    hex::encode(env::sha256(s.as_bytes()))
}
pub fn is_hex32(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub fn seed_hash(seed: &str) -> String {
    sha_hex(&format!("inside-job|seed|{seed}"))
}
pub fn deal(match_id: &str, seed: &str) -> u8 {
    let h = env::sha256(format!("inside-job|deal|{match_id}|{seed}").as_bytes());
    (u32::from_be_bytes([h[0], h[1], h[2], h[3]]) % SEATS as u32) as u8
}
pub fn role_salt(seed: &str, seat: u8) -> String {
    sha_hex(&format!("inside-job|salt|{seed}|{seat}"))
}
pub fn role_commit(match_id: &str, seat: u8, insider: bool, salt: &str) -> String {
    sha_hex(&format!("inside-job|role|{match_id}|{seat}|{}|{salt}", if insider { "insider" } else { "crew" }))
}
pub fn vote_commit(match_id: &str, meeting: u32, seat: u8, choice: i8, salt: &str) -> String {
    sha_hex(&format!("inside-job|vote|{match_id}|{meeting}|{seat}|{choice}|{salt}"))
}
pub fn filer_commit(match_id: &str, n: usize, seat: u8, salt: &str) -> String {
    sha_hex(&format!("inside-job|filer|{match_id}|{n}|{seat}|{salt}"))
}

pub fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut dp: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut prev = dp[0];
        dp[0] = i;
        for j in 1..=b.len() {
            let tmp = dp[j];
            dp[j] = (dp[j] + 1).min(dp[j - 1] + 1).min(prev + usize::from(a[i - 1] != b[j - 1]));
            prev = tmp;
        }
    }
    dp[b.len()]
}

/// The audit flags (packages/rules/src/audit.ts `flagsFor`).
pub fn flags_for(payee: &str, amount: u32, terminal: &str, tick: u32, last: Option<u32>) -> Vec<String> {
    let mut out = vec![];
    let on_file = VENDORS.contains(&payee);
    if !on_file && VENDORS.iter().any(|v| edit_distance(v, payee) <= 2) {
        out.push("lookalike".to_string());
    }
    if !on_file {
        out.push("new_payee".to_string());
    }
    if amount > FLAG_CAP {
        out.push("over_cap".to_string());
    }
    if terminal == "vault" {
        out.push("vault_terminal".to_string());
    }
    if let Some(l) = last {
        if tick.saturating_sub(l) <= BURST_TICKS {
            out.push("burst".to_string());
        }
    }
    out
}

/// The eject tally (packages/rules/src/sim.ts `tallyVotes`): a unique top count, above the skips.
pub fn tally(votes: &[Option<i8>]) -> Option<u8> {
    let mut counts = [0u32; SEATS];
    let mut skip = 0u32;
    for v in votes.iter().flatten() {
        if *v < 0 {
            skip += 1;
        } else {
            counts[*v as usize] += 1;
        }
    }
    let top = *counts.iter().max().unwrap();
    if top > 0 && top > skip && counts.iter().filter(|c| **c == top).count() == 1 {
        counts.iter().position(|c| *c == top).map(|i| i as u8)
    } else {
        None
    }
}

fn event(name: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "inside-job", "version": "1.0.0", "event": name, "data": [data] })));
}

#[near]
impl Council {
    #[init]
    pub fn new(owner: AccountId, referee: AccountId, dao: AccountId) -> Self {
        Self { owner, referee, dao, matches: LookupMap::new(Key::Matches), stats: IterableMap::new(Key::Stats), played: 0 }
    }

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }
    fn only_referee(&self) {
        require!(env::predecessor_account_id() == self.referee, "referee only");
    }

    pub fn set_referee(&mut self, referee: AccountId) {
        self.only_owner();
        self.referee = referee;
    }

    /// The desk account of seat `seat` (0-based): `seat<seat+1>.<this contract>`.
    pub fn desk_of(&self, seat: u8) -> AccountId {
        format!("seat{}.{}", seat + 1, env::current_account_id()).parse().unwrap()
    }

    /// Creates a seat's desk account. Its only keys are two function-call keys with gas allowances:
    /// one for `commit_vote` here, one for `act_proposal` on the DAO. A desk can't move money at all.
    #[payable]
    pub fn create_desk(&mut self, seat: u8, game_key: PublicKey, dao_key: PublicKey) -> Promise {
        self.only_owner();
        require!((seat as usize) < SEATS, "seat out of range");
        Promise::new(self.desk_of(seat))
            .create_account()
            .transfer(env::attached_deposit())
            .add_access_key_allowance(game_key, Allowance::limited(DESK_ALLOWANCE).unwrap(), env::current_account_id(), DESK_METHODS)
            .add_access_key_allowance(dao_key, Allowance::limited(DESK_DAO_ALLOWANCE).unwrap(), self.dao.clone(), DESK_DAO_METHODS)
    }

    /// Creates the payee accounts (no keys at all: what's paid to them stays there).
    #[payable]
    pub fn open_payees(&mut self, labels: Vec<String>) {
        self.only_owner();
        require!(!labels.is_empty(), "no payees");
        let each = env::attached_deposit().as_yoctonear() / labels.len() as u128;
        for l in labels {
            require!(PAYEES.contains(&l.as_str()), "not a game payee");
            let id: AccountId = format!("{l}.{}", env::current_account_id()).parse().unwrap();
            Promise::new(id).create_account().transfer(NearToken::from_yoctonear(each)).detach();
        }
    }

    // ---------- a match ----------

    pub fn create_match(&mut self, match_id: String, seed_hash: String, seats: Vec<SeatIn>, role_commits: Vec<String>) {
        self.only_referee();
        require!(!match_id.is_empty() && match_id.len() <= 40, "bad match id");
        require!(!self.matches.contains_key(&match_id), "match exists");
        require!(seats.len() == SEATS && role_commits.len() == SEATS, "a council has five seats");
        require!(is_hex32(&seed_hash) && role_commits.iter().all(|c| is_hex32(c)), "commitments are 32-byte hex");
        let seats: Vec<SeatRec> = seats
            .into_iter()
            .map(|s| {
                require!(s.label.len() <= 48, "label too long");
                SeatRec { label: s.label, account: s.account, claimed: false }
            })
            .collect();
        event("match_created", json!({ "match_id": match_id, "seed_hash": seed_hash, "role_commits": role_commits }));
        self.matches.insert(
            match_id,
            Match {
                seats,
                seed_hash,
                role_commits,
                created_ms: env::block_timestamp_ms(),
                spends: vec![],
                filed_total: 0,
                last_tick: None,
                meetings: vec![],
                ejected: vec![],
                settling: None,
                outcome: None,
            },
        );
    }

    /// A signed-in player confirms their seat from their own wallet (gasless, via the relayer).
    pub fn claim_seat(&mut self, match_id: String, seat: u8) {
        let me = env::predecessor_account_id();
        let m = self.matches.get_mut(&match_id).unwrap_or_else(|| env::panic_str("no such match"));
        let s = m.seats.get_mut(seat as usize).unwrap_or_else(|| env::panic_str("no such seat"));
        require!(s.account.as_ref() == Some(&me), "this seat isn't yours");
        s.claimed = true;
    }

    /// Files a spend: checks the policy, writes the audit log, and proposes the Transfer to the DAO.
    pub fn file_spend(
        &mut self,
        match_id: String,
        tick: u32,
        terminal: String,
        payee: String,
        amount: u32,
        memo: String,
        filer_commit: String,
    ) -> Promise {
        self.only_referee();
        let dao = self.dao.clone();
        let m = self.matches.get_mut(&match_id).unwrap_or_else(|| env::panic_str("no such match"));
        require!(m.outcome.is_none() && m.settling.is_none(), "match is over");
        // the policy: every spend, no exceptions
        require!(terminal == "payroll" || terminal == "vault", "policy: unknown terminal");
        require!(PAYEES.contains(&payee.as_str()), "policy: payee is not a game account");
        require!((1..=HARD_CAP).contains(&amount), "policy: amount over the hard cap");
        require!(m.spends.len() < MAX_SPENDS, "policy: too many spends this match");
        require!(m.filed_total + amount <= BUDGET, "policy: over the match budget");
        require!(m.last_tick.is_none_or(|l| tick >= l), "policy: ticks must not go back");
        require!(is_hex32(&filer_commit) && memo.len() <= 60, "bad filing");
        let flags = flags_for(&payee, amount, &terminal, tick, m.last_tick);
        let n = m.spends.len();
        let receiver: AccountId = format!("{payee}.{}", env::current_account_id()).parse().unwrap();
        let description = format!(
            "Inside Job {match_id} #{n}: {memo}, {amount} credits to {payee}{}",
            if flags.is_empty() { String::new() } else { format!(" [audit: {}]", flags.join(", ")) }
        );
        event(
            "spend_filed",
            json!({ "match_id": match_id, "n": n, "tick": tick, "terminal": terminal, "payee": receiver, "amount": amount, "flags": flags }),
        );
        m.spends.push(Spend {
            tick,
            terminal,
            payee,
            amount,
            memo,
            flags,
            filer_commit,
            dao_id: None,
            status: "filing".into(),
            filed_ms: env::block_timestamp_ms(),
        });
        m.filed_total += amount;
        m.last_tick = Some(tick);
        let args = json!({ "proposal": { "description": description, "kind": { "Transfer": {
            "token_id": "", "receiver_id": receiver, "amount": U128(amount as u128 * CREDIT_YOCTO), "msg": null } } } });
        Promise::new(dao)
            .function_call("add_proposal", serde_json::to_vec(&args).unwrap(), NearToken::from_yoctonear(0), GAS_ADD_PROPOSAL)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_FILED).on_filed(match_id, n as u32))
    }

    #[private]
    pub fn on_filed(&mut self, match_id: String, n: u32, #[callback_result] id: Result<u64, PromiseError>) -> Option<u64> {
        let m = self.matches.get_mut(&match_id).unwrap();
        let s = &mut m.spends[n as usize];
        match id {
            Ok(id) => {
                s.dao_id = Some(id);
                s.status = "pending".into();
                Some(id)
            }
            Err(_) => {
                s.status = "failed".into();
                None
            }
        }
    }

    /// A seat's sealed eject vote, sent by that seat's own desk account.
    pub fn commit_vote(&mut self, match_id: String, meeting: u32, hash: String) {
        let me = env::predecessor_account_id();
        let seat = (0..SEATS as u8).find(|k| self.desk_of(*k) == me).unwrap_or_else(|| env::panic_str("only a council desk can vote"));
        require!(is_hex32(&hash), "bad commitment");
        let m = self.matches.get_mut(&match_id).unwrap_or_else(|| env::panic_str("no such match"));
        require!(m.outcome.is_none() && m.settling.is_none(), "match is over");
        require!(!m.ejected.contains(&seat), "ejected seats don't vote");
        let k = meeting as usize;
        require!(k <= m.meetings.len(), "that meeting hasn't started");
        if k == m.meetings.len() {
            m.meetings.push(MeetingRec { commits: vec![None; SEATS], votes: None, ejected: None });
        }
        let rec = &mut m.meetings[k];
        require!(rec.votes.is_none(), "that meeting is tallied");
        require!(rec.commits[seat as usize].is_none(), "already voted");
        rec.commits[seat as usize] = Some(hash);
    }

    /// Opens a meeting's votes and counts them. `alive` is the referee's word on who could vote
    /// (freezes happen offchain); everything else is checked here.
    pub fn tally_meeting(&mut self, match_id: String, meeting: u32, openings: Vec<Option<VoteOpening>>, alive: Vec<bool>) -> Option<u8> {
        self.only_referee();
        let m = self.matches.get_mut(&match_id).unwrap_or_else(|| env::panic_str("no such match"));
        require!(m.outcome.is_none() && m.settling.is_none(), "match is over");
        require!(openings.len() == SEATS && alive.len() == SEATS, "five seats");
        let k = meeting as usize;
        require!(k <= m.meetings.len(), "meetings are tallied in order");
        if k == m.meetings.len() {
            m.meetings.push(MeetingRec { commits: vec![None; SEATS], votes: None, ejected: None });
        }
        require!(m.meetings[k].votes.is_none(), "already tallied");
        let mut votes: Vec<Option<i8>> = vec![None; SEATS];
        for seat in 0..SEATS {
            match (&m.meetings[k].commits[seat], &openings[seat]) {
                (None, None) => {}
                (Some(c), Some(o)) => {
                    require!(alive[seat] && !m.ejected.contains(&(seat as u8)), "a seat that couldn't vote has a vote");
                    require!(o.choice >= -1 && (o.choice as i32) < SEATS as i32, "bad choice");
                    if o.choice >= 0 {
                        require!(alive[o.choice as usize], "can't eject a seat that's out");
                    }
                    require!(vote_commit(&match_id, meeting, seat as u8, o.choice, &o.salt) == *c, "an opening doesn't match its vote");
                    votes[seat] = Some(o.choice);
                }
                (Some(_), None) => env::panic_str("every committed vote must be opened"),
                (None, Some(_)) => env::panic_str("an opening without a committed vote"),
            }
        }
        let ejected = tally(&votes);
        if let Some(e) = ejected {
            m.ejected.push(e);
        }
        event("meeting_tallied", json!({ "match_id": match_id, "meeting": meeting, "votes": votes, "ejected": ejected }));
        m.meetings[k].votes = Some(votes);
        m.meetings[k].ejected = ejected;
        ejected
    }

    /// Ends a match: opens the seed (and so every role) and the filer of every spend, then reads every
    /// spend's status from the DAO and records the outcome. The referee's claimed winner stands only
    /// where the contract can't prove one (freezes, duties, the books closing).
    pub fn settle(&mut self, match_id: String, seed: String, filers: Vec<FilerOpening>, winner: String, reason: String) -> PromiseOrValue<Outcome> {
        self.only_referee();
        let dao = self.dao.clone();
        let m = self.matches.get_mut(&match_id).unwrap_or_else(|| env::panic_str("no such match"));
        require!(m.outcome.is_none(), "already settled");
        require!(seed_hash(&seed) == m.seed_hash, "the seed doesn't match its hash");
        let insider = deal(&match_id, &seed);
        for seat in 0..SEATS as u8 {
            let c = role_commit(&match_id, seat, seat == insider, &role_salt(&seed, seat));
            require!(c == m.role_commits[seat as usize], "a role commitment doesn't open");
        }
        require!(filers.len() == m.spends.len(), "open every filer");
        for (n, f) in filers.iter().enumerate() {
            require!((f.seat as usize) < SEATS, "bad seat");
            require!(filer_commit(&match_id, n, f.seat, &f.salt) == m.spends[n].filer_commit, "a filer opening doesn't match");
        }
        require!(winner == "crew" || winner == "insider", "bad winner");
        require!(["ejected", "drained", "outnumbered", "duties", "closed"].contains(&reason.as_str()), "bad reason");
        m.settling = Some(Outcome {
            winner,
            reason,
            insider,
            drained: 0,
            seed,
            filers: filers.iter().map(|f| f.seat).collect(),
            disputed: false,
            settled_ms: 0,
        });
        // ask the DAO for every filed spend's status; the callback adds up the drain
        let ids: Vec<u64> = m.spends.iter().filter_map(|s| s.dao_id).collect();
        let mut p: Option<Promise> = None;
        for id in &ids {
            let q = Promise::new(dao.clone()).function_call(
                "get_proposal",
                serde_json::to_vec(&json!({ "id": id })).unwrap(),
                NearToken::from_yoctonear(0),
                GAS_GET_PROPOSAL,
            );
            p = Some(match p {
                None => q,
                Some(acc) => acc.and(q),
            });
        }
        match p {
            Some(p) => PromiseOrValue::Promise(p.then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_SETTLE).on_settle(match_id))),
            // nothing was filed: nothing to ask the DAO
            None => PromiseOrValue::Value(self.finalize(match_id)),
        }
    }

    #[private]
    pub fn on_settle(&mut self, match_id: String) -> Outcome {
        self.finalize(match_id)
    }

    fn finalize(&mut self, match_id: String) -> Outcome {
        let mut m = self.matches.get(&match_id).cloned().unwrap();
        let mut o = m.settling.take().unwrap_or_else(|| env::panic_str("not settling"));
        // the DAO's statuses, in the order the promises were joined (spends with a DAO id)
        let mut k = 0u64;
        let count = env::promise_results_count();
        for s in m.spends.iter_mut() {
            if s.dao_id.is_none() {
                continue;
            }
            if k < count {
                if let Ok(bytes) = env::promise_result_checked(k, 16_000) {
                    if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                        if let Some(st) = v.get("status").and_then(|x| x.as_str()) {
                            s.status = st.to_string();
                        }
                    }
                }
            }
            k += 1;
        }
        o.drained = m.spends.iter().zip(&o.filers).filter(|(s, f)| **f == o.insider && s.status == "Approved").map(|(s, _)| s.amount).sum();
        let caught = m.ejected.contains(&o.insider);
        // what the contract can prove overrides the claim
        let proven: Option<(&str, &str)> = if caught {
            Some(("crew", "ejected"))
        } else if o.drained >= DRAIN_GOAL {
            Some(("insider", "drained"))
        } else {
            None
        };
        if let Some((w, r)) = proven {
            if o.winner != w || o.reason != r {
                o.disputed = true;
                o.winner = w.into();
                o.reason = r.into();
            }
        } else if o.reason == "ejected" || o.reason == "drained" {
            o.disputed = true;
            o.winner = "crew".into();
            o.reason = "closed".into();
        }
        o.settled_ms = env::block_timestamp_ms();
        // the ledger: only seats a signed-in player claimed from their own wallet
        for (seat, s) in m.seats.iter().enumerate() {
            let (Some(acct), true) = (s.account.clone(), s.claimed) else { continue };
            let insider = seat as u8 == o.insider;
            let won = (o.winner == "insider") == insider;
            let caught_votes = m.meetings.iter().filter(|mt| mt.votes.as_ref().and_then(|v| v[seat]) == Some(o.insider as i8)).count() as u32;
            let mut st = self.stats.get(&acct).cloned().unwrap_or_default();
            st.games += 1;
            if won {
                st.wins += 1;
            } else {
                st.losses += 1;
            }
            if insider {
                st.insider_games += 1;
                if won {
                    st.insider_wins += 1;
                }
            }
            st.caught += caught_votes;
            self.stats.insert(acct, st);
        }
        event("match_settled", json!({ "match_id": match_id, "winner": o.winner, "reason": o.reason, "insider": o.insider, "drained": o.drained, "disputed": o.disputed }));
        m.outcome = Some(o.clone());
        self.matches.insert(match_id, m);
        self.played += 1;
        o
    }

    // ---------- views ----------

    pub fn get_match(&self, match_id: String) -> Option<Match> {
        self.matches.get(&match_id).cloned()
    }

    /// The match's audit log: every spend with its flags and its status.
    pub fn audit_log(&self, match_id: String) -> Vec<Spend> {
        self.matches.get(&match_id).map(|m| m.spends.clone()).unwrap_or_default()
    }

    pub fn get_policy(&self) -> PolicyView {
        PolicyView {
            dao: self.dao.clone(),
            budget: BUDGET,
            hard_cap: HARD_CAP,
            flag_cap: FLAG_CAP,
            burst_ticks: BURST_TICKS,
            max_spends: MAX_SPENDS as u32,
            approvals: APPROVALS,
            drain_goal: DRAIN_GOAL,
            credit_yocto: U128(CREDIT_YOCTO),
            vendors_on_file: VENDORS.iter().map(|s| s.to_string()).collect(),
            payees: PAYEES.iter().map(|s| format!("{s}.{}", env::current_account_id())).collect(),
            desks: (0..SEATS as u8).map(|k| self.desk_of(k)).collect(),
        }
    }

    pub fn stats_of(&self, account_id: AccountId) -> Stats {
        self.stats.get(&account_id).cloned().unwrap_or_default()
    }

    pub fn leaderboard(&self, limit: u32) -> Vec<(AccountId, Stats)> {
        let mut all: Vec<(AccountId, Stats)> = self.stats.iter().map(|(a, s)| (a.clone(), s.clone())).collect();
        all.sort_by(|a, b| b.1.wins.cmp(&a.1.wins).then(b.1.caught.cmp(&a.1.caught)).then(a.1.games.cmp(&b.1.games)));
        all.truncate(limit.min(50) as usize);
        all
    }

    pub fn info(&self) -> Value {
        json!({ "owner": self.owner, "referee": self.referee, "dao": self.dao, "played": self.played })
    }
}
