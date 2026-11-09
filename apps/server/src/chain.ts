import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPairSigner, actions, teraToGas, type KeyPairString } from 'near-api-js';
import { config, privateKey } from './config.ts';

// Contract calls. A signer is an account, or "account#dao" for a desk's second key (the one the
// DAO accepts). Each key's calls run one after another so its nonces never collide.

// several public testnet RPCs (docs.near.org/api/rpc/providers); on an error the next one is tried
const RPCS = [config.rpcUrl, 'https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs'].filter((u, i, a) => a.indexOf(u) === i);
const provider = new FailoverRpcProvider(RPCS.map((url) => new JsonRpcProvider({ url })));
// a plain provider for lookups that may miss (the failover one logs every miss as an error)
const quiet = new JsonRpcProvider({ url: RPCS[0] });
const accounts = new Map<string, Account>();
const queues = new Map<string, Promise<unknown>>();

function account(signer: string): Account {
  let a = accounts.get(signer);
  if (!a) {
    a = new Account(signer.split('#')[0], provider, KeyPairSigner.fromSecretKey(privateKey(signer) as KeyPairString));
    accounts.set(signer, a);
  }
  return a;
}

export interface CallResult<T> { value: T; tx: string }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const transient = (e: unknown): boolean => /fetch failed|ECONNRESET|ETIMEDOUT|timeout|503|502|429|InvalidNonce|Expired/i.test(String((e as Error)?.message ?? e));

/** Calls `method` on `receiver` as `signer`. Returns the decoded return value and the transaction hash. */
export function callOn<T = unknown>(signer: string, receiver: string, method: string, args: object, gasTera = 60, depositYocto = 0n): Promise<CallResult<T>> {
  const once = async (): Promise<CallResult<T>> => {
    const outcome = await account(signer).signAndSendTransaction({
      receiverId: receiver,
      actions: [actions.functionCall(method, args as Record<string, unknown>, teraToGas(gasTera), depositYocto)],
      waitUntil: 'EXECUTED_OPTIMISTIC',
      throwOnFailure: false,
    });
    const o = outcome as unknown as { transaction: { hash: string }; status: { SuccessValue?: string; Failure?: unknown } };
    if (o.status && 'Failure' in o.status && o.status.Failure) throw Object.assign(new Error(`${method} failed: ${JSON.stringify(o.status.Failure).slice(0, 300)}`), { tx: o.transaction.hash });
    const raw = o.status?.SuccessValue ? Buffer.from(o.status.SuccessValue, 'base64').toString('utf8') : '';
    return { value: (raw ? JSON.parse(raw) : undefined) as T, tx: o.transaction.hash };
  };
  const guarded = async (): Promise<CallResult<T>> => {
    for (let attempt = 0; ; attempt++) {
      try { return await once(); } catch (e) {
        if (attempt >= 3 || !transient(e)) throw e;
        await sleep(700 * (attempt + 1));
      }
    }
  };
  const run = (queues.get(signer) ?? Promise.resolve()).catch(() => undefined).then(guarded);
  queues.set(signer, run);
  return run;
}

/** A call on the game contract. */
export const call = <T = unknown>(signer: string, method: string, args: object, gasTera = 60, depositYocto = 0n): Promise<CallResult<T>> =>
  callOn<T>(signer, config.contract, method, args, gasTera, depositYocto);

export async function viewOn<T>(contractId: string, method: string, args: object = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method, args: args as Record<string, unknown>, blockQuery: { finality: 'optimistic' } })) as T;
}
export const view = <T>(method: string, args: object = {}): Promise<T> => viewOn<T>(config.contract, method, args);

/** An account's balance in NEAR (null if it doesn't exist). */
export async function balanceOf(accountId: string): Promise<number | null> {
  try {
    const a = (await quiet.viewAccount({ accountId, finalityQuery: { finality: 'optimistic' } } as never)) as unknown as { amount: string };
    return Number(BigInt(a.amount) / 10n ** 18n) / 1e6;
  } catch { return null; }
}

/** A key's permission (with its remaining allowance for a function-call key), or null. */
export async function accessKey(accountId: string, publicKey: string): Promise<{ permission: unknown } | null> {
  try {
    return (await provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: 'optimistic' } })) as unknown as { permission: unknown };
  } catch { return null; }
}

export { provider };
