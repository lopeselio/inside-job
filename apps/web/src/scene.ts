import * as THREE from 'three';
import { H, ROOMS, STATIONS, TABLE, W, isWall, roomAt, type RoomId, type StationId } from '@inside-job/rules';

// The office at night, all procedural voxels: instanced floor and walls, a voxel batcher for the
// furniture, a skyline outside the windows, a handful of lamps, and blocky council members built from
// boxes. Tile (x, y) maps to world (x, 0, y): +x east, +z south. The camera looks north over the
// player's shoulder.

const FLOOR: Record<RoomId, [number, number]> = {
  vault: [0x272c38, 0x2e3444],
  servers: [0x18202e, 0x1d2a3d],
  audit: [0x3f2d1f, 0x47331f],
  hall: [0x2c2d33, 0x313238],
  archive: [0x35281f, 0x3b2c22],
  council: [0x3d1a21, 0x451e26],
  payroll: [0x1b3133, 0x1f383a],
};
const WALL_H = 1.35;
/** Each room's accent: its lamp, the glow strip along its walls, the name on its floor. */
const ACCENT: Record<RoomId, number> = {
  vault: 0x88a8ff, servers: 0x38e0ff, audit: 0xffc277, hall: 0xb8c8ff, archive: 0xffb066, council: 0xff8a6b, payroll: 0x7fffe0,
};

/** A soft round light pool, white; tinted per lamp by the material colour. */
let poolTex: THREE.CanvasTexture | null = null;
function lightPool(): THREE.CanvasTexture {
  if (poolTex) return poolTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  poolTex = new THREE.CanvasTexture(c);
  return poolTex;
}

/** A room's name painted on its floor by the door, in its accent colour. */
function floorSign(text: string, color: number): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 112;
  const g = c.getContext('2d')!;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.letterSpacing = '8px';
  // shrink long names ("Council room") to fit the frame
  let size = 64;
  do { g.font = `800 ${size}px Inter, system-ui, sans-serif`; size -= 4; } while (g.measureText(text.toUpperCase()).width > 450 && size > 24);
  g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  g.fillText(text.toUpperCase(), 256, 58);
  g.strokeStyle = `#${color.toString(16).padStart(6, '0')}`;
  g.lineWidth = 4;
  g.strokeRect(8, 8, 496, 96);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.74), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.42, depthWrite: false, toneMapped: false }));
  m.rotation.x = -Math.PI / 2;
  return m;
}

export interface Actor { seat: number; x: number; y: number; dir: number; moving: boolean; ghost: boolean; color: number; name: string; me?: boolean }

/** Collects boxes and turns them into one InstancedMesh per material. */
class Voxels {
  private boxes: { m: THREE.Matrix4; c: THREE.Color; glow: boolean }[] = [];
  add(x: number, y: number, z: number, w: number, h: number, d: number, color: number, glow = false): number {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(w, h, d));
    this.boxes.push({ m, c: new THREE.Color(color), glow });
    return this.boxes.filter((b) => b.glow === glow).length - 1;
  }
  build(scene: THREE.Scene): { solid: THREE.InstancedMesh; glow: THREE.InstancedMesh } {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const make = (glow: boolean): THREE.InstancedMesh => {
      const list = this.boxes.filter((b) => b.glow === glow);
      const mat = glow ? new THREE.MeshBasicMaterial({ toneMapped: false }) : new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
      list.forEach((b, i) => { mesh.setMatrixAt(i, b.m); mesh.setColorAt(i, b.c); });
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      scene.add(mesh);
      return mesh;
    };
    return { solid: make(false), glow: make(true) };
  }
}

function nameTag(text: string, color: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d')!;
  g.font = '700 30px Inter, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const w = Math.min(250, g.measureText(text).width + 28);
  g.fillStyle = 'rgba(8,10,20,0.72)';
  g.beginPath();
  g.roundRect(128 - w / 2, 10, w, 44, 12);
  g.fill();
  g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  g.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(1.9, 0.48, 1);
  s.renderOrder = 10;
  return s;
}

const SKIN = [0xf1c7a0, 0xd9a47a, 0xa8714f, 0x7a4b31, 0xe8b894];
const HAIR = [0x2a1d14, 0x5a3a22, 0xd8c070, 0x1a1a1a, 0x9a3b22];

/** A blocky council member. */
class Figure {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private legs: THREE.Mesh[] = [];
  private arms: THREE.Mesh[] = [];
  private mats: THREE.MeshStandardMaterial[] = [];
  private ice: THREE.Mesh | null = null;
  private tag: THREE.Sprite;
  private marker: THREE.Mesh | null = null;
  x = 0; z = 0; tx = 0; tz = 0; dir = 2; moving = false; ghost = false; frozen = false; seen = 0;

