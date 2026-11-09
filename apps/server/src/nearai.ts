import { randomBytes } from 'node:crypto';
import { config } from './config.ts';

// NEAR AI Cloud (TEE-hosted models). Every reply is kept with its exact request/response bytes and
// the enclave's signature, so anyone can check later that the line wasn't altered.

export interface SignedLine {
  who: string;
  /** the council seat that spoke (meeting talk) */
  seat?: number;
  text: string;
  model: string;
  request: string;
  response: string;
  signedText?: string;
  signature?: string;
  signingAddress?: string;
  /** when the line was asked for (lines are shown in this order) */
  at?: number;
}

export const nearAiEnabled = (): boolean => config.nearAi.apiKey.length > 0;
const headers = (): Record<string, string> => ({ authorization: `Bearer ${config.nearAi.apiKey}`, 'content-type': 'application/json' });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One model reply. `raw` is the model's text (the caller may parse it); `line.text` starts as that text.
 * Falls back to `fallback` (unsigned) if NEAR AI is off or fails.
 */
export async function voice(who: string, system: string, user: string, fallback: string, maxTokens = 80): Promise<SignedLine & { raw: string }> {
  const model = config.nearAi.model;
  if (!nearAiEnabled()) return { who, text: fallback, model: 'none', request: '', response: '', raw: '' };
  const request = JSON.stringify({
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: maxTokens,
    temperature: 0.8,
    chat_template_kwargs: { enable_thinking: false },
  });
  try {
    const res = await fetch(`${config.nearAi.baseUrl}/chat/completions`, { method: 'POST', headers: headers(), body: request, signal: AbortSignal.timeout(9000) });
    const response = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = JSON.parse(response) as { id: string; choices: { message: { content: string | null } }[] };
    const raw = (body.choices[0]?.message.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const line: SignedLine & { raw: string } = { who, text: raw.replace(/^"|"$/g, '').slice(0, 240) || fallback, model, request, response, raw };
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await fetch(`${config.nearAi.baseUrl}/signature/${encodeURIComponent(body.id)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers: headers() });
      if (r.ok) {
        const sig = (await r.json()) as { text?: string; signature?: string; signing_address?: string };
        if (sig.signature) { line.signedText = sig.text; line.signature = sig.signature; line.signingAddress = sig.signing_address; break; }
      }
      await sleep(400 * (attempt + 1));
    }
    return line;
  } catch (e) {
    console.warn(`NEAR AI voice for ${who}: ${(e as Error).message}`);
    return { who, text: fallback, model: 'none', request: '', response: '', raw: '' };
  }
}

/** The model's TEE attestation, bound to a fresh nonce. */
export async function attestation(): Promise<{ nonce: string; model: string; report: unknown } | null> {
  if (!nearAiEnabled()) return null;
  const nonce = randomBytes(32).toString('hex');
  const model = config.nearAi.model;
  const res = await fetch(`${config.nearAi.baseUrl}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`, { headers: headers() });
  if (!res.ok) return null;
  return { nonce, model, report: await res.json() };
}
