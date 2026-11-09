// The game socket. One connection; it reconnects by itself, and after a reload it rejoins the match
// this browser holds a seat token for.

type Msg = { t: string; [k: string]: unknown };
type Handler = (m: Msg) => void;
const KEY = 'inside-job:seat';

export interface SeatTicket { code: string; token: string }
export function ticket(): SeatTicket | null {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as SeatTicket | null; } catch { return null; }
}
export function setTicket(t: SeatTicket | null): void {
  try { if (t) sessionStorage.setItem(KEY, JSON.stringify(t)); else sessionStorage.removeItem(KEY); } catch { /* fine */ }
}

class Net {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private queue: string[] = [];
  private retry = 0;

  connect(): void {
    if (this.ws && this.ws.readyState <= 1) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      const t = ticket();
      if (t) ws.send(JSON.stringify({ t: 'rejoin', ...t }));
      for (const q of this.queue.splice(0)) ws.send(q);
      this.emit({ t: 'online' });
    };
    ws.onmessage = (e) => { try { this.emit(JSON.parse(String(e.data)) as Msg); } catch { /* ignore */ } };
    ws.onclose = () => {
      this.emit({ t: 'offline' });
      setTimeout(() => this.connect(), Math.min(5000, 500 * 2 ** this.retry++));
    };
  }

  send(m: Msg): void {
    const s = JSON.stringify(m);
    if (this.ws?.readyState === 1) this.ws.send(s);
    else { this.queue.push(s); this.connect(); }
  }

  on(h: Handler): () => void { this.handlers.add(h); return () => { this.handlers.delete(h); }; }
  private emit(m: Msg): void { for (const h of this.handlers) h(m); }
}

export const net = new Net();
export type { Msg };
