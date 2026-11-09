import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ALL_PAYEES, BUDGET, DRAIN_GOAL, DUTIES, FLAG_CAP, HARD_CAP, LOOKALIKES, NEW_VENDORS, PAYEE_LABEL, PERSONAS, SHELLS, VENDORS, replay, stateHash,
} from '@inside-job/rules';
import { BA_PATH, accountFromHeaders, authHandler } from './ba.ts';
import { accessKey, balanceOf, view } from './chain.ts';
import { config, deskOf, explorerTx, hasKey, privateKey } from './config.ts';
import { KeyPairSigner, type KeyPairString } from 'near-api-js';
import { attestation, nearAiEnabled } from './nearai.ts';
import { Room, activeRooms } from './room.ts';
import { loadMatch, recentMatches, type MatchRecord } from './store.ts';

// ---------- tiny HTTP helpers ----------

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = normalize(join(config.webDist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(normalize(config.webDist))) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(config.webDist, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end('web app not built: pnpm build'); return; }
  const immutable = file.includes(`${join(config.webDist, 'assets')}`);
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  createReadStream(file).pipe(res);
}

// ---------- the proof bundle ----------

/** Everything needed to re-check a finished match without trusting this server (`pnpm verify <id>`). */
function proofBundle(m: MatchRecord) {
  const s = replay(m.setup, m.log, m.result?.tick);
  return {
    id: m.id,
    contract: config.contract,
    dao: config.dao,
    over: !!m.result,
    setup: m.setup,
    seedHash: m.seedHash,
    roleCommits: m.roleCommits,
    seats: m.seats,
    log: m.log,
    result: m.result,
    replayHash: stateHash(s),
    proposals: s.proposals.map((p) => ({ ...p, filerSalt: m.filerSalts[p.n] ?? null, daoId: m.daoIds[p.n] ?? null })),
    meetings: s.meetings.map((t) => ({ ...t, salts: m.voteSalts[t.n] ?? null })),
    lines: m.lines,
    chat: m.chat,
    txs: m.txs.map((t) => ({ ...t, url: explorerTx(t.hash) })),
    settled: m.settled,
    outcome: m.settleOutcome ?? null,
    chainError: m.chainError ?? null,
  };
}

function summary(m: MatchRecord) {
  return {
    id: m.id, mode: m.mode, at: m.updatedAt, names: m.seats.map((s) => s.name),
    winner: m.result?.winner ?? null, reason: m.result?.reason ?? null, insider: m.result ? m.seats[m.result.insider].name : null,
    settled: m.settled, txs: m.txs.length,
  };
}

/** Each desk's balance and what's left of its keys' gas allowances. */
async function deskStatus() {
  const out = [];
  for (let k = 0; k < 5; k++) {
    const acct = deskOf(k);
    const keys = [];
    for (const name of [acct, `${acct}#dao`]) {
      if (!hasKey(name)) { keys.push({ key: name.endsWith('#dao') ? 'dao' : 'game', allowance: null }); continue; }
      const pub = (await KeyPairSigner.fromSecretKey(privateKey(name) as KeyPairString).getPublicKey()).toString();
      const info = (await accessKey(acct, pub)) as { permission?: { FunctionCall?: { allowance: string | null; receiver_id: string; method_names: string[] } } } | null;
      const fc = info?.permission?.FunctionCall;
      keys.push({ key: name.endsWith('#dao') ? 'dao' : 'game', receiver: fc?.receiver_id ?? null, methods: fc?.method_names ?? null, allowance: fc?.allowance ? Number(BigInt(fc.allowance) / 10n ** 18n) / 1e6 : null, fullAccess: !!info && !fc });
    }
    out.push({ seat: k + 1, account: acct, balance: await balanceOf(acct), keys });
  }
  return out;
}

