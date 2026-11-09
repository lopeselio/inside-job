use super::*;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const SEED: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const M: &str = "m-vector";

fn ctx(who: &str) {
    testing_env!(VMContextBuilder::new()
        .current_account_id("inside-job.testnet".parse().unwrap())
        .predecessor_account_id(who.parse().unwrap())
        .attached_deposit(NearToken::from_near(1))
        .build());
}

/// a callback with these promise results (as the contract itself)
fn callback(results: Vec<PromiseResult>) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id("inside-job.testnet".parse().unwrap())
            .predecessor_account_id("inside-job.testnet".parse().unwrap())
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results,
    );
}

fn council() -> Council {
    ctx("inside-job.testnet");
    Council::new("inside-job.testnet".parse().unwrap(), "ref.testnet".parse().unwrap(), "dao.inside-job.testnet".parse().unwrap())
}

fn commits() -> Vec<String> {
    let ins = deal(M, SEED);
    (0..5u8).map(|s| role_commit(M, s, s == ins, &role_salt(SEED, s))).collect()
}

fn with_match() -> Council {
    let mut c = council();
    ctx("ref.testnet");
    let seats = (0..5)
        .map(|i| SeatIn { label: format!("guest:p{i}"), account: if i == 0 { Some("alice.testnet".parse().unwrap()) } else { None } })
        .collect();
    c.create_match(M.into(), seed_hash(SEED), seats, commits());
    c
}

fn salt(n: usize) -> String {
    sha_hex(&format!("salt{n}"))
}

/// files a spend and pretends the DAO gave it proposal id `id`
fn file(c: &mut Council, n: usize, tick: u32, payee: &str, amount: u32, terminal: &str, filer: u8, id: u64) {
    ctx("ref.testnet");
    let _ = c.file_spend(M.into(), tick, terminal.into(), payee.into(), amount, format!("Invoice #{n}"), filer_commit(M, n, filer, &salt(n)));
    callback(vec![PromiseResult::Successful(id.to_string().into_bytes())]);
    assert_eq!(c.on_filed(M.into(), n as u32, Ok(id)), Some(id));
}

fn status(s: &str) -> PromiseResult {
    PromiseResult::Successful(serde_json::to_vec(&json!({ "id": 0, "status": s })).unwrap())
}

#[test]
fn shared_hash_vector() {
    council();
    assert_eq!(seed_hash(SEED), "7fed753ebdfff80d0923fa4bf4b98cae2922dd5600015d116ca27cbba5d66463");
    assert_eq!(deal(M, SEED), 3);
    assert_eq!(role_salt(SEED, 2), "8b6d6be415e4f9ee6fb22fad1aa411adfcc767a3fd65c1d7307911f2494ccd0d");
    assert_eq!(role_commit(M, 2, false, &role_salt(SEED, 2)), "cba84cceda91bcf5fe0dd77cfeb5b5f3ed62f17c8effb731a742af51c0c248cb");
    assert_eq!(vote_commit(M, 1, 3, -1, &"ab".repeat(32)), "3e4d38d651893572aa9dcd287f485949052d4d9d912d7b3c22162374e24fc23b");
    assert_eq!(vote_commit(M, 1, 3, 4, &"ab".repeat(32)), "80f667c07857fc8ea4212612a6dee0831b3e092f1569df290ce0b7cf365ccaba");
    assert_eq!(filer_commit(M, 0, 4, &"cd".repeat(32)), "2b9c2b82e8bf056b1cfa4f36154c08ad190471ce52c88f6a9426e0f125038008");
}

#[test]
fn audit_flags_and_tally_match_the_rules() {
    council();
    assert!(flags_for("lumen-power", 5, "payroll", 100, None).is_empty());
    assert_eq!(flags_for("brightline-print", 5, "payroll", 100, None), vec!["new_payee"]);
    assert_eq!(flags_for("quil-legal", 5, "payroll", 100, None), vec!["lookalike", "new_payee"]);
    assert_eq!(flags_for("lumen-power", 9, "vault", 300, Some(150)), vec!["over_cap", "vault_terminal", "burst"]);
    assert_eq!(edit_distance("stackhouse-cloud", "stackhouse-c1oud"), 1);
    assert_eq!(tally(&[Some(1), Some(1), Some(2), Some(-1), None]), Some(1));
    assert_eq!(tally(&[Some(1), Some(1), Some(2), Some(2), Some(-1)]), None);
    assert_eq!(tally(&[Some(1), Some(-1), Some(-1), Some(3), None]), None);
}