  constructor(readonly seat: number, color: number, name: string) {
    const mat = (c: number): THREE.MeshStandardMaterial => { const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 }); this.mats.push(m); return m; };
    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.body): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      return mesh;
    };
    const suit = mat(color), dark = mat(0x1b1e2a), skin = mat(SKIN[seat % 5]), hair = mat(HAIR[seat % 5]), white = mat(0xe8e6df), eye = mat(0x111111);
    for (const sx of [-0.1, 0.1]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx, 0.38, 0);
      box(0.14, 0.36, 0.15, dark, 0, -0.18, 0, pivot);
      box(0.15, 0.06, 0.2, mat(0x0d0d10), 0, -0.35, 0.02, pivot);
      this.body.add(pivot);
      this.legs.push(pivot as unknown as THREE.Mesh);
    }
    box(0.44, 0.42, 0.26, suit, 0, 0.6, 0);
    box(0.12, 0.3, 0.02, white, 0, 0.66, 0.135);
    box(0.04, 0.24, 0.02, dark, 0, 0.64, 0.145);
    for (const sx of [-0.28, 0.28]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx, 0.78, 0);
      box(0.12, 0.36, 0.13, suit, 0, -0.17, 0, pivot);
      box(0.1, 0.08, 0.1, skin, 0, -0.38, 0, pivot);
      this.body.add(pivot);
      this.arms.push(pivot as unknown as THREE.Mesh);
    }
    box(0.34, 0.32, 0.32, skin, 0, 0.99, 0);
    box(0.36, 0.1, 0.34, hair, 0, 1.18, -0.01);
    box(0.36, 0.18, 0.08, hair, 0, 1.08, -0.15);
    box(0.05, 0.05, 0.02, eye, -0.08, 1.01, 0.165);
    box(0.05, 0.05, 0.02, eye, 0.08, 1.01, 0.165);
    // a desk badge, in the seat's colour
    box(0.07, 0.09, 0.02, mat(0xffe08a), 0.13, 0.7, 0.14);
    // a faint glow of the seat colour on the suit, so a figure reads in the dark
    suit.emissive.setHex(color).multiplyScalar(0.14);
    suit.userData.em = suit.emissive.getHex();
    this.root.add(this.body);
    // a soft shadow and a ring in the seat's colour at the feet: who is who, from above
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.36, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.012;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.38, 0.46, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.015;
    this.root.add(shadow, ring);
    this.tag = nameTag(name, color);
    this.tag.position.set(0, 1.62, 0);
    this.root.add(this.tag);
  }

  /** A gold marker over your own head. */
  setMe(me: boolean): void {
    if (me && !this.marker) {
      this.marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.11), new THREE.MeshBasicMaterial({ color: 0xffd36b, toneMapped: false }));
      this.marker.scale.y = 1.4;
      this.root.add(this.marker);
    }
    if (this.marker) this.marker.visible = me;
  }

  setGhost(g: boolean): void {
    if (g === this.ghost) return;
    this.ghost = g;
    for (const m of this.mats) { m.transparent = g; m.opacity = g ? 0.32 : 1; m.depthWrite = !g; }
  }

  setFrozen(f: boolean): void {
    if (f === this.frozen) return;
    this.frozen = f;
    this.body.rotation.x = f ? -Math.PI / 2 : 0;
    this.body.position.y = f ? 0.18 : 0;
    for (const m of this.mats) m.emissive.setHex(f ? 0x0d3550 : (m.userData.em as number | undefined) ?? 0x000000);
    if (f && !this.ice) {
      this.ice = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.5, 1.4), new THREE.MeshStandardMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.35, roughness: 0.1, emissive: 0x15506a }));
      this.ice.position.set(0, 0.25, -0.35);
      this.root.add(this.ice);
    }
    if (this.ice) this.ice.visible = f;
  }

  update(dt: number, t: number): void {
    const k = 1 - Math.exp(-dt * 14);
    this.x += (this.tx - this.x) * k;
    this.z += (this.tz - this.z) * k;
    this.root.position.set(this.x, this.ghost ? 0.15 + Math.sin(t * 2 + this.seat) * 0.08 : 0, this.z);
    const target = [Math.PI, Math.PI / 2, 0, -Math.PI / 2][this.dir] ?? 0;
    let d = target - this.root.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    if (!this.frozen) this.root.rotation.y += d * Math.min(1, dt * 12);
    const swing = this.moving && !this.frozen ? Math.sin(t * 11) * 0.6 : 0;
    this.legs[0].rotation.x = swing; this.legs[1].rotation.x = -swing;
    this.arms[0].rotation.x = -swing * 0.8; this.arms[1].rotation.x = swing * 0.8;
    this.body.position.y = this.frozen ? 0.18 : this.moving ? Math.abs(Math.sin(t * 11)) * 0.04 : 0;
    if (this.marker?.visible) { this.marker.position.y = 2.0 + Math.sin(t * 3) * 0.06; this.marker.rotation.y = t * 1.5; }
  }
}

interface Burst { mesh: THREE.InstancedMesh; vel: THREE.Vector3[]; pos: THREE.Vector3[]; life: number }

