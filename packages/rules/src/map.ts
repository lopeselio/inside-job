// The office at night: a 34×19 tile grid. Three rooms on top (Vault, Servers, Audit), a long hall,
// three rooms below (Archive, Council, Payroll). Rooms only open onto the hall, so every room is a
// dead end: good for duties, good for an Insider.
//
// A tile (tx, ty) covers [tx, tx+1) × [ty, ty+1). Players are circles of radius R moving in tile units.

export const W = 34;
export const H = 19;
export const R = 0.3;

export type RoomId = 'vault' | 'servers' | 'audit' | 'hall' | 'archive' | 'council' | 'payroll';
export interface Room { id: RoomId; name: string; x0: number; y0: number; x1: number; y1: number }

export const ROOMS: Room[] = [
  { id: 'vault', name: 'Vault', x0: 1, y0: 1, x1: 10, y1: 6 },
  { id: 'servers', name: 'Server room', x0: 12, y0: 1, x1: 21, y1: 6 },
  { id: 'audit', name: 'Audit office', x0: 23, y0: 1, x1: 32, y1: 6 },
  { id: 'hall', name: 'Hall', x0: 1, y0: 8, x1: 32, y1: 9 },
  { id: 'archive', name: 'Archive', x0: 1, y0: 11, x1: 10, y1: 17 },
  { id: 'council', name: 'Council room', x0: 12, y0: 11, x1: 21, y1: 17 },
  { id: 'payroll', name: 'Payroll', x0: 23, y0: 11, x1: 32, y1: 17 },
];

/** Door tiles (two wide) in the walls above and below the hall. They count as hall. */
export const DOORS: [number, number][] = [5, 6, 16, 17, 27, 28].flatMap((x) => [[x, 7], [x, 10]] as [number, number][]);

export type StationId = 'terminal' | 'keys' | 'node' | 'breaker' | 'audit' | 'files' | 'payroll' | 'mail' | 'coffee' | 'table';
export interface Station { id: StationId; room: RoomId; x: number; y: number; label: string }

/** Station tiles are solid (a desk, a rack, a cabinet); you use one from any tile next to it. */
export const STATIONS: Station[] = [
  { id: 'terminal', room: 'vault', x: 3, y: 2, label: 'Vault terminal' },
  { id: 'keys', room: 'vault', x: 9, y: 5, label: 'Key safe' },
  { id: 'node', room: 'servers', x: 14, y: 2, label: 'Validator node' },
  { id: 'breaker', room: 'servers', x: 20, y: 2, label: 'Breaker panel' },
  { id: 'audit', room: 'audit', x: 27, y: 3, label: 'Audit desk' },
  { id: 'files', room: 'archive', x: 2, y: 14, label: 'Filing cabinets' },
  { id: 'payroll', room: 'payroll', x: 28, y: 13, label: 'Payroll desk' },
  { id: 'mail', room: 'payroll', x: 31, y: 16, label: 'Mail sorter' },
  { id: 'coffee', room: 'hall', x: 1, y: 8, label: 'Coffee machine' },
];

/** The council table: solid tiles in the middle of the Council room. */
export const TABLE = { x0: 15, y0: 13, x1: 18, y1: 15, cx: 17, cy: 14.5 };
export const REACH = 1.75;
export const TABLE_REACH = 3.2;

/** Where everyone stands when a meeting starts (one per seat), around the table. */
export const SPAWNS: [number, number][] = [[16.5, 12.5], [19.5, 13.5], [19.5, 15.5], [14.5, 15.5], [14.5, 13.5]];

const solid: Uint8Array = (() => {
  const g = new Uint8Array(W * H).fill(1);
  const carve = (x: number, y: number): void => { g[y * W + x] = 0; };
  for (const r of ROOMS) for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) carve(x, y);
  for (const [x, y] of DOORS) carve(x, y);
  for (const s of STATIONS) g[s.y * W + s.x] = 1;
  for (let y = TABLE.y0; y <= TABLE.y1; y++) for (let x = TABLE.x0; x <= TABLE.x1; x++) g[y * W + x] = 1;
  return g;
})();

export const isSolid = (tx: number, ty: number): boolean => tx < 0 || ty < 0 || tx >= W || ty >= H || solid[ty * W + tx] === 1;

/** Is a wall tile (not a station or the table)? The scene draws these as walls. */
export function isWall(tx: number, ty: number): boolean {
  if (!isSolid(tx, ty)) return false;
  if (STATIONS.some((s) => s.x === tx && s.y === ty)) return false;
  return !(tx >= TABLE.x0 && tx <= TABLE.x1 && ty >= TABLE.y0 && ty <= TABLE.y1);
}

/** Can a circle of radius R stand at (x, y)? */
export function free(x: number, y: number): boolean {
  for (const [dx, dy] of [[-R, -R], [R, -R], [-R, R], [R, R]]) if (isSolid(Math.floor(x + dx), Math.floor(y + dy))) return false;
  return true;
}

const roomGrid: (RoomId | null)[] = (() => {
  const g: (RoomId | null)[] = new Array(W * H).fill(null);
  for (const r of ROOMS) for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) g[y * W + x] = r.id;
  for (const [x, y] of DOORS) g[y * W + x] = 'hall';
  return g;
})();

export const roomAt = (x: number, y: number): RoomId | null => {
  const tx = Math.floor(x), ty = Math.floor(y);
  return tx < 0 || ty < 0 || tx >= W || ty >= H ? null : roomGrid[ty * W + tx];
};
export const roomName = (id: RoomId | null): string => ROOMS.find((r) => r.id === id)?.name ?? 'somewhere';

export const stationById = (id: StationId): Station => STATIONS.find((s) => s.id === id)!;
export const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by);

/** The station within reach of (x, y), if any (the nearest one). */
export function stationAt(x: number, y: number): StationId | null {
  let best: StationId | null = null;
  let bd = Infinity;
  for (const s of STATIONS) {
    const d = dist(x, y, s.x + 0.5, s.y + 0.5);
    if (d <= REACH && d < bd) { bd = d; best = s.id; }
  }
  if (!best && roomAt(x, y) === 'council' && dist(x, y, TABLE.cx, TABLE.cy) <= TABLE_REACH) return 'table';
  return best;
}

/** Free tiles from which a station can be used. */
export function standTiles(id: StationId): [number, number][] {
  const out: [number, number][] = [];
  for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
    if (isSolid(tx, ty)) continue;
    if (stationAt(tx + 0.5, ty + 0.5) === id) out.push([tx, ty]);
  }
  return out;
}

/** Shortest tile path (BFS, 4-neighbour) from a tile to the nearest goal tile. Excludes the start tile. */
export function path(from: [number, number], goals: [number, number][]): [number, number][] {
  const goal = new Set(goals.map(([x, y]) => y * W + x));
  const start = from[1] * W + from[0];
  if (goal.has(start)) return [];
  const prev = new Int32Array(W * H).fill(-1);
  prev[start] = start;
  const q = [start];
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (goal.has(c)) {
      const out: [number, number][] = [];
      for (let k = c; k !== start; k = prev[k]) out.push([k % W, Math.floor(k / W)]);
      return out.reverse();
    }
    const cx = c % W, cy = Math.floor(c / W);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (isSolid(nx, ny)) continue;
      const n = ny * W + nx;
      if (prev[n] !== -1) continue;
      prev[n] = c;
      q.push(n);
    }
  }
  return [];
}