#[test]
#[should_panic(expected = "referee only")]
fn only_the_referee_creates_matches() {
    let mut c = council();
    ctx("mallory.testnet");
    c.create_match("m-x".into(), seed_hash(SEED), vec![], vec![]);
}

#[test]
fn file_spend_writes_the_audit_log_and_proposes_to_the_dao() {
    let mut c = with_match();
    file(&mut c, 0, 50, "lumen-power", 4, "payroll", 1, 7);
    file(&mut c, 1, 120, "quil-legal", 9, "vault", 3, 8);
    let log = c.audit_log(M.into());
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].flags, Vec::<String>::new());
    assert_eq!(log[1].flags, vec!["lookalike", "new_payee", "over_cap", "vault_terminal", "burst"]);
    assert_eq!((log[1].dao_id, log[1].status.as_str()), (Some(8), "pending"));
    assert_eq!(c.get_match(M.into()).unwrap().filed_total, 13);
}

#[test]
fn a_failed_dao_call_is_recorded() {
    let mut c = with_match();
    ctx("ref.testnet");
    let _ = c.file_spend(M.into(), 1, "payroll".into(), "lumen-power".into(), 3, "x".into(), filer_commit(M, 0, 0, &salt(0)));
    callback(vec![PromiseResult::Failed]);
    assert_eq!(c.on_filed(M.into(), 0, Err(PromiseError::Failed)), None);
    assert_eq!(c.audit_log(M.into())[0].status, "failed");
}

#[test]
#[should_panic(expected = "policy: payee is not a game account")]
fn policy_refuses_unknown_payees() {
    let mut c = with_match();
    ctx("ref.testnet");
    let _ = c.file_spend(M.into(), 1, "payroll".into(), "mallory".into(), 3, "x".into(), salt(0));
}

#[test]
#[should_panic(expected = "policy: amount over the hard cap")]
fn policy_refuses_big_spends() {
    let mut c = with_match();
    ctx("ref.testnet");
    let _ = c.file_spend(M.into(), 1, "payroll".into(), "velvet-ops".into(), HARD_CAP + 1, "x".into(), salt(0));
}

#[test]
#[should_panic(expected = "policy: over the match budget")]
fn policy_keeps_the_match_budget() {
    let mut c = with_match();
    for n in 0..7 {
        file(&mut c, n, 10 + n as u32 * 300, "velvet-ops", 14, "payroll", 3, n as u64);
    }
    ctx("ref.testnet");
    let _ = c.file_spend(M.into(), 9000, "payroll".into(), "velvet-ops".into(), 3, "x".into(), salt(9));
}

#[test]
fn desks_commit_votes_and_the_contract_tallies_them() {
    let mut c = with_match();
    let choices: [i8; 5] = [3, 3, -1, 1, 3];
    for (seat, ch) in choices.iter().enumerate() {
        ctx(&format!("seat{}.inside-job.testnet", seat + 1));
        c.commit_vote(M.into(), 0, vote_commit(M, 0, seat as u8, *ch, &salt(seat)));
    }
    ctx("ref.testnet");
    let openings = choices.iter().enumerate().map(|(s, ch)| Some(VoteOpening { choice: *ch, salt: salt(s) })).collect();
    assert_eq!(c.tally_meeting(M.into(), 0, openings, vec![true; 5]), Some(3));
    assert_eq!(c.get_match(M.into()).unwrap().ejected, vec![3]);
}

#[test]
#[should_panic(expected = "only a council desk can vote")]
fn strangers_cant_vote() {
    let mut c = with_match();
    ctx("seat9.inside-job.testnet");
    c.commit_vote(M.into(), 0, salt(0));
}

#[test]
#[should_panic(expected = "an opening doesn't match its vote")]
fn the_referee_cant_change_a_vote() {
    let mut c = with_match();
    ctx("seat1.inside-job.testnet");
    c.commit_vote(M.into(), 0, vote_commit(M, 0, 0, -1, &salt(0)));
    ctx("ref.testnet");
    let mut openings: Vec<Option<VoteOpening>> = vec![None; 5];
    openings[0] = Some(VoteOpening { choice: 2, salt: salt(0) });
    c.tally_meeting(M.into(), 0, openings, vec![true; 5]);
}

