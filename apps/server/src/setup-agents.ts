// One-time setup on testnet. Idempotent: re-running skips what exists.
//   pnpm setup:agents
// - The five council desks: seat1…seat5.<contract>. Each is created by the contract with exactly two
//   keys, both function-call keys with a gas allowance: one may only call `commit_vote` on the contract,
//   the other only `act_proposal` on the Sputnik DAO. No full-access key exists for a desk, so a desk
//   (and the AI sitting at it) can't send money anywhere.
// - The sixteen payee accounts (vendors, new vendors, shells, lookalikes), keyless.
// The keys are written to ~/.near-credentials/<network>/seatN.<contract>.json and seatN.<contract>.dao.json.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { ALL_PAYEES } from '@inside-job/rules';
import { balanceOf, call, view } from './chain.ts';
import { config, deskOf, payeeAccount } from './config.ts';

const OWNER = config.contract;
const credDir = join(homedir(), '.near-credentials', config.network);
mkdirSync(credDir, { recursive: true });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function newKey(file: string, account: string): string {
  if (existsSync(file)) throw new Error(`${file} exists but ${account} doesn't; move the old key away first`);
  const kp = KeyPair.fromRandom('ed25519');
  writeFileSync(file, JSON.stringify({ account_id: account, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  return kp.getPublicKey().toString();
}

for (let seat = 0; seat < 5; seat++) {
  const acct = deskOf(seat);
  if ((await balanceOf(acct)) !== null) { console.log(`${acct} exists`); continue; }
  const gameKey = newKey(join(credDir, `${acct}.json`), acct);
  const daoKey = newKey(join(credDir, `${acct}.dao.json`), acct);
  const r = await call(OWNER, 'create_desk', { seat, game_key: gameKey, dao_key: daoKey }, 60, 300_000_000_000_000_000_000_000n);
  console.log(`created ${acct} (two function-call keys, no full access) ${r.tx}`);
  await sleep(1500);
}

const missing: string[] = [];
for (const p of ALL_PAYEES) if ((await balanceOf(payeeAccount(p))) === null) missing.push(p);
if (missing.length) {
  const r = await call(OWNER, 'open_payees', { labels: missing }, 200, BigInt(missing.length) * 2_000_000_000_000_000_000_000n);
  console.log(`opened ${missing.length} payee accounts ${r.tx}`);
} else console.log('all 16 payee accounts exist');

const policy = await view<{ dao: string; desks: string[] }>('get_policy');
console.log(`DAO ${policy.dao}: ${await balanceOf(policy.dao)} NEAR in the treasury`);
console.log('done');
