/**
 * Moonshot scene: chunky pixel art drawn into a small offscreen buffer and
 * scaled up with nearest-neighbour filtering, Canvas 2D only.
 *
 * World model: altitude is ln(multiplier). Because m(t) = e^(kt), the camera
 * climbs at a constant speed, and every landmark sits at the altitude of its
 * multiplier — the Moon is passed at exactly 2x, Mars at 5x, and so on.
 *
 * The rocket carries the player's Friend in the cockpit dome and up to eight
 * crew Friends on outrigger seats. Ejections, parachutes, the crash and the
 * burning debris are all particles/actors owned by this class.
 */
import type { SpriteRows } from "./crew";
import { FAMILY_COLORS } from "./crew";
import { skinById, trailById, type Skin, type Trail } from "./looks";

export type ScenePhase = "boarding" | "flying" | "crashed";

export interface SceneCrew {
  id: number;
  frames: SpriteRows[];
  familyId: number;
  seat: number;
  joinedT: number; // seconds since this member sat down
}

export interface SceneState {
  phase: ScenePhase;
  phaseT: number; // seconds in the current phase (flight time is scaled)
  multiplier: number;
  crew: SceneCrew[]; // members currently in their seats
  playerAboard: boolean;
  playerWatching: boolean; // player sits out: shown on the control bunker
}

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number; size: number;
  colors: string[]; shape: "px" | "puff" | "heart" | "star" | "chunk";
  g: number; world: boolean; // world particles scroll with the camera
}

interface Chute {
  key: string; sprite: HTMLCanvasElement; x: number; y: number; vx: number; vy: number;
  t: number; color: string; label: string; big: boolean; sway: number;
}

interface Debris {
  sprite: HTMLCanvasElement; x: number; y: number; vx: number; vy: number;
  rot: number; vr: number; t: number;
}

interface Star { x: number; y: number; layer: number; tw: number; }

const INK = "#0a0b14";
const PAPER = "#f4f1e8";
const PX_PER_ALT = 170; // buffer pixels per ln-unit of multiplier

/** Landmarks, placed at the altitude of their multiplier. */
const LANDMARKS: { m: number; kind: string; side: 1 | -1 }[] = [
  { m: 1.45, kind: "clouds", side: 1 },
  { m: 2, kind: "moon", side: 1 },
  { m: 3, kind: "satellite", side: -1 },
  { m: 5, kind: "mars", side: -1 },
  { m: 10, kind: "saturn", side: 1 },
  { m: 25, kind: "nebula", side: -1 },
  { m: 50, kind: "blackhole", side: 1 },
  { m: 100, kind: "galaxy", side: -1 },
];

const RULER = [1.5, 2, 3, 5, 10, 20, 50, 100, 250, 1000];

// 3x5 pixel font for the in-world labels.
const GLYPHS: Record<string, string> = {
  "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111",
  "4": "101101111001001", "5": "111100111001111", "6": "111100111101111", "7": "111001010010010",
  "8": "111101111101111", "9": "111101111001111", ".": "000000000000010", "x": "000101010101000",
  "+": "000010111010000", "-": "000000111000000",
};