#[test]
#[should_panic(expected = "already voted")]
fn one_vote_per_meeting() {
    let mut c = with_match();
    ctx("seat2.inside-job.testnet");
    c.commit_vote(M.into(), 0, salt(0));
    c.commit_vote(M.into(), 0, salt(1));
}

#[test]
#[should_panic(expected = "the seed doesn't match its hash")]
fn settle_needs_the_committed_seed() {
    let mut c = with_match();
    ctx("ref.testnet");
    let _ = c.settle(M.into(), "00".repeat(32), vec![], "crew".into(), "closed".into());
}

#[test]
#[should_panic(expected = "a filer opening doesn't match")]
fn settle_checks_every_filer() {
    let mut c = with_match();
    file(&mut c, 0, 50, "velvet-ops", 6, "payroll", 3, 0);
    ctx("ref.testnet");
    // pretend a crew member (seat 1) filed the Insider's drain
    let _ = c.settle(M.into(), SEED.into(), vec![FilerOpening { seat: 1, salt: salt(0) }], "crew".into(), "closed".into());
}

#[test]
fn settle_reads_the_dao_and_adds_up_the_drain() {
    let mut c = with_match();
    let ins = deal(M, SEED);
    file(&mut c, 0, 50, "velvet-ops", 12, "payroll", ins, 0);
    file(&mut c, 1, 400, "granite-consult", 9, "payroll", ins, 1);
    file(&mut c, 2, 800, "lumen-power", 4, "payroll", 0, 2);
    file(&mut c, 3, 1200, "northpeak-data", 6, "payroll", ins, 3);
    ctx("alice.testnet");
    c.claim_seat(M.into(), 0);
    ctx("ref.testnet");
    let filers = [ins, ins, 0, ins].iter().enumerate().map(|(n, s)| FilerOpening { seat: *s, salt: salt(n) }).collect();
    // the referee claims a crew win; the DAO says three drains went through
    let _ = c.settle(M.into(), SEED.into(), filers, "crew".into(), "duties".into());
    callback(vec![status("Approved"), status("Approved"), status("Approved"), status("Approved")]);
    let o = c.on_settle(M.into());
    assert_eq!(o.drained, 27);
    assert_eq!((o.winner.as_str(), o.reason.as_str(), o.disputed), ("insider", "drained", true));
    let st = c.stats_of("alice.testnet".parse().unwrap());
    assert_eq!((st.games, st.losses), (1, 1));
    assert_eq!(c.audit_log(M.into())[0].status, "Approved");
}

#[test]
fn an_unprovable_claim_stands_when_nothing_contradicts_it() {
    let mut c = with_match();
    let ins = deal(M, SEED);
    file(&mut c, 0, 50, "velvet-ops", 12, "payroll", ins, 0);
    ctx("ref.testnet");
    let _ = c.settle(M.into(), SEED.into(), vec![FilerOpening { seat: ins, salt: salt(0) }], "insider".into(), "outnumbered".into());
    callback(vec![status("Rejected")]);
    let o = c.on_settle(M.into());
    assert_eq!((o.winner.as_str(), o.reason.as_str(), o.disputed, o.drained), ("insider", "outnumbered", false, 0));
    // an unclaimed seat isn't ranked
    assert_eq!(c.stats_of("alice.testnet".parse().unwrap()).games, 0);
}

#[test]
#[should_panic(expected = "this seat isn't yours")]
fn only_the_seats_account_claims_it() {
    let mut c = with_match();
    ctx("bob.testnet");
    c.claim_seat(M.into(), 0);
}

#[test]
fn desks_get_two_function_call_keys_and_no_full_access() {
    let mut c = council();
    ctx("inside-job.testnet");
    let k1: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap();
    let k2: PublicKey = "ed25519:4kgdpCjyM8qpvMByLSAUrzqvZbP3DKaYxGHB2MsVnrrN".parse().unwrap();
    let _ = c.create_desk(2, k1, k2);
    let r = get_created_receipts();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].receiver_id.as_str(), "seat3.inside-job.testnet");
    let text = format!("{:?}", r[0].actions);
    assert_eq!(text.matches("AddKeyWithFunctionCall").count(), 2);
    assert!(!text.contains("AddKeyWithFullAccess"));
}