export class Office {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  private figures = new Map<number, Figure>();
  private bodies = new Map<number, Figure>();
  private lamps: { light: THREE.PointLight; base: number }[] = [];
  private pools: THREE.MeshBasicMaterial[] = [];
  private ambient: THREE.AmbientLight;
  private moon: THREE.DirectionalLight;
  private torch = new THREE.PointLight(0xfff0d0, 6, 7, 1.6);
  private glow: THREE.InstancedMesh;
  private blinkers: { i: number; on: THREE.Color; off: THREE.Color; rate: number; phase: number }[] = [];
  private screens: { i: number; c: THREE.Color }[] = [];
  private ring: THREE.Mesh;
  private bursts: Burst[] = [];
  private follow = new THREE.Vector3(17, 0, 9);
  private mode: 'title' | 'play' = 'title';
  private dark = false;
  private clock = new THREE.Clock();
  private time = 0;

  constructor(host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.4;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x05070f);
    this.scene.fog = new THREE.Fog(0x05070f, 26, 60);

    this.ambient = new THREE.AmbientLight(0x34477a, 1.6);
    this.scene.add(this.ambient, new THREE.HemisphereLight(0x5a6cab, 0x0a0c14, 1.0));
    this.moon = new THREE.DirectionalLight(0x9db8ff, 0.9);
    this.moon.position.set(-10, 20, -14);
    this.scene.add(this.moon);
    this.scene.add(this.torch);

    const vox = new Voxels();
    this.buildFloorAndWalls();
    this.buildFurniture(vox);
    this.buildRoomIdentity(vox);
    this.buildSkyline(vox);
    const built = vox.build(this.scene);
    this.glow = built.glow;