function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(c: string): [number, number, number] {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

function mix(a: string, b: string, t: number): string {
  const pa = hexToRgb(a), pb = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * k)).join(",")})`;
}

/** Render a 16x16 sprite with a 1px ink outline onto an 18x18 canvas. */
export function spriteCanvas(rows: SpriteRows, fill: string, outline = INK): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 18; c.height = 18;
  const g = c.getContext("2d")!;
  const on = (x: number, y: number) => y >= 0 && y < 16 && x >= 0 && x < 16 && rows[y]?.[x] === "#";
  g.fillStyle = outline;
  for (let y = -1; y <= 16; y++) {
    for (let x = -1; x <= 16; x++) {
      if (on(x, y)) continue;
      if (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1)) g.fillRect(x + 1, y + 1, 1, 1);
    }
  }
  g.fillStyle = fill;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (on(x, y)) g.fillRect(x + 1, y + 1, 1, 1);
  return c;
}

export class MoonshotScene {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private buf: HTMLCanvasElement;
  private b: CanvasRenderingContext2D;
  private W = 320;
  private H = 200;
  private scale = 2;
  private dpr = 1;
  private reduced = false;
  private time = 0;
  private stars: Star[] = [];
  private particles: Particle[] = [];
  private chutes: Chute[] = [];
  private debris: Debris[] = [];
  private shake = 0;
  private flash = 0;
  private fade = 0;
  private lastPhase: ScenePhase = "boarding";
  private rocketY = 0; // rocket base y in buffer px (screen space)
  private crashY = 0;
  private alt = 0;
  private skin: Skin = skinById("classic");
  private trail: Trail = trailById("flame");
  private pilot: HTMLCanvasElement[] = [];
  private spriteCache = new Map<string, HTMLCanvasElement[]>();
  private burnedCache = new Map<string, HTMLCanvasElement>();
  private boardFx = new Map<number, number>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.buf = document.createElement("canvas");
    this.b = this.buf.getContext("2d")!;
    this.resize();
  }

  setReducedMotion(on: boolean): void { this.reduced = on; }
  setLook(skinId: string, trailId: string): void { this.skin = skinById(skinId); this.trail = trailById(trailId); }

  setPilot(frames: SpriteRows[] | null): void {
    this.pilot = frames ? frames.map(r => spriteCanvas(r, PAPER)) : [];
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width), cssH = Math.max(1, rect.height);
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.scale = Math.max(1, Math.min(6, Math.round(cssH / 185)));
    this.W = Math.ceil(cssW / this.scale);
    this.H = Math.ceil(cssH / this.scale);
    this.buf.width = this.W; this.buf.height = this.H;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.seedStars();
  }

  private seedStars(): void {
    const r = mulberry32(42);
    const n = Math.round((this.W * this.H) / 260);
    this.stars = Array.from({ length: n }, () => ({
      x: Math.floor(r() * this.W), y: r() * this.H * 3, layer: r() < 0.6 ? 0 : r() < 0.75 ? 1 : 2, tw: r() * 6.28,
    }));
  }

  private sprites(key: string, frames: SpriteRows[]): HTMLCanvasElement[] {
    let s = this.spriteCache.get(key);
    if (!s) { s = frames.map(f => spriteCanvas(f, PAPER)); this.spriteCache.set(key, s); }
    return s;
  }

  private burned(key: string, frames: SpriteRows[]): HTMLCanvasElement {
    let s = this.burnedCache.get(key);
    if (!s) { s = spriteCanvas(frames[0], "#ff7b39", "#2a0d05"); this.burnedCache.set(key, s); }
    return s;
  }

  // ---- geometry ----
  private get cx(): number { return Math.round(this.W / 2); }
  private get padY(): number { return this.H - 16; }
  private get cruiseY(): number { return this.H - Math.max(26, Math.round(this.H * 0.13)); }

  private seatPos(seat: number): { x: number; y: number; side: number } {
    const side = seat % 2 === 0 ? -1 : 1;
    const level = Math.floor(seat / 2);
    return { x: this.cx + side * 22, y: this.rocketY - 78 + level * 15, side };
  }

  private cockpit(): { x: number; y: number } {
    return { x: this.cx, y: this.rocketY - 62 };
  }

  // ---- events from the game ----
  boarded(seat: number): void { this.boardFx.set(seat, 0); }

  ejectCrew(c: SceneCrew, multiplier: number): void {
    const p = this.seatPos(c.seat);
    this.chutes.push({
      key: `c${c.id}`, sprite: this.sprites(`c${c.id}`, c.frames)[0], x: p.x, y: p.y + 8,
      vx: p.side * (18 + Math.random() * 14), vy: -26, t: 0, color: FAMILY_COLORS[c.familyId] ?? PAPER,
      label: `${multiplier.toFixed(2)}x`, big: false, sway: Math.random() * 6,
    });
    this.puff(p.x, p.y + 8, 6, ["#ffffff", "#c9cbe0"]);
  }

  ejectPlayer(multiplier: number): void {
    const p = this.cockpit();
    this.chutes.push({
      key: "player", sprite: this.pilot[0] ?? spriteCanvas(Array(16).fill("................"), PAPER), x: p.x, y: p.y,
      vx: 14, vy: -40, t: 0, color: "#ffd23f", label: `${multiplier.toFixed(2)}x`, big: true, sway: 0,
    });
    this.puff(p.x, p.y, 12, ["#fff7cf", "#ffd23f", "#ffffff"]);
    this.ring(p.x, p.y, "#ffd23f");
  }

  crash(crew: SceneCrew[], playerAboard: boolean): void {
    const x = this.cx, y = this.rocketY - 40;
    this.crashY = this.rocketY;
    const many = this.reduced ? 40 : 140;
    for (let i = 0; i < many; i++) {
      const a = Math.random() * Math.PI * 2, s = 20 + Math.random() * 120;
      this.particles.push({
        x, y: y + (Math.random() - 0.5) * 50, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 20,
        life: 0, max: 0.6 + Math.random() * 1.1, size: 1 + Math.floor(Math.random() * 3),
        colors: ["#ffffff", "#fff2a8", "#ffb23f", "#ff5a2e", "#b8321e", "#4b4a5c"], shape: "puff", g: 40, world: false,
      });
    }
    const hull = [this.skin.body, this.skin.shade, this.skin.trim, this.skin.nose];
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2, s = 40 + Math.random() * 90;
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, life: 0, max: 1.6 + Math.random(), size: 2 + Math.floor(Math.random() * 3),
        colors: [hull[i % hull.length]], shape: "chunk", g: 140, world: false,
      });
    }
    for (const c of crew) {
      const p = this.seatPos(c.seat);
      this.debris.push({
        sprite: this.burned(`c${c.id}`, c.frames), x: p.x, y: p.y + 8,
        vx: p.side * (30 + Math.random() * 50), vy: -60 - Math.random() * 50, rot: 0, vr: (Math.random() - 0.5) * 10, t: 0,
      });
    }
    if (playerAboard && this.pilot[0]) {
      const p = this.cockpit();
      this.debris.push({ sprite: this.pilot[0], x: p.x, y: p.y, vx: 10, vy: -90, rot: 0, vr: 6, t: 0 });
    }
    this.ring(x, y, "#ff7b39");
    if (!this.reduced) { this.shake = 1; this.flash = 1; }
  }

  private ring(x: number, y: number, color: string): void {
    if (this.reduced) return;
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      this.particles.push({ x, y, vx: Math.cos(a) * 90, vy: Math.sin(a) * 90, life: 0, max: 0.45, size: 1, colors: [color, color], shape: "px", g: 0, world: false });
    }
  }

  private puff(x: number, y: number, n: number, colors: string[]): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 10 + Math.random() * 30;
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 0.4 + Math.random() * 0.4, size: 2, colors, shape: "puff", g: 0, world: false });
    }
  }

  // ---- frame ----
  frame(s: SceneState, dt: number): void {
    this.time += dt;
    if (s.phase === "boarding" && this.lastPhase !== "boarding") {
      this.fade = 1;
      this.chutes = [];
      this.debris = [];
      this.particles = [];
    }
    this.lastPhase = s.phase;

    // Camera / rocket placement.
    const liftT = s.phase === "flying" ? Math.min(1, s.phaseT / 1.6) : s.phase === "boarding" ? 0 : 1;
    const ease = 1 - Math.pow(1 - liftT, 3);
    if (s.phase !== "crashed") this.rocketY = Math.round(this.padY + (this.cruiseY - this.padY) * ease);
    const targetAlt = s.phase === "boarding" ? 0 : Math.log(Math.max(1, s.multiplier));
    this.alt = targetAlt;
    const scrollV = s.phase === "flying" ? 0.12 * PX_PER_ALT : 0; // px/s the world moves down

    const g = this.b;
    g.imageSmoothingEnabled = false;
    this.drawSky(s);
    this.drawStars(dt, scrollV);
    this.drawRuler();
    this.drawLandmarks();
    this.drawGround(s);
    if (s.phase === "flying" && s.multiplier > 2.5 && !this.reduced) this.drawStreaks(s.multiplier);

    // Exhaust.
    if (s.phase === "flying") this.exhaust(s, dt, 1);
    else if (s.phase === "boarding") this.exhaust(s, dt, 0.15);

    this.stepParticles(dt, scrollV, false);
    if (s.phase !== "crashed") this.drawRocket(s);
    this.stepChutes(dt, scrollV);
    this.stepDebris(dt);
    this.stepParticles(0, 0, true);

    // Blit with shake.
    let ox = 0, oy = 0;
    if (this.shake > 0) {
      ox = Math.round((Math.random() - 0.5) * 6 * this.shake);
      oy = Math.round((Math.random() - 0.5) * 6 * this.shake);
      this.shake = Math.max(0, this.shake - dt * 2.2);
    }
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.imageSmoothingEnabled = false;
    c.fillStyle = "#05060d";
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const k = this.scale * this.dpr;
    c.drawImage(this.buf, ox * k, oy * k, this.W * k, this.H * k);
    if (this.flash > 0) {
      c.fillStyle = `rgba(255,236,200,${this.flash * 0.55})`;
      c.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.flash = Math.max(0, this.flash - dt * 3);
    }
    if (this.fade > 0) {
      c.fillStyle = `rgba(5,6,13,${this.fade})`;
      c.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.fade = Math.max(0, this.fade - dt * 2.5);
    }
  }

  /** Screen y for something at the altitude of multiplier m. */
  private altY(m: number): number {
    const ref = (this.lastPhase === "crashed" ? this.crashY : this.rocketY) - 45;
    return ref - (Math.log(m) - this.alt) * PX_PER_ALT;
  }

  private drawSky(s: SceneState): void {
    const g = this.b;
    const a = this.alt;
    const top = a < 0.6 ? mix("#191c47", "#0c0d22", a / 0.6) : mix("#0c0d22", "#040409", (a - 0.6) / 1.4);
    const bot = a < 0.6 ? mix("#4a3470", "#1a1b40", a / 0.6) : mix("#1a1b40", "#08081a", (a - 0.6) / 1.4);
    const grad = g.createLinearGradient(0, 0, 0, this.H);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bot);
    g.fillStyle = grad;
    g.fillRect(0, 0, this.W, this.H);
    // Deep-space tint as the climb gets extreme.
    if (s.multiplier > 20) {
      g.fillStyle = `rgba(80,30,120,${Math.min(0.25, (Math.log(s.multiplier) - 3) * 0.12)})`;
      g.fillRect(0, 0, this.W, this.H);
    }
  }

  private drawStars(dt: number, scrollV: number): void {
    const g = this.b;
    const vis = Math.min(1, 0.35 + this.alt * 0.8);
    const speeds = [0.08, 0.2, 0.45];
    for (const st of this.stars) {
      st.y += scrollV * speeds[st.layer] * dt;
      const span = this.H * 3;
      const y = ((st.y % span) + span) % span - this.H;
      if (y < 0 || y >= this.H) continue;
      const tw = 0.55 + 0.45 * Math.sin(this.time * (1.3 + st.layer) + st.tw);
      g.globalAlpha = vis * tw * (st.layer === 0 ? 0.55 : st.layer === 1 ? 0.8 : 1);
      g.fillStyle = st.layer === 2 ? "#ffffff" : st.layer === 1 ? "#dfe4ff" : "#9aa3d6";
      g.fillRect(st.x, Math.floor(y), 1, 1);
      if (st.layer === 2 && tw > 0.95) {
        g.fillRect(st.x - 1, Math.floor(y), 3, 1);
        g.fillRect(st.x, Math.floor(y) - 1, 1, 3);
      }
    }
    g.globalAlpha = 1;
  }

  private drawStreaks(m: number): void {
    const g = this.b;
    const n = Math.min(26, Math.floor((Math.log(m) - 0.9) * 10));
    const r = mulberry32(Math.floor(this.time * 30));
    g.fillStyle = "rgba(220,230,255,0.35)";
    for (let i = 0; i < n; i++) {
      const x = Math.floor(r() * this.W), y = Math.floor(r() * this.H), len = 6 + Math.floor(r() * 14);
      if (Math.abs(x - this.cx) < 34) continue;
      g.fillRect(x, y, 1, len);
    }
  }

  private text(str: string, x: number, y: number, color: string, align: "left" | "right" | "center" = "left"): void {
    const g = this.b;
    const w = str.length * 4 - 1;
    let px = align === "center" ? x - Math.floor(w / 2) : align === "right" ? x - w : x;
    g.fillStyle = color;
    for (const ch of str) {
      const glyph = GLYPHS[ch];
      if (glyph) for (let i = 0; i < 15; i++) if (glyph[i] === "1") g.fillRect(px + (i % 3), y + Math.floor(i / 3), 1, 1);
      px += 4;
    }
  }

  private drawRuler(): void {
    const g = this.b;
    for (const m of RULER) {
      const y = Math.round(this.altY(m));
      if (y < 4 || y > this.H - 4) continue;
      const passed = Math.exp(this.alt) >= m;
      const col = passed ? "rgba(200,255,90,0.75)" : "rgba(170,180,230,0.45)";
      g.fillStyle = col;
      for (let x = 2; x < 22; x += 3) g.fillRect(x, y, 2, 1);
      this.text(`${m}x`, 3, y - 7, passed ? "#c8ff5a" : "#aab4e6");
    }
  }

  private drawLandmarks(): void {
    for (const l of LANDMARKS) {
      const y = this.altY(l.m);
      if (y < -90 || y > this.H + 90) continue;
      const x = this.cx + l.side * Math.max(70, Math.min(150, this.W * 0.3));
      switch (l.kind) {
        case "clouds": this.clouds(y); break;
        case "moon": this.planet(x, y, 20, "#e9e4d4", "#b9b3a2", true); break;
        case "satellite": this.satellite(x, y); break;
        case "mars": this.planet(x, y, 16, "#ff7a4a", "#b8452a", false); break;
        case "saturn": this.saturn(x, y); break;
        case "nebula": this.nebula(x, y); break;
        case "blackhole": this.blackhole(x, y); break;
        case "galaxy": this.galaxy(x, y); break;
      }
    }
  }

  private disc(x: number, y: number, r: number, fill: string): void {
    const g = this.b;
    g.fillStyle = fill;
    for (let dy = -r; dy <= r; dy++) {
      const w = Math.floor(Math.sqrt(r * r - dy * dy));
      g.fillRect(Math.round(x - w), Math.round(y + dy), w * 2 + 1, 1);
    }
  }

  private planet(x: number, y: number, r: number, light: string, dark: string, craters: boolean): void {
    const g = this.b;
    g.fillStyle = "rgba(255,240,210,0.06)";
    this.disc(x, y, r + 5, "rgba(255,240,210,0.07)");
    this.disc(x, y, r, dark);
    // lit crescent: offset disc clipped to the planet
    g.save();
    g.beginPath(); g.rect(x - r, y - r, r * 2 + 1, r * 2 + 1); g.clip();
    for (let dy = -r; dy <= r; dy++) {
      const w = Math.floor(Math.sqrt(r * r - dy * dy));
      const w2 = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)) * 0.75);
      g.fillStyle = light;
      g.fillRect(Math.round(x - w), Math.round(y + dy), Math.max(0, w + w2), 1);
    }
    g.restore();
    if (craters) {
      this.disc(x - 7, y - 5, 3, dark);
      this.disc(x + 2, y + 7, 4, dark);
      this.disc(x - 9, y + 8, 2, dark);
    } else {
      g.fillStyle = dark;
      g.fillRect(Math.round(x - r + 3), Math.round(y - 3), r, 2);
      g.fillRect(Math.round(x - r + 6), Math.round(y + 5), r - 2, 1);
    }
  }

  private saturn(x: number, y: number): void {
    const g = this.b;
    // Tilted elliptical ring: back half behind the planet, front half over it.
    const ring = (front: boolean) => {
      for (let i = 0; i < 160; i++) {
        const a = (i / 160) * Math.PI * 2;
        const sin = Math.sin(a);
        if (front !== sin > 0) continue;
        const rx = Math.cos(a) * 30, ry = sin * 7;
        const px = x + rx * 0.97 - ry * 0.25, py = y + ry + rx * 0.18;
        g.fillStyle = i % 9 === 0 ? "#8f6b2e" : front ? "#f0d08a" : "#b8914a";
        g.fillRect(Math.round(px), Math.round(py), 2, 1);
      }
    };
    ring(false);
    this.planet(x, y, 14, "#ffe0a0", "#c08a3a", false);
    ring(true);
  }

  private satellite(x: number, y: number): void {
    const g = this.b;
    const t = this.time;
    g.fillStyle = "#6f8fd8";
    g.fillRect(Math.round(x - 16), Math.round(y - 3), 11, 6);
    g.fillRect(Math.round(x + 6), Math.round(y - 3), 11, 6);
    g.fillStyle = "#9fb8ff";
    for (let i = 0; i < 11; i += 3) { g.fillRect(Math.round(x - 16 + i), Math.round(y - 3), 1, 6); g.fillRect(Math.round(x + 6 + i), Math.round(y - 3), 1, 6); }
    g.fillStyle = "#e9e4d4";
    g.fillRect(Math.round(x - 4), Math.round(y - 5), 9, 10);
    g.fillStyle = Math.sin(t * 6) > 0 ? "#ff4d5e" : "#401018";
    g.fillRect(Math.round(x), Math.round(y - 8), 1, 3);
  }

  private nebula(x: number, y: number): void {
    const g = this.b;
    const r = mulberry32(7);
    for (let i = 0; i < 90; i++) {
      const a = r() * 6.28, d = r() * 40;
      g.fillStyle = i % 3 === 0 ? "rgba(255,90,200,0.35)" : i % 3 === 1 ? "rgba(120,110,255,0.35)" : "rgba(80,220,255,0.3)";
      g.fillRect(Math.round(x + Math.cos(a) * d * 1.4), Math.round(y + Math.sin(a) * d * 0.7), 3, 2);
    }
  }

  private blackhole(x: number, y: number): void {
    const g = this.b;
    const t = this.time;
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * 6.28 + t * 0.8;
      g.fillStyle = i % 2 ? "#ffb347" : "#ff6a3d";
      g.fillRect(Math.round(x + Math.cos(a) * 26), Math.round(y + Math.sin(a) * 8), 2, 1);
    }
    this.disc(x, y, 11, "#000000");
    g.fillStyle = "#ffd9a0";
    g.fillRect(Math.round(x - 12), Math.round(y), 25, 1);
  }

  private galaxy(x: number, y: number): void {
    const g = this.b;
    for (let arm = 0; arm < 2; arm++) {
      for (let i = 0; i < 70; i++) {
        const a = i * 0.12 + arm * Math.PI + this.time * 0.2, d = i * 0.55;
        g.fillStyle = i < 12 ? "#fff6d8" : i % 2 ? "#b9a6ff" : "#7fc8ff";
        g.fillRect(Math.round(x + Math.cos(a) * d), Math.round(y + Math.sin(a) * d * 0.5), 1, 1);
      }
    }
  }

  private clouds(y: number): void {
    const g = this.b;
    const r = mulberry32(3);
    for (let i = 0; i < 9; i++) {
      const cx = r() * this.W, cy = y + (r() - 0.5) * 60, w = 22 + r() * 40;
      if (Math.abs(cx - this.cx) < 30) continue;
      g.fillStyle = "rgba(190,180,230,0.28)";
      g.fillRect(Math.round(cx - w / 2), Math.round(cy), Math.round(w), 5);
      g.fillRect(Math.round(cx - w / 3), Math.round(cy - 3), Math.round(w * 0.6), 3);
      g.fillStyle = "rgba(255,255,255,0.18)";
      g.fillRect(Math.round(cx - w / 3), Math.round(cy - 3), Math.round(w * 0.4), 1);
    }
  }

  private drawGround(s: SceneState): void {
    const g = this.b;
    const gy = Math.round(this.altY(1) + 45 + 1); // pad surface
    if (gy > this.H + 40) return;
    // Far city skyline.
    const r = mulberry32(11);
    let x = 0;
    while (x < this.W) {
      const w = 6 + Math.floor(r() * 12), h = 6 + Math.floor(r() * 22);
      g.fillStyle = "#16163a";
      g.fillRect(x, gy - h, w, h + 40);
      g.fillStyle = "rgba(255,210,120,0.55)";
      for (let wy = gy - h + 3; wy < gy - 2; wy += 4) for (let wx = x + 2; wx < x + w - 1; wx += 3) if (r() < 0.3) g.fillRect(wx, wy, 1, 1);
      x += w + 1 + Math.floor(r() * 4);
    }
    // Ground.
    g.fillStyle = "#0f0f22";
    g.fillRect(0, gy, this.W, 60);
    g.fillStyle = "#26264e";
    g.fillRect(0, gy, this.W, 1);
    // Launch pad.
    g.fillStyle = "#3a3b66";
    g.fillRect(this.cx - 34, gy - 3, 68, 3);
    g.fillStyle = "#c8ff5a";
    for (let i = -32; i < 34; i += 6) g.fillRect(this.cx + i, gy - 3, 3, 1);
    // Gantry tower.
    const tx = this.cx - 52;
    g.fillStyle = "#5b5f9a";
    g.fillRect(tx, gy - 96, 2, 96);
    g.fillRect(tx + 10, gy - 96, 2, 96);
    for (let yy = gy - 96; yy < gy; yy += 8) {
      g.fillRect(tx, yy, 12, 1);
      for (let k = 0; k < 8; k++) g.fillRect(tx + Math.floor(k * 1.4), yy + k, 1, 1);
    }
    if (s.phase === "boarding") {
      g.fillRect(tx + 12, gy - 70, this.cx - 12 - tx - 12, 2); // access arm
      g.fillStyle = Math.sin(this.time * 5) > 0 ? "#ff4d5e" : "#4a1520";
      g.fillRect(tx + 5, gy - 99, 2, 2);
    }
    // Control bunker with the watching Friend.
    const bx = this.cx + 46;
    g.fillStyle = "#23244a";
    g.fillRect(bx, gy - 14, 34, 14);
    g.fillStyle = "#3a3b66";
    g.fillRect(bx, gy - 15, 34, 1);
    g.fillStyle = "#9fe8ff";
    g.fillRect(bx + 4, gy - 10, 26, 4);
    if (s.playerWatching && this.pilot.length) {
      const f = this.pilot[Math.floor(this.time * 4) % this.pilot.length];
      g.drawImage(f, bx + 8, gy - 32);
    }
  }

  private exhaust(s: SceneState, dt: number, power: number): void {
    const t = this.trail;
    const n = this.reduced ? 1 : Math.ceil(power * (3 + Math.min(8, s.multiplier * 1.5)) * dt * 60 / 3);
    const nx = this.cx, ny = this.rocketY + (power < 0.5 ? 2 : 14);
    for (let i = 0; i < n; i++) {
      const spread = power < 0.5 ? 12 : 5 + Math.min(8, s.multiplier);
      this.particles.push({
        x: nx + (Math.random() - 0.5) * 6, y: ny + Math.random() * 2,
        vx: (Math.random() - 0.5) * spread, vy: power < 0.5 ? 6 + Math.random() * 8 : 40 + Math.random() * 50,
        life: 0, max: power < 0.5 ? 0.5 : 0.45 + Math.random() * 0.7, size: power < 0.5 ? 2 : 2 + Math.floor(Math.random() * 3),
        colors: t.colors, shape: t.shape === "puff" ? "puff" : t.shape, g: 0, world: false,
      });
    }
  }

  private stepParticles(dt: number, scrollV: number, drawTop: boolean): void {
    const g = this.b;
    const keep: Particle[] = [];
    for (const p of this.particles) {
      const top = p.shape === "chunk" || p.shape === "px";
      if (top !== drawTop) { keep.push(p); continue; }
      const step = drawTop ? 1 / 60 : dt;
      p.life += step;
      if (p.life >= p.max) continue;
      p.vy += p.g * step;
      p.x += p.vx * step;
      p.y += (p.vy + scrollV * 0.5) * step;
      const k = p.life / p.max;
      const col = p.colors[Math.min(p.colors.length - 1, Math.floor(k * p.colors.length))];
      g.fillStyle = col;
      const x = Math.round(p.x), y = Math.round(p.y);
      if (p.shape === "heart" && k < 0.7) {
        g.fillRect(x - 1, y, 1, 1); g.fillRect(x + 1, y, 1, 1); g.fillRect(x - 1, y + 1, 3, 1); g.fillRect(x, y + 2, 1, 1);
      } else if (p.shape === "star" && k < 0.6) {
        g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3);
      } else {
        const sz = p.shape === "puff" ? Math.max(1, Math.round(p.size * (k < 0.5 ? 1 : 1.6))) : p.size;
        g.fillRect(x, y, sz, sz);
      }
      keep.push(p);
    }
    this.particles = keep.length > 900 ? keep.slice(-900) : keep;
  }

  private drawRocket(s: SceneState): void {
    const g = this.b, sk = this.skin;
    const cx = this.cx;
    const jitter = s.phase === "flying" && !this.reduced && s.multiplier > 3 ? Math.round(Math.sin(this.time * 60) * 0.6) : 0;
    const by = this.rocketY + jitter;
    // Outrigger struts + seats.
    for (let seat = 0; seat < 8; seat++) {
      const p = this.seatPos(seat);
      const sy = p.y + jitter;
      g.fillStyle = "#555a8a";
      const x0 = p.side < 0 ? p.x - 7 : cx + 9;
      g.fillRect(x0, sy + 16, p.side < 0 ? cx - 9 - x0 : p.x + 7 - x0 + 1, 1);
    }
    // Fins.
    g.fillStyle = sk.trim;
    for (let i = 0; i < 16; i++) {
      g.fillRect(cx - 10 - Math.floor(i * 0.6), by - 18 + i, Math.floor(i * 0.6) + 1, 1);
      g.fillRect(cx + 10, by - 18 + i, Math.floor(i * 0.6) + 1, 1);
    }
    g.fillStyle = INK;
    g.fillRect(cx - 20, by - 2, 7, 1);
    g.fillRect(cx + 14, by - 2, 7, 1);
    // Engine flame: a flickering core under the nozzle, sized by the climb.
    const cols = this.trail.colors;
    const len = s.phase === "flying"
      ? 12 + Math.min(26, Math.log(s.multiplier) * 10 + (s.phaseT < 1.6 ? 10 : 0)) + Math.floor(Math.random() * 5)
      : 3 + Math.floor(Math.random() * 2);
    for (let i = 0; i < len; i++) {
      const k = i / len;
      const w = Math.max(1, Math.round((s.phase === "flying" ? 6 : 3) * (1 - k * 0.8) + (Math.random() < 0.3 ? 1 : 0)));
      g.fillStyle = cols[Math.min(cols.length - 2, Math.floor(k * (cols.length - 1)))];
      g.fillRect(cx - w, by + i, w * 2, 1);
      if (i < len * 0.45) {
        g.fillStyle = cols[0];
        g.fillRect(cx - Math.max(1, w - 3), by + i, Math.max(2, (w - 3) * 2), 1);
      }
    }
    // Nozzle.
    g.fillStyle = "#44476e";
    g.fillRect(cx - 5, by - 5, 10, 5);
    g.fillStyle = "#6c7099";
    g.fillRect(cx - 5, by - 5, 10, 1);
    // Body.
    const top = by - 84, bot = by - 5;
    g.fillStyle = INK;
    g.fillRect(cx - 10, top, 21, bot - top);
    g.fillStyle = sk.body;
    g.fillRect(cx - 9, top, 19, bot - top);
    g.fillStyle = sk.shade;
    g.fillRect(cx + 5, top, 5, bot - top);
    g.fillRect(cx - 9, top, 2, bot - top);
    g.fillStyle = sk.trim;
    g.fillRect(cx - 9, by - 30, 19, 3);
    g.fillRect(cx - 9, by - 22, 19, 1);
    // Nose cone.
    for (let i = 0; i < 18; i++) {
      const w = Math.max(1, Math.round(10 * Math.sqrt(i / 18)));
      g.fillStyle = INK;
      g.fillRect(cx - w - 1, top - 18 + i, w * 2 + 3, 1);
      g.fillStyle = sk.nose;
      g.fillRect(cx - w, top - 18 + i, w * 2 + 1, 1);
    }
    g.fillStyle = "#ffffff";
    g.globalAlpha = 0.35;
    g.fillRect(cx - 4, top - 12, 1, 10);
    g.globalAlpha = 1;
    // Cockpit dome with the pilot.
    const cp = this.cockpit();
    this.disc(cx, cp.y + jitter, 11, INK);
    this.disc(cx, cp.y + jitter, 10, s.playerAboard ? "#10323c" : "#1b1c33");
    if (s.playerAboard && this.pilot.length) {
      const f = this.pilot[Math.floor(this.time * 5) % this.pilot.length];
      g.drawImage(f, cx - 9, cp.y - 9 + jitter);
    } else {
      this.text(s.phase === "boarding" ? "-" : "+", cx - 1, cp.y - 2 + jitter, "#3a3d66");
    }
    g.fillStyle = sk.glass;
    g.globalAlpha = 0.45;
    g.fillRect(cx - 6, cp.y - 7 + jitter, 3, 2);
    g.fillRect(cx - 7, cp.y - 5 + jitter, 1, 3);
    g.globalAlpha = 1;
    // Crew.
    for (const c of s.crew) {
      const p = this.seatPos(c.seat);
      const frames = this.sprites(`c${c.id}`, c.frames);
      const f = frames[Math.floor(this.time * 4 + c.id) % frames.length];
      let hop = 0;
      if (c.joinedT < 0.35) hop = -Math.round(Math.sin((c.joinedT / 0.35) * Math.PI) * 6);
      g.drawImage(f, p.x - 9, p.y - 1 + hop + jitter);
      g.fillStyle = FAMILY_COLORS[c.familyId] ?? PAPER;
      g.fillRect(p.x - 6, p.y + 16 + jitter, 12, 1);
    }
  }

  private stepChutes(dt: number, scrollV: number): void {
    const g = this.b;
    const keep: Chute[] = [];
    for (const c of this.chutes) {
      c.t += dt;
      const open = c.t > 0.3;
      if (open) {
        c.vx *= Math.pow(0.2, dt);
        c.vy += (18 - c.vy) * Math.min(1, dt * 3);
      } else {
        c.vy += 90 * dt;
      }
      c.x += (c.vx + (open ? Math.sin(c.t * 2 + c.sway) * 6 : 0)) * dt;
      c.y += (c.vy + scrollV) * dt;
      if (c.y > this.H + 40 || c.t > 12) continue;
      const x = Math.round(c.x), y = Math.round(c.y);
      if (open) {
        const w = c.big ? 15 : 11;
        g.fillStyle = "rgba(230,230,255,0.5)";
        g.fillRect(x - w + 2, y - 12, 1, 12 - 8 + 8);
        g.fillRect(x + w - 2, y - 12, 1, 12);
        for (let i = 0; i < 7; i++) {
          const ww = Math.round(w * Math.sqrt(1 - ((6 - i) / 7) ** 2));
          g.fillStyle = INK;
          g.fillRect(x - ww - 1, y - 20 + i, ww * 2 + 3, 1);
          for (let k = -ww; k <= ww; k++) {
            g.fillStyle = Math.floor((k + w) / 4) % 2 ? c.color : PAPER;
            g.fillRect(x + k, y - 20 + i, 1, 1);
          }
        }
      }
      g.drawImage(c.sprite, x - 9, y - 4);
      if (c.t < 2.2) this.text(`+${c.label}`, x, y - 29, c.big ? "#ffd23f" : "#c8ff5a", "center");
      keep.push(c);
    }
    this.chutes = keep;
  }

  private stepDebris(dt: number): void {
    const g = this.b;
    const keep: Debris[] = [];
    for (const d of this.debris) {
      d.t += dt;
      d.vy += 120 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.rot += d.vr * dt;
      if (d.y > this.H + 30) continue;
      if (!this.reduced && Math.random() < 0.6) {
        this.particles.push({ x: d.x, y: d.y, vx: 0, vy: -8, life: 0, max: 0.5, size: 2, colors: ["#ffb23f", "#ff5a2e", "#4b4a5c"], shape: "puff", g: 0, world: false });
      }
      g.save();
      g.translate(Math.round(d.x), Math.round(d.y));
      g.rotate(Math.round(d.rot / (Math.PI / 4)) * (Math.PI / 4));
      g.drawImage(d.sprite, -9, -9);
      g.restore();
      keep.push(d);
    }
    this.debris = keep;
  }
}