// ---------- routes ----------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  try {
    if (p === BA_PATH || p.startsWith(`${BA_PATH}/`)) { await authHandler(req, res); return; }
    if (p === '/api/health') return json(res, 200, { ok: true, version: process.env.APP_VERSION ?? 'dev', rooms: activeRooms() });
    if (p === '/api/config') {
      return json(res, 200, {
        network: config.network, contract: config.contract, dao: config.dao, referee: config.referee, chain: config.chainEnabled,
        relayer: hasKey(config.relayer) ? config.relayer : null, nearAi: nearAiEnabled(), personas: PERSONAS,
        policy: { budget: BUDGET, drainGoal: DRAIN_GOAL, flagCap: FLAG_CAP, hardCap: HARD_CAP },
        payees: { vendors: VENDORS, newVendors: NEW_VENDORS, shells: SHELLS, lookalikes: LOOKALIKES, all: ALL_PAYEES, labels: PAYEE_LABEL },
        duties: DUTIES,
      });
    }
    const me = await accountFromHeaders(req.headers);
    if (p === '/api/me') return me ? json(res, 200, { accountId: me, stats: config.chainEnabled ? await view('stats_of', { account_id: me }).catch(() => null) : null }) : json(res, 401, { error: 'not signed in' });
    if (p === '/api/leaderboard') return json(res, 200, config.chainEnabled ? await view('leaderboard', { limit: 20 }).catch(() => []) : []);
    if (p === '/api/attestation') return json(res, 200, await attestation());
    if (p === '/api/status') {
      return json(res, 200, {
        contract: { account: config.contract, balance: await balanceOf(config.contract) },
        dao: { account: config.dao, balance: await balanceOf(config.dao) },
        referee: { account: config.referee, balance: await balanceOf(config.referee) },
        desks: await deskStatus(),
      });
    }
    if (p === '/api/recent') return json(res, 200, recentMatches().map(summary));
    if (p === '/api/rooms') return json(res, 200, Room.open());
    const m = /^\/api\/match\/([a-z0-9-]{1,40})(\/proof)?$/.exec(p);
    if (m) {
      const rec = loadMatch(m[1]);
      if (!rec) return json(res, 404, { error: 'no such match' });
      if (!m[2]) return json(res, 200, summary(rec));
      // the bundle holds the seed and every salt: only once the match is over
      if (!rec.result) return json(res, 403, { error: 'the match isn’t over yet' });
      return json(res, 200, proofBundle(rec));
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    serveStatic(req, res);
  } catch (e) {
    const code = (e as { code?: number }).code;
    json(res, typeof code === 'number' ? code : 400, { error: (e as Error).message });
  }
}

const server = createServer((req, res) => { void route(req, res); });

// ---------- websocket: rooms and play ----------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8_000 });
const roomOf = new Map<WebSocket, Room>();
// a little brake on new matches per address (every match costs the referee gas)
const starts = new Map<string, number[]>();
function allowStart(ip: string): boolean {
  const now = Date.now();
  const list = (starts.get(ip) ?? []).filter((t) => t > now - 3600_000);
  if (list.length >= 30) return false;
  list.push(now);
  starts.set(ip, list);
  return true;
}

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
  const account = accountFromHeaders(req.headers).catch(() => null);
  const err = (message: string): void => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'error', message })); };
  ws.on('message', (raw) => {
    void (async () => {
      let msg: { t?: string; [k: string]: unknown };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const r = roomOf.get(ws);
      try {
        switch (msg.t) {
          case 'solo':
          case 'create': {
            if (r) r.leave(ws);
            if (!allowStart(ip)) throw new Error('that’s a lot of matches: try again in a while');
            const room = new Room(msg.t === 'solo');
            const token = room.join(ws, String(msg.name ?? ''), await account);
            roomOf.set(ws, room);
            ws.send(JSON.stringify({ t: 'joined', code: room.code, token }));
            if (msg.t === 'solo') room.startNow(ws);
            break;
          }
          case 'join': {
            const room = Room.get(String(msg.code ?? ''));
            if (!room) throw new Error('no room with that code');
            if (r && r !== room) r.leave(ws);
            const token = room.join(ws, String(msg.name ?? ''), await account);
            roomOf.set(ws, room);
            ws.send(JSON.stringify({ t: 'joined', code: room.code, token }));
            break;
          }
          case 'rejoin': {
            const room = Room.get(String(msg.code ?? ''));
            if (!room || !room.rejoin(ws, String(msg.token ?? ''))) throw new Error('that match is gone');
            roomOf.set(ws, room);
            break;
          }
          case 'ready': r?.setReady(ws, !!msg.ready); break;
          case 'addAi': r?.addAi(ws); break;
          case 'kick': r?.kick(ws, Number(msg.seat)); break;
          case 'start': r?.startNow(ws); break;
          case 'input': r?.input(ws, (msg.i ?? {}) as never); break;
          case 'chat': r?.chat(ws, String(msg.text ?? '')); break;
          case 'autopilot': r?.autopilot(ws); break;
          case 'leave': r?.leave(ws); roomOf.delete(ws); break;
        }
      } catch (e) { err((e as Error).message); }
    })();
  });
  ws.on('close', () => { roomOf.get(ws)?.leave(ws); roomOf.delete(ws); });
});
// keep idle sockets alive through proxies
setInterval(() => { for (const ws of wss.clients) if (ws.readyState === 1) ws.ping(); }, 25_000).unref();

server.listen(config.port, () => {
  console.log(`Inside Job on :${config.port} (contract ${config.contract}, DAO ${config.dao}, chain ${config.chainEnabled ? 'on' : 'off'}, NEAR AI ${nearAiEnabled() ? 'on' : 'off'})`);
});