    const lamp = (x: number, z: number, color: number, intensity: number, dist = 8, y = 1.4): void => {
      const l = new THREE.PointLight(color, intensity, dist, 1.5);
      l.position.set(x, y, z);
      this.scene.add(l);
      this.lamps.push({ light: l, base: intensity });
      // the pool of light it throws on the floor (a decal, not another light: cheap on phones)
      const mat = new THREE.MeshBasicMaterial({ map: lightPool(), color, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(dist * 0.62, dist * 0.62), mat);
      pool.rotation.x = -Math.PI / 2;
      pool.position.set(x, 0.02, z);
      this.scene.add(pool);
      this.pools.push(mat);
    };
    lamp(5.5, 3.5, 0x88a8ff, 7);          // vault
    lamp(16.5, 3.5, 0x38e0ff, 6);         // servers
    lamp(27.5, 3.2, 0xffc277, 9);         // audit desk lamp
    lamp(17, 14.5, 0xffd08a, 11, 9, 2.2); // council pendant
    lamp(5.5, 14, 0xffb066, 6);           // archive
    lamp(28, 14, 0x7fffe0, 6);            // payroll
    lamp(16.5, 8.8, 0xb8c8ff, 5, 14);     // hall

    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.86, 4, 1), new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0.8, side: THREE.DoubleSide, toneMapped: false }));
    this.ring.rotation.set(-Math.PI / 2, 0, Math.PI / 4);
    this.ring.visible = false;
    this.scene.add(this.ring);

    // stars
    const starGeo = new THREE.BufferGeometry();
    const pts: number[] = [];
    for (let i = 0; i < 500; i++) pts.push((Math.random() - 0.5) * 160, 18 + Math.random() * 40, -30 - Math.random() * 60);
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xcfd8ff, size: 0.25, sizeAttenuation: true })));

    const resize = (): void => {
      const w = host.clientWidth || innerWidth, h = host.clientHeight || innerHeight;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    resize();
    addEventListener('resize', resize);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private buildFloorAndWalls(): void {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const tiles: [number, number, number][] = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const r = roomAt(x + 0.5, y + 0.5);
      if (r) {
        const [a, b] = FLOOR[r];
        let c = (x + y) % 2 ? a : b;
        if (r === 'council' && (x === 12 || x === 21 || y === 11 || y === 17)) c = 0x5a4718;
        if (r === 'servers' && (x % 3 === 0 || y % 3 === 0)) c = 0x22324a;
        tiles.push([x, y, c]);
      }
    }
    const floor = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.95 }), tiles.length);
    tiles.forEach(([x, y, c], i) => {
      floor.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(x + 0.5, -0.08, y + 0.5), new THREE.Quaternion(), new THREE.Vector3(1, 0.16, 1)));
      floor.setColorAt(i, new THREE.Color(c));
    });
    this.scene.add(floor);
    // walls, with a lighter cap; the south walls of each room are lower so the camera sees in
    const walls: THREE.Matrix4[] = [];
    const caps: THREE.Matrix4[] = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!isWall(x, y)) continue;
      const low = y === 7 || y === 18 ? 0.55 : y === 10 ? 0.9 : WALL_H;
      walls.push(new THREE.Matrix4().compose(new THREE.Vector3(x + 0.5, low / 2, y + 0.5), new THREE.Quaternion(), new THREE.Vector3(1, low, 1)));
      caps.push(new THREE.Matrix4().compose(new THREE.Vector3(x + 0.5, low + 0.04, y + 0.5), new THREE.Quaternion(), new THREE.Vector3(1.02, 0.08, 1.02)));
    }
    const wm = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0x1c2438, roughness: 0.9 }), walls.length);
    walls.forEach((m, i) => wm.setMatrixAt(i, m));
    const cm = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0x3a4766, roughness: 0.7 }), caps.length);
    caps.forEach((m, i) => cm.setMatrixAt(i, m));
    this.scene.add(wm, cm);
    // a dark ground plane under everything
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x07090f }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.17;
    this.scene.add(ground);
  }

  private buildFurniture(v: Voxels): void {
    const desk = (x: number, z: number, w: number, d: number, top = 0x5a4430): void => {
      v.add(x, 0.48, z, w, 0.06, d, top);
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) v.add(x + dx * (w / 2 - 0.05), 0.23, z + dz * (d / 2 - 0.05), 0.06, 0.46, 0.06, 0x2a2018);
    };
    const monitor = (x: number, z: number, color: number, w = 0.55): void => {
      v.add(x, 0.56, z, 0.08, 0.1, 0.08, 0x1a1a1a);
      v.add(x, 0.8, z, w + 0.06, 0.4, 0.05, 0x111318);
      this.screens.push({ i: v.add(x, 0.8, z + 0.03, w, 0.33, 0.01, color, true), c: new THREE.Color(color) });
      v.add(x, 0.52, z + 0.22, 0.4, 0.02, 0.12, 0x2b2f3a);
    };
    const blink = (x: number, y: number, z: number, color: number, rate: number): void => {
      const i = v.add(x, y, z, 0.05, 0.05, 0.02, color, true);
      this.blinkers.push({ i, on: new THREE.Color(color), off: new THREE.Color(0x0a0f14), rate, phase: Math.random() * 10 });
    };
    const chair = (x: number, z: number, color = 0x22252f): void => {
      v.add(x, 0.28, z, 0.38, 0.06, 0.38, color);
      v.add(x, 0.5, z + 0.17, 0.38, 0.4, 0.06, color);
      v.add(x, 0.13, z, 0.06, 0.26, 0.06, 0x111111);
    };
    const plant = (x: number, z: number): void => {
      v.add(x, 0.18, z, 0.32, 0.36, 0.32, 0x6b3e26);
      v.add(x, 0.5, z, 0.42, 0.3, 0.42, 0x2f6b3a);
      v.add(x + 0.05, 0.75, z - 0.04, 0.28, 0.28, 0.28, 0x3c8a4a);
      v.add(x - 0.06, 0.92, z + 0.03, 0.16, 0.18, 0.16, 0x4fa35c);
    };
    const s = (id: StationId): { x: number; z: number } => { const st = STATIONS.find((q) => q.id === id)!; return { x: st.x + 0.5, z: st.y + 0.5 }; };

    // Vault: the terminal, the key safe, a round vault door, gold
    let p = s('terminal');
    desk(p.x, p.z, 0.95, 0.65, 0x3a3f4a); monitor(p.x, p.z - 0.12, 0x3cff9a);
    p = s('keys');
    v.add(p.x, 0.45, p.z, 0.8, 0.9, 0.7, 0x3b404c); v.add(p.x, 0.55, p.z + 0.36, 0.18, 0.18, 0.04, 0xc9a43a); v.add(p.x, 0.25, p.z + 0.36, 0.5, 0.04, 0.03, 0x8a8f9a);
    for (let a = 0; a < 28; a++) {
      const ang = (a / 28) * Math.PI * 2;
      v.add(6.5 + Math.cos(ang) * 1.1, 0.95 + Math.sin(ang) * 0.6 * 0.9, 1.05, 0.22, 0.22, 0.12, 0x6b7385);
    }
    v.add(6.5, 0.95, 1.08, 0.5, 0.5, 0.1, 0x8d96aa); v.add(6.5, 0.95, 1.14, 0.9, 0.08, 0.06, 0xb9a24a); v.add(6.5, 0.95, 1.14, 0.08, 0.9, 0.06, 0xb9a24a);
    for (let k = 0; k < 6; k++) v.add(1.4 + (k % 3) * 0.32, 0.08 + Math.floor(k / 3) * 0.13, 6.5, 0.28, 0.12, 0.16, 0xe8c34a);
    for (let k = 0; k < 4; k++) v.add(9.6 - (k % 2) * 0.32, 0.08 + Math.floor(k / 2) * 0.13, 1.4, 0.28, 0.12, 0.16, 0xe8c34a);

    // Servers: the validator node and racks along the north wall, with blinking lights
    p = s('node');
    v.add(p.x, 0.8, p.z, 0.8, 1.6, 0.8, 0x141922);
    for (let r = 0; r < 7; r++) for (let c = 0; c < 4; c++) blink(p.x - 0.27 + c * 0.18, 0.3 + r * 0.2, p.z + 0.41, [0x3cff9a, 0x38c8ff, 0xffb347][(r + c) % 3], 1 + ((r * 4 + c) % 5));
    for (const x of [12.5, 16.6, 17.6, 18.6]) {
      v.add(x, 0.75, 1.25, 0.8, 1.5, 0.45, 0x151a24);
      for (let r = 0; r < 6; r++) blink(x - 0.2 + (r % 2) * 0.4, 0.3 + r * 0.2, 1.48, r % 2 ? 0x38c8ff : 0x3cff9a, 2 + (r % 4));
    }
    p = s('breaker');
    v.add(p.x, 0.75, p.z - 0.3, 0.7, 1.0, 0.2, 0x4a4f5c);
    for (let k = 0; k < 6; k++) blink(p.x - 0.22 + (k % 3) * 0.22, 0.55 + Math.floor(k / 3) * 0.3, p.z - 0.18, k === 2 ? 0xff4a4a : 0x6aff6a, 0.4 + k * 0.1);

    // Audit office: the audit desk with a lamp, papers, shelves
    p = s('audit');
    desk(p.x, p.z, 1.1, 0.75); monitor(p.x - 0.18, p.z - 0.15, 0xffb84a);
    v.add(p.x + 0.4, 0.62, p.z - 0.1, 0.06, 0.24, 0.06, 0x2a2a2a); this.screens.push({ i: v.add(p.x + 0.4, 0.78, p.z - 0.06, 0.18, 0.08, 0.14, 0xffd28a, true), c: new THREE.Color(0xffd28a) });
    for (let k = 0; k < 3; k++) v.add(p.x + 0.25, 0.53 + k * 0.025, p.z + 0.2, 0.22, 0.02, 0.28, 0xeeeee4);
    chair(p.x, p.z + 0.75);
    for (let x = 24; x < 32; x += 1.1) { v.add(x, 0.6, 1.2, 1, 1.2, 0.35, 0x3a2a1c); for (let k = 0; k < 6; k++) v.add(x - 0.4 + k * 0.16, 0.95, 1.25, 0.12, 0.28, 0.24, [0x8a3b3b, 0x3b5a8a, 0x8a7a3b, 0x3b8a5a][(k + Math.floor(x)) % 4]); }
    plant(32.3, 5.6); plant(23.6, 5.6);

    // Archive: the cabinets and shelves of books
    p = s('files');
    for (let k = 0; k < 3; k++) { v.add(p.x, 0.6, p.z - 0.33 + k * 0.33, 0.6, 1.2, 0.3, 0x5b6170); for (let d = 0; d < 3; d++) v.add(p.x + 0.31, 0.25 + d * 0.38, p.z - 0.33 + k * 0.33, 0.02, 0.03, 0.18, 0xb0b5c0); }
    for (let x = 1.6; x < 10; x += 1.1) { v.add(x, 0.6, 11.25, 1, 1.2, 0.35, 0x3a2a1c); for (let k = 0; k < 6; k++) v.add(x - 0.4 + k * 0.16, 0.95, 11.3, 0.12, 0.3, 0.24, [0x6b2f2f, 0x2f4a6b, 0x6b5a2f, 0x2f6b4a, 0x55306b][(k + Math.round(x * 3)) % 5]); }
    desk(7.5, 15, 1.2, 0.7); chair(7.5, 15.7);
    plant(1.5, 17.4);

    // Council room: the long table, chairs, the bell, a banner
    const T = TABLE;
    v.add(T.cx, 0.55, T.cy, T.x1 - T.x0 + 1, 0.1, T.y1 - T.y0 + 1, 0x4a2e1c);
    v.add(T.cx, 0.6, T.cy, T.x1 - T.x0 + 0.6, 0.02, T.y1 - T.y0 + 0.6, 0x1f4a2e);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) v.add(T.cx + dx * 1.8, 0.27, T.cy + dz * 1.3, 0.12, 0.54, 0.12, 0x2a1a10);
    v.add(T.cx, 0.68, T.cy, 0.22, 0.12, 0.22, 0xd9b54a); v.add(T.cx, 0.78, T.cy, 0.06, 0.1, 0.06, 0xd9b54a);
    for (const [x, z] of [[16.5, 12.3], [19.7, 13.5], [19.7, 15.5], [14.3, 15.5], [14.3, 13.5]]) chair(x, z, 0x3a1f26);
    for (let k = 0; k < 10; k++) v.add(13 + k * 0.85, 1.1, 11.2, 0.7, 0.5, 0.06, k % 2 ? 0x2a3a6b : 0x6b2a3a);
    for (let k = 0; k < 5; k++) this.screens.push({ i: v.add(14.7 + k * 0.6, 1.1, 11.16, 0.3, 0.3, 0.02, 0xffd36b, true), c: new THREE.Color(0xffd36b) });
    plant(12.5, 17.4); plant(21.5, 17.4);

    // Payroll: the payroll desk, the mail sorter, a water cooler
    p = s('payroll');
    desk(p.x, p.z, 1.1, 0.75, 0x3a4a4c); monitor(p.x, p.z - 0.15, 0x5ae6ff);
    for (let k = 0; k < 5; k++) v.add(p.x - 0.35, 0.53 + k * 0.025, p.z + 0.18, 0.22, 0.02, 0.28, 0xeeeee4);
    v.add(p.x + 0.38, 0.56, p.z + 0.2, 0.1, 0.1, 0.1, 0xb03030);
    chair(p.x, p.z + 0.75);
    p = s('mail');
    v.add(p.x, 0.6, p.z, 0.9, 1.2, 0.5, 0x4a3a2a);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { v.add(p.x - 0.28 + c * 0.28, 0.35 + r * 0.32, p.z - 0.26, 0.22, 0.24, 0.04, 0x1a140e); v.add(p.x - 0.28 + c * 0.28, 0.3 + r * 0.32, p.z - 0.27, 0.16, 0.08, 0.03, [0xf2f0e6, 0xffd36b, 0x9fd0ff][(r + c) % 3]); }
    v.add(24, 0.45, 16.6, 0.4, 0.9, 0.4, 0xd8dde6); v.add(24, 1.0, 16.6, 0.34, 0.3, 0.34, 0x7fc8ff);
    plant(32.4, 11.6);

    // Hall: the coffee machine, benches, plants, ceiling strip lights
    p = s('coffee');
    v.add(p.x, 0.55, p.z, 0.7, 1.1, 0.6, 0x26262c); v.add(p.x, 0.75, p.z + 0.31, 0.4, 0.3, 0.02, 0x111111);
    blink(p.x + 0.2, 1.0, p.z + 0.31, 0xff4040, 0.5);
    v.add(p.x, 0.3, p.z + 0.35, 0.12, 0.14, 0.12, 0xf2f0e6);
    for (const x of [8.5, 24.5]) { v.add(x, 0.22, 8.15, 1.4, 0.08, 0.4, 0x5a4430); v.add(x, 0.1, 8.15, 1.3, 0.2, 0.3, 0x2a2018); }
    plant(11.5, 8.2); plant(22.5, 8.2); plant(32.5, 9.6);
    for (let x = 2; x < 33; x += 4) this.screens.push({ i: v.add(x, 1.5, 8.5, 1.2, 0.04, 0.12, 0xdfe8ff, true), c: new THREE.Color(0xdfe8ff) });

    // windows in the north wall of the top rooms, moonlight through them
    for (const x of [2.5, 9, 14, 20.5, 25.5, 30.5]) {
      this.screens.push({ i: v.add(x, 0.95, 0.5, 1.6, 0.7, 1.02, 0x22355e, true), c: new THREE.Color(0x22355e) });
      v.add(x, 0.95, 0.5, 0.06, 0.74, 1.04, 0x3a4766);
    }
  }

  /** What tells the rooms apart at a glance: an accent strip along the walls, the name on the floor, rugs and a few props. */
  private buildRoomIdentity(v: Voxels): void {
    const dim = (c: number, k: number): number => new THREE.Color(c).multiplyScalar(k).getHex();
    for (const r of ROOMS) {
      if (r.id === 'hall') continue;
      const a = dim(ACCENT[r.id], 0.55);
      const top = r.y1 < 8;
      const wz = top ? r.y0 + 0.03 : r.y1 + 1 - 0.03; // the solid back wall (north for the top row, south for the bottom)
      const len = r.x1 - r.x0 + 1, deep = r.y1 - r.y0 + 1;
      v.add(r.x0 + len / 2, 0.05, wz, len, 0.05, 0.04, a, true);
      v.add(r.x0 + 0.03, 0.05, r.y0 + deep / 2, 0.04, 0.05, deep, a, true);
      v.add(r.x1 + 1 - 0.03, 0.05, r.y0 + deep / 2, 0.04, 0.05, deep, a, true);
      // the room's name on the floor, just inside its door
      const sign = floorSign(r.name, ACCENT[r.id]);
      sign.position.set(r.x0 + 5, 0.022, top ? r.y1 + 0.55 : r.y0 + 0.6);
      this.scene.add(sign);
    }
    // hall: a runner down the middle and a door mat at each doorway
    v.add(17, 0.005, 9, 30, 0.01, 0.9, 0x2a2f52);
    v.add(17, 0.007, 9, 30, 0.01, 0.06, 0x4a5490);
    for (const x of [6, 17, 28]) for (const z of [7.5, 10.5]) v.add(x, 0.006, z, 1.9, 0.01, 0.7, 0x1a1d2a);
    // vault: a cart of gold and red laser beams across the vault door
    v.add(2.2, 0.25, 4.6, 0.9, 0.08, 0.6, 0x5b6170); v.add(2.2, 0.13, 4.6, 0.06, 0.26, 0.06, 0x2a2a2a);
    for (let k = 0; k < 6; k++) v.add(1.95 + (k % 3) * 0.25, 0.34 + Math.floor(k / 3) * 0.1, 4.6, 0.22, 0.09, 0.4, 0xe8c34a);
    for (let k = 0; k < 3; k++) v.add(6.5, 0.45 + k * 0.32, 1.35, 2.6, 0.015, 0.015, 0xff3344, true);
    // servers: cable trays on the floor
    for (const z of [3.2, 4.4]) { v.add(16.5, 0.02, z, 8.6, 0.03, 0.22, 0x0e131c); v.add(16.5, 0.04, z - 0.05, 8.4, 0.02, 0.03, z < 4 ? 0x2a7fd0 : 0x2fa860); }
    // audit office: a rug and a coat stand
    v.add(27.5, 0.006, 3.6, 3.2, 0.01, 2.2, 0x5a2e22); v.add(27.5, 0.008, 3.6, 2.8, 0.01, 1.8, 0x7a4430);
    v.add(31.9, 0.6, 5.6, 0.06, 1.2, 0.06, 0x3a2a1c); v.add(31.9, 1.15, 5.6, 0.36, 0.06, 0.06, 0x3a2a1c); v.add(31.75, 0.85, 5.62, 0.22, 0.5, 0.12, 0x2f3d6b);
    // archive: a rug and stacked file boxes
    v.add(6.5, 0.006, 15, 3.4, 0.01, 2.2, 0x3a2a4a); v.add(6.5, 0.008, 15, 3, 0.01, 1.8, 0x4c3860);
    for (let k = 0; k < 5; k++) v.add(9.2 - (k % 2) * 0.45, 0.17 + Math.floor(k / 2) * 0.32, 16.9, 0.42, 0.3, 0.32, k % 2 ? 0xc8a878 : 0xb89868);
    // council: a carpet under the table
    v.add(17, 0.005, 14.4, 6.4, 0.01, 4.6, 0x2a1418);
    // payroll: a printer, a stack of coin rolls, a rug
    v.add(26.4, 0.006, 13.8, 3, 0.01, 2, 0x14403f); v.add(26.4, 0.008, 13.8, 2.6, 0.01, 1.6, 0x1d5655);
    v.add(30.6, 0.4, 12.0, 0.7, 0.8, 0.5, 0x3a3f4a); v.add(30.6, 0.84, 12.0, 0.6, 0.08, 0.42, 0xe8e6df);
    v.add(30.85, 0.7, 12.26, 0.05, 0.05, 0.02, 0x6aff6a, true);
    for (let k = 0; k < 4; k++) v.add(24.2 + k * 0.14, 0.12 + (k % 2) * 0.04, 12.0, 0.1, 0.24 + (k % 2) * 0.08, 0.1, 0xd9b54a);
    // hall: a glowing vending machine
    v.add(32.4, 0.65, 8.35, 0.7, 1.3, 0.5, 0x2a1830);
    this.screens.push({ i: v.add(32.4, 0.75, 8.61, 0.5, 0.8, 0.01, 0xff7ad0, true), c: new THREE.Color(0xff7ad0) });
  }

  private buildSkyline(v: Voxels): void {
    let x = -20;
    let seed = 7;
    const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    while (x < 56) {
      const w = 2 + rnd() * 4, h = 4 + rnd() * 16, z = -6 - rnd() * 14;
      v.add(x + w / 2, h / 2 - 0.2, z, w, h, 3, 0x0b1020);
      for (let wy = 1; wy < h - 0.5; wy += 0.9) for (let wx = 0.5; wx < w - 0.4; wx += 0.7) {
        if (rnd() < 0.28) v.add(x + wx, wy, z + 1.52, 0.32, 0.4, 0.02, rnd() < 0.8 ? 0xffd27a : 0x9fd0ff, true);
      }
      x += w + 0.4 + rnd() * 1.2;
    }
    // the moon
    v.add(-6, 26, -50, 4, 4, 1, 0xf3efd6, true);
    v.add(-5, 26.8, -49.4, 1, 1, 0.2, 0xd7d2b8, true);
  }

  // ---------- the live parts ----------

  setMode(m: 'title' | 'play'): void { this.mode = m; }

  setActors(list: Actor[]): void {
    const seen = new Set<number>();
    for (const a of list) {
      seen.add(a.seat);
      let f = this.figures.get(a.seat);
      if (!f) {
        f = new Figure(a.seat, a.color, a.name);
        f.x = f.tx = a.x; f.z = f.tz = a.y;
        this.figures.set(a.seat, f);
        this.scene.add(f.root);
      }
      if (!f.root.visible) { f.x = a.x; f.z = a.y; }
      f.root.visible = true;
      f.tx = a.x; f.tz = a.y; f.dir = a.dir; f.moving = a.moving;
      f.setGhost(a.ghost);
      f.setMe(!!a.me);
      if (a.me) this.follow.set(a.x, 0, a.y);
    }
    for (const [seat, f] of this.figures) if (!seen.has(seat)) f.root.visible = false;
  }

  /** The local player's predicted position, every frame (smoother than server views). */
  setMe(seat: number, x: number, y: number): void {
    const f = this.figures.get(seat);
    if (f) { f.tx = x; f.tz = y; }
    this.follow.set(x, 0, y);
  }

  setBodies(list: { seat: number; x: number; y: number; color: number; name: string }[]): void {
    const seen = new Set<number>();
    for (const b of list) {
      seen.add(b.seat);
      let f = this.bodies.get(b.seat);
      if (!f) {
        f = new Figure(b.seat, b.color, `${b.name} (frozen)`);
        f.setFrozen(true);
        this.bodies.set(b.seat, f);
        this.scene.add(f.root);
      }
      f.x = f.tx = b.x; f.z = f.tz = b.y;
      f.root.visible = true;
    }
    for (const [seat, f] of this.bodies) if (!seen.has(seat)) f.root.visible = false;
  }

  clearActors(): void {
    for (const f of [...this.figures.values(), ...this.bodies.values()]) this.scene.remove(f.root);
    this.figures.clear();
    this.bodies.clear();
  }

  setDark(d: boolean): void { this.dark = d; }

  highlight(id: StationId | null): void {
    if (!id) { this.ring.visible = false; return; }
    if (id === 'table') { this.ring.position.set(TABLE.cx, 0.66, TABLE.cy); this.ring.scale.set(0.45, 0.45, 1); }
    else { const s = STATIONS.find((q) => q.id === id)!; this.ring.position.set(s.x + 0.5, 0.05, s.y + 0.5); this.ring.scale.set(1, 1, 1); }
    this.ring.visible = true;
  }

  /** A burst of little cubes (a freeze, a filed spend, a duty done). */
  burst(x: number, y: number, color: number, n = 24): void {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), new THREE.MeshBasicMaterial({ color, transparent: true, toneMapped: false }), n);
    const pos: THREE.Vector3[] = [];
    const vel: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      pos.push(new THREE.Vector3(x, 0.8, y));
      vel.push(new THREE.Vector3((Math.random() - 0.5) * 3, 1.5 + Math.random() * 2.5, (Math.random() - 0.5) * 3));
    }
    this.scene.add(mesh);
    this.bursts.push({ mesh, pos, vel, life: 1 });
  }

  private frame(): void {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;
    const t = this.time;
    for (const f of this.figures.values()) f.update(dt, t);
    for (const f of this.bodies.values()) f.update(dt, t);

    // blinking server lights and flickering screens
    const col = new THREE.Color();
    for (const b of this.blinkers) this.glow.setColorAt(b.i, Math.sin(t * b.rate + b.phase) > -0.2 ? b.on : b.off);
    for (const s of this.screens) this.glow.setColorAt(s.i, col.copy(s.c).multiplyScalar((this.dark ? 0.35 : 1) * (0.92 + Math.sin(t * 7 + s.i) * 0.04)));
    if (this.glow.instanceColor) this.glow.instanceColor.needsUpdate = true;

    // lamps: dim in a blackout
    const dim = this.dark ? 0.12 : 1;
    for (const l of this.lamps) l.light.intensity += (l.base * dim * (0.97 + Math.sin(t * 3 + l.base) * 0.03) - l.light.intensity) * Math.min(1, dt * 4);
    this.ambient.intensity += ((this.dark ? 0.3 : 1.6) - this.ambient.intensity) * Math.min(1, dt * 4);
    this.moon.intensity = this.dark ? 0.25 : 0.9;
    for (const m of this.pools) m.opacity += ((this.dark ? 0.05 : 0.32) - m.opacity) * Math.min(1, dt * 4);

    this.ring.rotation.z = Math.PI / 4 + t * 0.6;
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.55 + Math.sin(t * 5) * 0.3;

    for (const b of [...this.bursts]) {
      b.life -= dt;
      const m = new THREE.Matrix4();
      b.pos.forEach((p, i) => {
        b.vel[i].y -= 6 * dt;
        p.addScaledVector(b.vel[i], dt);
        if (p.y < 0.05) { p.y = 0.05; b.vel[i].multiplyScalar(0.4); }
        b.mesh.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z));
      });
      b.mesh.instanceMatrix.needsUpdate = true;
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, b.life);
      if (b.life <= 0) { this.scene.remove(b.mesh); this.bursts.splice(this.bursts.indexOf(b), 1); }
    }

    if (this.mode === 'title') {
      const a = t * 0.06;
      this.camera.position.set(17 + Math.sin(a) * 9, 17, 22 + Math.cos(a) * 4);
      this.camera.lookAt(17, 0, 8.5);
      this.torch.intensity = 0;
    } else {
      // a phone held upright sees a narrow strip: pull the camera back so a room still fits across
      const k = this.camera.aspect < 0.9 ? Math.min(1.45, Math.sqrt(0.9 / this.camera.aspect)) : 1;
      const want = new THREE.Vector3(this.follow.x, 12.5 * k, this.follow.z + 9.5 * k);
      this.camera.position.lerp(want, 1 - Math.exp(-dt * 6));
      this.camera.lookAt(this.camera.position.x, 0, this.camera.position.z - 9.5 * k - 0.6);
      this.torch.position.set(this.follow.x, 1.6, this.follow.z + 0.3);
      this.torch.intensity = this.dark ? 3.5 : 2.5;
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** Where a world point lands on screen (for floating labels), or null if behind. */
  project(x: number, y: number, h = 1.3): { x: number; y: number } | null {
    const v = new THREE.Vector3(x, h, y).project(this.camera);
    if (v.z > 1) return null;
    return { x: ((v.x + 1) / 2) * this.renderer.domElement.clientWidth, y: ((1 - v.y) / 2) * this.renderer.domElement.clientHeight };
  }
}

export { ROOMS };
