/**
 * Moonshot scene, drawn in the Rare Friends world style: black ink outlines,
 * white paper, the SDK's game palette (meadow, pond, sun, coral, lilac) and
 * checker-dither shading, rendered into a small buffer and scaled up with
 * nearest-neighbour filtering. Friends stay canonical black-and-white.
 *
 * World model: altitude is ln(multiplier). Because m(t) = e^(kt), the camera
 * climbs at a constant speed and each landmark sits at the altitude of its
 * multiplier — the Moon is passed at exactly 2x, Mars at 5x, and so on. The
 * sky dithers from paper into ink as the rocket leaves the atmosphere.
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
  playerWatching: boolean; // player sits out: shown at mission control
}

type Shape = "puff" | "spark" | "heart" | "star" | "chunk" | "ring";
interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number; size: number; grow: number;
  color: string; shape: Shape; g: number; top: boolean;
}

interface Chute {
  sprite: HTMLCanvasElement; x: number; y: number; vx: number; vy: number;
  t: number; color: string; label: string; big: boolean; sway: number;
}

interface Debris {
  sprite: HTMLCanvasElement; x: number; y: number; vx: number; vy: number;
  rot: number; vr: number; t: number;
}

interface Star { x: number; y: number; layer: number; tw: number; }

// Rare Friends palette (FriendSDK PALETTE + GAME_PALETTE).
export const K = "#000000";
export const WHITE = "#ffffff";
const INK = "#111111";
const MEADOW = "#B9D984";
const POND = "#7DB4DB";
const SUN = "#F2CE68";
const CORAL = "#ED927E";
const LILAC = "#B3A0D8";
const SIGNAL = "#CCFF00";

const PX_PER_ALT = 170; // buffer pixels per ln-unit of multiplier
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

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

// 3x5 pixel font for signs and labels.
const GLYPHS: Record<string, string> = {
  "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111",
  "4": "101101111001001", "5": "111100111001111", "6": "111100111101111", "7": "111001010010010",
  "8": "111101111101111", "9": "111101111001111", ".": "000000000000010", "x": "000101010101000",
  "+": "000010111010000", "-": "000000111000000", " ": "000000000000000",
  A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110",
  E: "111100110100111", F: "111100110100100", G: "011100101101011", H: "101101111101101",
  I: "111010010010111", J: "001001001101010", K: "101101110101101", L: "100100100100111",
  M: "101111111101101", N: "110101101101101", O: "010101101101010", P: "110101110100100",
  Q: "010101101110011", R: "110101110101101", S: "011100010001110", T: "111010010010010",
  U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101",
  Y: "101101010010010", Z: "111001010100111",
};

function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 16x16 sprite on an 18x18 canvas with a 1px outline (Friends: black on white). */
export function spriteCanvas(rows: SpriteRows, fill: string = K, outline: string = WHITE): HTMLCanvasElement {
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
  private rk: HTMLCanvasElement; // rocket layer (for the sticker outline)
  private rg: CanvasRenderingContext2D;
  private sil: HTMLCanvasElement;
  private sg: CanvasRenderingContext2D;
  private sky: ImageData | null = null;
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
  private boom = -1; // seconds since the crash burst, <0 = none
  private boomAt = { x: 0, y: 0 };
  private shake = 0;
  private flash = 0;
  private fade = 0;
  private lastPhase: ScenePhase = "boarding";
  private rocketY = 0;
  private crashY = 0;
  private alt = 0;
  private skin: Skin = skinById("classic");
  private trail: Trail = trailById("flame");
  private pilot: HTMLCanvasElement[] = [];
  private spriteCache = new Map<string, HTMLCanvasElement[]>();
  private burnedCache = new Map<string, HTMLCanvasElement>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.buf = document.createElement("canvas");
    this.b = this.buf.getContext("2d")!;
    this.rk = document.createElement("canvas");
    this.rk.width = 80; this.rk.height = 136;
    this.rg = this.rk.getContext("2d")!;
    this.sil = document.createElement("canvas");
    this.sil.width = 80; this.sil.height = 136;
    this.sg = this.sil.getContext("2d")!;
    this.resize();
  }

  setReducedMotion(on: boolean): void { this.reduced = on; }
  setLook(skinId: string, trailId: string): void { this.skin = skinById(skinId); this.trail = trailById(trailId); }

  setPilot(frames: SpriteRows[] | null): void {
    this.pilot = frames ? frames.map(r => spriteCanvas(r)) : [];
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width), cssH = Math.max(1, rect.height);
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.scale = Math.max(1, Math.min(6, Math.round(cssH / 185)));
    this.W = Math.ceil(cssW / this.scale);
    this.H = Math.ceil(cssH / this.scale);
    this.buf.width = this.W; this.buf.height = this.H;
    this.sky = this.b.createImageData(this.W, this.H);
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    const r = mulberry32(42);
    const n = Math.round((this.W * this.H) / 240);
    this.stars = Array.from({ length: n }, () => ({
      x: Math.floor(r() * this.W), y: r() * this.H * 3, layer: r() < 0.6 ? 0 : r() < 0.75 ? 1 : 2, tw: r() * 6.28,
    }));
  }

  private sprites(key: string, frames: SpriteRows[]): HTMLCanvasElement[] {
    let s = this.spriteCache.get(key);
    if (!s) { s = frames.map(f => spriteCanvas(f)); this.spriteCache.set(key, s); }
    return s;
  }

  private burned(key: string, frames: SpriteRows[]): HTMLCanvasElement {
    let s = this.burnedCache.get(key);
    if (!s) { s = spriteCanvas(frames[0], CORAL, K); this.burnedCache.set(key, s); }
    return s;
  }

  // ---- geometry ----
  private get cx(): number { return Math.round(this.W / 2); }
  private get padY(): number { return this.H - 22; }
  private get cruiseY(): number { return this.H - Math.max(26, Math.round(this.H * 0.13)); }

  private seatPos(seat: number): { x: number; y: number; side: number } {
    const side = seat % 2 === 0 ? -1 : 1;
    const level = Math.floor(seat / 2);
    return { x: this.cx + side * 22, y: this.rocketY - 78 + level * 15, side };
  }

  private cockpit(): { x: number; y: number } {
    return { x: this.cx, y: this.rocketY - 62 };
  }

  /** Sky darkness (0 paper .. 1 ink) at a screen row. */
  private dark(y: number): number {
    const base = Math.max(0, Math.min(1, (this.alt - 0.12) / 1.05));
    return Math.max(0, Math.min(1, base * 1.6 - 0.32 + (1 - y / this.H) * 0.55));
  }

  // ---- events from the game ----
  boarded(seat: number): void {
    const p = this.seatPos(seat);
    this.puffs(p.x, p.y + 14, 3, 1);
  }

  ejectCrew(c: SceneCrew, multiplier: number): void {
    const p = this.seatPos(c.seat);
    this.chutes.push({
      sprite: this.sprites(`c${c.id}`, c.frames)[0], x: p.x, y: p.y + 8,
      vx: p.side * (18 + Math.random() * 14), vy: -26, t: 0, color: FAMILY_COLORS[c.familyId] ?? CORAL,
      label: `+${multiplier.toFixed(2)}x`, big: false, sway: Math.random() * 6,
    });
    this.puffs(p.x, p.y + 8, 4, 1.2);
  }

  ejectPlayer(multiplier: number): void {
    const p = this.cockpit();
    this.chutes.push({
      sprite: this.pilot[0] ?? spriteCanvas(Array(16).fill("................")), x: p.x, y: p.y,
      vx: 14, vy: -40, t: 0, color: SIGNAL, label: `+${multiplier.toFixed(2)}x`, big: true, sway: 0,
    });
    this.puffs(p.x, p.y, 7, 1.6);
    this.sparks(p.x, p.y, 16, [SIGNAL, WHITE, SUN]);
  }

  crash(crew: SceneCrew[], playerAboard: boolean): void {
    const x = this.cx, y = this.rocketY - 44;
    this.crashY = this.rocketY;
    this.boom = 0;
    this.boomAt = { x, y };
    this.puffs(x, y, this.reduced ? 5 : 12, 1.3, 95);
    this.sparks(x, y, this.reduced ? 20 : 70, [SUN, CORAL, WHITE, K]);
    const hull = [this.skin.body, this.skin.trim, this.skin.nose, this.skin.trim];
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2, s = 40 + Math.random() * 90;
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, life: 0, max: 1.6 + Math.random(),
        size: 2 + Math.floor(Math.random() * 3), grow: 0, color: hull[i % hull.length], shape: "chunk", g: 140, top: true,
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
    if (!this.reduced) { this.shake = 1; this.flash = 1; }
  }

  private puffs(x: number, y: number, n: number, size: number, speed = 24): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({
        x: x + (Math.random() - 0.5) * 8, y: y + (Math.random() - 0.5) * 8, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0, max: 0.6 + Math.random() * 0.6, size: 2 + size * Math.random() * 2, grow: 5 * size, color: WHITE, shape: "puff", g: 0, top: true,
      });
    }
  }

  private sparks(x: number, y: number, n: number, colors: string[]): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 30 + Math.random() * 120;
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 20, life: 0, max: 0.4 + Math.random() * 0.8,
        size: 1 + Math.floor(Math.random() * 2), grow: 0, color: colors[i % colors.length], shape: "spark", g: 50, top: true,
      });
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
      this.boom = -1;
    }
    this.lastPhase = s.phase;

    const liftT = s.phase === "flying" ? Math.min(1, s.phaseT / 1.6) : s.phase === "boarding" ? 0 : 1;
    const ease = 1 - Math.pow(1 - liftT, 3);
    if (s.phase !== "crashed") this.rocketY = Math.round(this.padY + (this.cruiseY - this.padY) * ease);
    this.alt = s.phase === "boarding" ? 0 : Math.log(Math.max(1, s.multiplier));
    const scrollV = s.phase === "flying" ? 0.12 * PX_PER_ALT : 0;

    this.b.imageSmoothingEnabled = false;
    this.drawSky();
    this.drawStars(dt, scrollV);
    if (s.phase === "flying" && s.multiplier > 2.5 && !this.reduced) this.drawStreaks(s.multiplier);
    this.drawLandmarks();
    this.drawRuler();
    this.drawIsland(s);
    if (s.phase === "flying") this.exhaust(s, dt, 1);
    else if (s.phase === "boarding" && Math.random() < dt * 4) this.exhaust(s, dt, 0.2);
    this.stepParticles(dt, scrollV, false);
    if (s.phase !== "crashed") {
      this.drawFlame(s);
      this.drawRocket(s);
      this.drawCrew(s);
    }
    this.stepChutes(dt, scrollV);
    this.stepDebris(dt);
    this.drawBoom(dt);
    this.stepParticles(dt, scrollV, true);

    let ox = 0, oy = 0;
    if (this.shake > 0) {
      ox = Math.round((Math.random() - 0.5) * 6 * this.shake);
      oy = Math.round((Math.random() - 0.5) * 6 * this.shake);
      this.shake = Math.max(0, this.shake - dt * 2.2);
    }
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.imageSmoothingEnabled = false;
    c.fillStyle = INK;
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const k = this.scale * this.dpr;
    c.drawImage(this.buf, ox * k, oy * k, this.W * k, this.H * k);
    if (this.flash > 0) {
      c.fillStyle = `rgba(255,255,255,${this.flash * 0.7})`;
      c.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.flash = Math.max(0, this.flash - dt * 3.5);
    }
    if (this.fade > 0) {
      c.fillStyle = `rgba(255,255,255,${this.fade})`;
      c.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.fade = Math.max(0, this.fade - dt * 2.5);
    }
  }

  private altY(m: number): number {
    const ref = (this.lastPhase === "crashed" ? this.crashY : this.rocketY) - 45;
    return ref - (Math.log(m) - this.alt) * PX_PER_ALT;
  }

  // ---- sky ----
  private drawSky(): void {
    const img = this.sky!;
    const px = new Uint32Array(img.data.buffer);
    const ink = 0xff111111, paper = 0xffffffff;
    for (let y = 0; y < this.H; y++) {
      const d = this.dark(y) * 16;
      const row = y * this.W, by = (y & 3) * 4;
      if (d <= 0) { px.fill(paper, row, row + this.W); continue; }
      if (d >= 16) { px.fill(ink, row, row + this.W); continue; }
      for (let x = 0; x < this.W; x++) px[row + x] = BAYER[by + (x & 3)] < d ? ink : paper;
    }
    this.b.putImageData(img, 0, 0);
  }

  private drawStars(dt: number, scrollV: number): void {
    const g = this.b;
    const speeds = [0.08, 0.2, 0.45];
    for (const st of this.stars) {
      st.y += scrollV * speeds[st.layer] * dt;
      const span = this.H * 3;
      const y = Math.floor((((st.y % span) + span) % span) - this.H);
      if (y < 0 || y >= this.H || this.dark(y) < 0.7) continue;
      const tw = Math.sin(this.time * (1.3 + st.layer) + st.tw);
      if (st.layer === 0 && tw < -0.3) continue;
      g.fillStyle = st.layer === 1 && st.tw < 1 ? SUN : WHITE;
      g.fillRect(st.x, y, 1, 1);
      if (st.layer === 2 && tw > 0.8) { g.fillRect(st.x - 1, y, 3, 1); g.fillRect(st.x, y - 1, 1, 3); }
    }
  }

  private drawStreaks(m: number): void {
    const g = this.b;
    const n = Math.min(24, Math.floor((Math.log(m) - 0.9) * 10));
    const r = mulberry32(Math.floor(this.time * 24));
    for (let i = 0; i < n; i++) {
      const x = Math.floor(r() * this.W), y = Math.floor(r() * this.H), len = 5 + Math.floor(r() * 12);
      if (Math.abs(x - this.cx) < 36) continue;
      g.fillStyle = this.dark(y) > 0.5 ? WHITE : K;
      for (let k = 0; k < len; k += 2) g.fillRect(x, y + k, 1, 1);
    }
  }

  // ---- text + signs ----
  private text(str: string, x: number, y: number, color: string): void {
    const g = this.b;
    g.fillStyle = color;
    let px = x;
    for (const ch of str) {
      const glyph = GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()];
      if (glyph) for (let i = 0; i < 15; i++) if (glyph[i] === "1") g.fillRect(px + (i % 3), y + Math.floor(i / 3), 1, 1);
      px += 4;
    }
  }

  /** A paper sign with an ink border, like the SDK world prompts. */
  private sign(str: string, x: number, y: number, align: "left" | "center" = "center", bg = WHITE, fg = K): void {
    const g = this.b;
    const w = str.length * 4 + 3;
    const left = Math.round(align === "center" ? x - w / 2 : x);
    g.fillStyle = K;
    g.fillRect(left, Math.round(y), w, 9);
    g.fillStyle = bg;
    g.fillRect(left + 1, Math.round(y) + 1, w - 2, 7);
    this.text(str, left + 2, Math.round(y) + 2, fg);
  }

  private drawRuler(): void {
    const g = this.b;
    for (const m of RULER) {
      const y = Math.round(this.altY(m));
      if (y < 6 || y > this.H - 12) continue;
      const passed = Math.exp(this.alt) >= m;
      for (let x = 0; x < 20; x += 2) {
        g.fillStyle = (x / 2) % 2 ? WHITE : K;
        g.fillRect(x, y, 2, 1);
      }
      this.sign(`${m}x`, 3, y - 10, "left", passed ? SIGNAL : WHITE);
    }
  }

  // ---- shapes ----
  private disc(x: number, y: number, r: number, fill: string): void {
    const g = this.b;
    g.fillStyle = fill;
    for (let dy = -r; dy <= r; dy++) {
      const w = Math.floor(Math.sqrt(r * r - dy * dy));
      g.fillRect(Math.round(x - w), Math.round(y + dy), w * 2 + 1, 1);
    }
  }

  /** Checker-dither the part of a disc facing away from the light (upper-left). */
  private shadeDisc(x: number, y: number, r: number, color: string, amount = 0.35): void {
    const g = this.b;
    g.fillStyle = color;
    for (let dy = -r; dy <= r; dy++) {
      const w = Math.floor(Math.sqrt(r * r - dy * dy));
      for (let dx = -w; dx <= w; dx++) {
        const lit = (dx + dy * 0.6) / r;
        const px = Math.round(x + dx), py = Math.round(y + dy);
        if (lit > 1 - amount * 2 || (lit > 1 - amount * 3 && (px + py) % 2 === 0)) g.fillRect(px, py, 1, 1);
      }
    }
  }

  /** Sticker disc: white rim, ink outline, fill. */
  private sticker(x: number, y: number, r: number, fill: string): void {
    this.disc(x, y, r + 2, WHITE);
    this.disc(x, y, r + 1, K);
    this.disc(x, y, r, fill);
  }

  // ---- landmarks ----
  private drawLandmarks(): void {
    for (const l of LANDMARKS) {
      const y = this.altY(l.m);
      if (y < -90 || y > this.H + 90) continue;
      const x = this.cx + l.side * Math.max(72, Math.min(150, this.W * 0.3));
      switch (l.kind) {
        case "clouds": this.clouds(y); break;
        case "moon": this.moon(x, y); break;
        case "satellite": this.satellite(x, y); break;
        case "mars": this.mars(x, y); break;
        case "saturn": this.saturn(x, y); break;
        case "nebula": this.nebula(x, y); break;
        case "blackhole": this.blackhole(x, y); break;
        case "galaxy": this.galaxy(x, y); break;
      }
    }
  }

  private moon(x: number, y: number): void {
    this.sticker(x, y, 20, WHITE);
    for (const [cx, cy, r] of [[-7, -5, 4], [4, 7, 5], [-9, 8, 2], [8, -8, 2]]) {
      this.disc(x + cx, y + cy, r + 1, K);
      this.disc(x + cx, y + cy, r, WHITE);
      this.shadeDisc(x + cx, y + cy, r, K, 0.25);
    }
    this.shadeDisc(x, y, 20, K, 0.18);
    this.sign("MOON", x, y + 25);
  }

  private mars(x: number, y: number): void {
    this.sticker(x, y, 16, CORAL);
    const g = this.b;
    g.fillStyle = K;
    for (let i = -12; i <= 12; i += 2) g.fillRect(Math.round(x + i), Math.round(y - 3), 1, 1);
    for (let i = -10; i <= 12; i += 2) g.fillRect(Math.round(x + i), Math.round(y + 6), 1, 1);
    this.disc(x - 5, y - 8, 3, SUN);
    this.shadeDisc(x, y, 16, K, 0.2);
    this.sign("MARS", x, y + 21);
  }

  private saturn(x: number, y: number): void {
    const g = this.b;
    const ring = (front: boolean, color: string, rx: number, ry: number) => {
      for (let i = 0; i < 220; i++) {
        const a = (i / 220) * Math.PI * 2;
        const sin = Math.sin(a);
        if (front !== sin > 0) continue;
        const px = x + Math.cos(a) * rx, py = y + sin * ry + Math.cos(a) * rx * 0.16;
        g.fillStyle = color;
        g.fillRect(Math.round(px), Math.round(py), 2, 2);
      }
    };
    ring(false, K, 33, 9); ring(false, LILAC, 31, 8);
    this.sticker(x, y, 14, SUN);
    g.fillStyle = K;
    for (let i = -10; i <= 10; i += 2) g.fillRect(Math.round(x + i), Math.round(y - 4), 1, 1);
    this.shadeDisc(x, y, 14, K, 0.2);
    ring(true, K, 33, 9); ring(true, LILAC, 31, 8);
    this.sign("SATURN", x, y + 20);
  }

  private satellite(x: number, y: number): void {
    const g = this.b;
    const X = Math.round(x), Y = Math.round(y);
    const panel = (px: number) => {
      g.fillStyle = WHITE; g.fillRect(px - 1, Y - 5, 15, 11);
      g.fillStyle = K; g.fillRect(px, Y - 4, 13, 9);
      g.fillStyle = POND; g.fillRect(px + 1, Y - 3, 11, 7);
      g.fillStyle = K;
      for (let i = 4; i < 12; i += 4) g.fillRect(px + i, Y - 3, 1, 7);
      g.fillRect(px + 1, Y, 11, 1);
    };
    panel(X - 20); panel(X + 8);
    g.fillStyle = WHITE; g.fillRect(X - 7, Y - 8, 15, 17);
    g.fillStyle = K; g.fillRect(X - 6, Y - 7, 13, 15);
    g.fillStyle = WHITE; g.fillRect(X - 5, Y - 6, 11, 13);
    g.fillStyle = K; g.fillRect(X - 1, Y - 12, 1, 5);
    g.fillStyle = Math.sin(this.time * 6) > 0 ? CORAL : K;
    g.fillRect(X - 2, Y - 14, 3, 2);
  }

  private nebula(x: number, y: number): void {
    const g = this.b;
    const r = mulberry32(7);
    const cols = [LILAC, POND, CORAL];
    for (let i = 0; i < 7; i++) {
      const bx = x + (r() - 0.5) * 70, by = y + (r() - 0.5) * 34, rad = 8 + r() * 12, col = cols[i % 3];
      g.fillStyle = col;
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad * 1.5; dx <= rad * 1.5; dx++) {
          const d = (dx / 1.5) ** 2 + dy ** 2;
          const px = Math.round(bx + dx), py = Math.round(by + dy);
          if (d < rad * rad * 0.35 || (d < rad * rad && (px + py) % 2 === 0)) g.fillRect(px, py, 1, 1);
        }
      }
    }
    this.sign("NEBULA", x, y + 26);
  }

  private blackhole(x: number, y: number): void {
    const g = this.b;
    for (let i = 0; i < 90; i++) {
      const a = (i / 90) * 6.28 + this.time * 0.8;
      g.fillStyle = i % 3 === 0 ? CORAL : SUN;
      g.fillRect(Math.round(x + Math.cos(a) * 28), Math.round(y + Math.sin(a) * 8), 2, 1);
    }
    this.disc(x, y, 13, WHITE);
    this.disc(x, y, 12, K);
    this.sign("BLACK HOLE", x, y + 18);
  }

  private galaxy(x: number, y: number): void {
    const g = this.b;
    for (let arm = 0; arm < 2; arm++) {
      for (let i = 0; i < 80; i++) {
        const a = i * 0.12 + arm * Math.PI + this.time * 0.2, d = i * 0.55;
        g.fillStyle = i < 14 ? WHITE : i % 2 ? LILAC : POND;
        g.fillRect(Math.round(x + Math.cos(a) * d), Math.round(y + Math.sin(a) * d * 0.5), 1, 1);
      }
    }
    this.sign("GALAXY", x, y + 28);
  }

  /** Puffy cartoon clouds: outlined union of discs with a flat base. */
  private cloud(x: number, y: number, w: number): void {
    const bumps: [number, number, number][] = [
      [-w * 0.3, 0, w * 0.22], [0, -w * 0.12, w * 0.3], [w * 0.3, 0, w * 0.2], [w * 0.1, w * 0.05, w * 0.22],
    ];
    const g = this.b;
    for (const [dx, dy, r] of bumps) this.disc(x + dx, y + dy, Math.round(r) + 1, K);
    g.fillStyle = K; g.fillRect(Math.round(x - w * 0.5), Math.round(y), Math.round(w) + 1, Math.round(w * 0.2) + 1);
    for (const [dx, dy, r] of bumps) this.disc(x + dx, y + dy, Math.round(r), WHITE);
    g.fillStyle = WHITE; g.fillRect(Math.round(x - w * 0.5) + 1, Math.round(y), Math.round(w) - 1, Math.round(w * 0.2));
    g.fillStyle = K;
    for (let i = 0; i < w * 0.8; i += 2) g.fillRect(Math.round(x - w * 0.4 + i), Math.round(y + w * 0.14), 1, 1);
  }

  private clouds(y: number): void {
    const r = mulberry32(3);
    for (let i = 0; i < 7; i++) {
      const cx = r() * this.W, cy = y + (r() - 0.5) * 70, w = 26 + r() * 30;
      if (Math.abs(cx - this.cx) < 42 + w * 0.55) continue;
      this.cloud(cx, cy, w);
    }
  }

  // ---- floating launch island ----
  private ellipse(cx: number, cy: number, rx: number, ry: number, fill: string): void {
    const g = this.b;
    g.fillStyle = fill;
    for (let dy = -ry; dy <= ry; dy++) {
      const w = Math.floor(rx * Math.sqrt(1 - (dy * dy) / (ry * ry)));
      g.fillRect(Math.round(cx - w), Math.round(cy + dy), w * 2 + 1, 1);
    }
  }

  private tree(x: number, y: number, r: number): void {
    const g = this.b;
    g.fillStyle = K; g.fillRect(x - 2, y - 8, 5, 10);
    g.fillStyle = SUN; g.fillRect(x - 1, y - 7, 3, 8);
    this.disc(x, y - 12 - r, r + 1, K);
    this.disc(x - r * 0.5, y - 10 - r * 0.6, r * 0.7 + 1, K);
    this.disc(x, y - 12 - r, r, MEADOW);
    this.disc(x - r * 0.5, y - 10 - r * 0.6, r * 0.7, MEADOW);
    this.shadeDisc(x, y - 12 - r, r, K, 0.22);
    g.fillStyle = K;
    g.fillRect(x - 3, y - 16 - r, 4, 1);
    g.fillRect(x - 3, y - 15 - r, 1, 2);
  }

  private drawIsland(s: SceneState): void {
    const g = this.b;
    const gy = Math.round(this.altY(1) + 45 + 1); // pad surface
    if (gy > this.H + 60) return;
    const cx = this.cx;
    const rx = Math.min(Math.round(this.W * 0.46), 175), ry = Math.round(rx * 0.26), band = 7;
    const cy = gy + 4;
    // Slab side (coral) with ink edges and tick marks.
    this.ellipse(cx, cy + band, rx + 1, ry + 1, K);
    this.ellipse(cx, cy + band, rx, ry, CORAL);
    g.fillStyle = CORAL;
    g.fillRect(cx - rx, cy, rx * 2 + 1, band);
    g.fillStyle = K;
    g.fillRect(cx - rx - 1, cy, 1, band); g.fillRect(cx + rx + 1, cy, 1, band);
    g.fillStyle = WHITE;
    for (let i = -rx + 8; i < rx - 4; i += 14) {
      const yy = cy + band + Math.round(ry * Math.sqrt(Math.max(0, 1 - (i * i) / (rx * rx))));
      g.fillRect(cx + i, yy - 3, 1, 2);
    }
    // Meadow top.
    this.ellipse(cx, cy, rx + 1, ry + 1, K);
    this.ellipse(cx, cy, rx, ry, MEADOW);
    // Grass ticks.
    const r = mulberry32(19);
    g.fillStyle = K;
    for (let i = 0; i < rx * 0.7; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.92;
      g.fillRect(Math.round(cx + Math.cos(a) * rx * d), Math.round(cy + Math.sin(a) * ry * d), 2, 1);
    }
    // Dotted sun path to mission control.
    for (let i = 0; i < 48; i++) {
      for (let k = -3; k <= 3; k++) {
        const px = cx + 22 + i, py = cy + 3 + Math.round(i * 0.08) + k;
        g.fillStyle = (px + py) % 3 === 0 ? K : SUN;
        g.fillRect(px, py, 1, 1);
      }
    }
    // Pond.
    this.ellipse(cx - rx * 0.62, cy + 4, 20, 5, K);
    this.ellipse(cx - rx * 0.62, cy + 4, 19, 4, POND);
    g.fillStyle = WHITE;
    g.fillRect(Math.round(cx - rx * 0.62 - 8), cy + 3, 5, 1);
    g.fillRect(Math.round(cx - rx * 0.62 + 3), cy + 5, 6, 1);
    // Trees and flowers.
    this.tree(Math.round(cx - rx * 0.78), cy - 2, 9);
    this.tree(Math.round(cx + rx * 0.8), cy - 3, 8);
    for (const fx of [-0.35, 0.28, 0.55]) {
      const x = Math.round(cx + rx * fx), y = cy + 6;
      g.fillStyle = K; g.fillRect(x, y - 4, 1, 4);
      g.fillStyle = CORAL; g.fillRect(x - 1, y - 6, 3, 2);
    }
    // Launch pad slab.
    g.fillStyle = K; g.fillRect(cx - 27, gy - 4, 55, 8);
    g.fillStyle = WHITE; g.fillRect(cx - 26, gy - 3, 53, 3);
    for (let x = cx - 26; x < cx + 27; x++) { g.fillStyle = x % 2 ? K : WHITE; g.fillRect(x, gy + 1, 1, 2); }
    g.fillStyle = SIGNAL;
    for (let i = -22; i < 24; i += 8) g.fillRect(cx + i, gy - 3, 4, 1);
    // Gantry tower.
    const tx = cx - 50;
    g.fillStyle = K;
    g.fillRect(tx, gy - 98, 2, 98);
    g.fillRect(tx + 10, gy - 98, 2, 98);
    for (let yy = gy - 98; yy < gy; yy += 8) {
      g.fillRect(tx, yy, 12, 1);
      for (let k = 0; k < 8; k++) g.fillRect(tx + Math.floor(k * 1.4), yy + k, 1, 1);
    }
    g.fillStyle = WHITE; g.fillRect(tx - 1, gy - 102, 14, 4);
    g.fillStyle = K; g.fillRect(tx - 1, gy - 102, 14, 1); g.fillRect(tx - 1, gy - 99, 14, 1);
    if (s.phase === "boarding") {
      g.fillStyle = K; g.fillRect(tx + 12, gy - 72, cx - tx - 22, 3);
      g.fillStyle = WHITE; g.fillRect(tx + 12, gy - 71, cx - tx - 22, 1);
      g.fillStyle = Math.sin(this.time * 5) > 0 ? CORAL : K;
      g.fillRect(tx + 4, gy - 106, 4, 3);
    }
    // Mission control stall with the watching Friend.
    const bx = cx + 58, by = gy + 2;
    g.fillStyle = K;
    g.fillRect(bx, by - 30, 1, 30); g.fillRect(bx + 30, by - 30, 1, 30);
    g.fillRect(bx - 3, by - 34, 37, 6);
    g.fillStyle = WHITE; g.fillRect(bx - 2, by - 33, 35, 4);
    g.fillStyle = K;
    for (let i = 0; i < 35; i += 6) g.fillRect(bx - 2 + i, by - 33, 3, 4);
    if (s.playerWatching && this.pilot.length) {
      g.drawImage(this.pilot[Math.floor(this.time * 4) % this.pilot.length], bx + 6, by - 26);
    }
    g.fillStyle = K; g.fillRect(bx - 1, by - 10, 33, 11);
    g.fillStyle = WHITE; g.fillRect(bx, by - 9, 31, 9);
    g.fillStyle = POND; g.fillRect(bx + 3, by - 7, 10, 4);
    g.fillStyle = SIGNAL; g.fillRect(bx + 17, by - 7, 3, 2);
    g.fillStyle = CORAL; g.fillRect(bx + 23, by - 7, 3, 2);
    this.sign("HQ", bx + 15, by - 46);
  }

  // ---- rocket ----
  private drawFlame(s: SceneState): void {
    const g = this.b;
    const cols = this.trail.flame;
    const cx = this.cx, by = this.rocketY;
    const flying = s.phase === "flying";
    const len = flying
      ? 12 + Math.min(26, Math.log(s.multiplier) * 10 + (s.phaseT < 1.6 ? 10 : 0)) + Math.floor(Math.random() * 5)
      : 3 + Math.floor(Math.random() * 2);
    const wAt = (i: number) => Math.max(1, Math.round((flying ? 7 : 3) * (1 - (i / len) * 0.85)));
    g.fillStyle = K;
    for (let i = 0; i <= len; i++) { const w = wAt(i) + 1; g.fillRect(cx - w, by + i, w * 2, 1); }
    for (let i = 0; i < len; i++) {
      const w = wAt(i);
      g.fillStyle = cols[2]; g.fillRect(cx - w, by + i, w * 2, 1);
      if (i < len * 0.75) { g.fillStyle = cols[1]; g.fillRect(cx - Math.max(1, w - 2), by + i, Math.max(2, (w - 2) * 2), 1); }
      if (i < len * 0.4) { g.fillStyle = cols[0]; g.fillRect(cx - Math.max(1, w - 4), by + i, Math.max(2, (w - 4) * 2), 1); }
    }
  }

  private drawRocket(s: SceneState): void {
    const g = this.rg, sk = this.skin;
    g.clearRect(0, 0, this.rk.width, this.rk.height);
    const cx = 40, by = 122; // local origin: nozzle base
    const jitter = s.phase === "flying" && !this.reduced && s.multiplier > 3 ? Math.round(Math.sin(this.time * 60) * 0.6) : 0;
    const dither = (x: number, y: number, w: number, h: number, color: string) => {
      g.fillStyle = color;
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if ((xx + yy) % 2 === 0) g.fillRect(xx, yy, 1, 1);
    };
    // Seat struts (behind the body).
    g.fillStyle = K;
    for (let lv = 0; lv < 4; lv++) {
      const y = by - 78 + lv * 15 + 16;
      g.fillRect(cx - 30, y, 60, 1);
    }
    // Fins.
    for (let i = 0; i < 17; i++) {
      const w = Math.floor(i * 0.6) + 1;
      g.fillStyle = K;
      g.fillRect(cx - 11 - w, by - 19 + i, w + 1, 1);
      g.fillRect(cx + 11, by - 19 + i, w + 1, 1);
      g.fillStyle = sk.trim;
      if (i > 0 && i < 16) { g.fillRect(cx - 10 - w + 1, by - 19 + i, w - 1, 1); g.fillRect(cx + 11, by - 19 + i, w - 1, 1); }
    }
    // Nozzle.
    g.fillStyle = K; g.fillRect(cx - 6, by - 6, 13, 6);
    dither(cx - 5, by - 5, 11, 4, WHITE);
    // Body.
    const top = by - 86, bot = by - 5;
    g.fillStyle = K; g.fillRect(cx - 11, top, 23, bot - top + 1);
    g.fillStyle = sk.body; g.fillRect(cx - 10, top, 21, bot - top);
    dither(cx + 5, top, 6, bot - top, sk.shade);
    g.fillStyle = K; g.fillRect(cx - 10, by - 33, 21, 1); g.fillRect(cx - 10, by - 28, 21, 1);
    g.fillStyle = sk.trim; g.fillRect(cx - 10, by - 32, 21, 4);
    g.fillStyle = K; g.fillRect(cx - 10, by - 23, 21, 1);
    // Rivets.
    g.fillStyle = K;
    for (let y = top + 34; y < by - 36; y += 6) g.fillRect(cx - 8, y, 1, 1);
    // Nose cone.
    for (let i = 0; i < 20; i++) {
      const w = Math.max(1, Math.round(11 * Math.sqrt(i / 20)));
      g.fillStyle = K; g.fillRect(cx - w - 1, top - 20 + i, w * 2 + 3, 1);
      g.fillStyle = sk.nose; g.fillRect(cx - w, top - 20 + i, w * 2 + 1, 1);
    }
    g.fillStyle = K; g.fillRect(cx - 11, top - 1, 23, 1);
    g.fillStyle = WHITE; g.fillRect(cx - 4, top - 13, 1, 8); g.fillRect(cx - 3, top - 6, 1, 2);
    // Cockpit dome.
    const cy = by - 62;
    const dome = (r: number, fill: string) => {
      g.fillStyle = fill;
      for (let dy = -r; dy <= r; dy++) {
        const w = Math.floor(Math.sqrt(r * r - dy * dy));
        g.fillRect(cx - w, cy + dy, w * 2 + 1, 1);
      }
    };
    dome(12, K);
    dome(11, s.playerAboard ? WHITE : sk.glass);
    if (s.playerAboard && this.pilot.length) {
      g.drawImage(this.pilot[Math.floor(this.time * 5) % this.pilot.length], cx - 9, cy - 9);
    } else {
      g.fillStyle = K;
      for (let dy = -10; dy <= 10; dy++) {
        for (let dx = -10; dx <= 10; dx++) if (dx * dx + dy * dy <= 100 && (dx + dy) % 2 === 0) g.fillRect(cx + dx, cy + dy, 1, 1);
      }
    }
    g.fillStyle = WHITE; g.fillRect(cx - 7, cy - 8, 3, 1); g.fillRect(cx - 8, cy - 7, 1, 3);

    // Sticker outline: white silhouette offset around the rocket.
    const sg = this.sg;
    sg.globalCompositeOperation = "source-over";
    sg.clearRect(0, 0, this.sil.width, this.sil.height);
    sg.drawImage(this.rk, 0, 0);
    sg.globalCompositeOperation = "source-in";
    sg.fillStyle = WHITE;
    sg.fillRect(0, 0, this.sil.width, this.sil.height);
    const ox = this.cx - cx, oy = this.rocketY - by + jitter;
    const b = this.b;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) b.drawImage(this.sil, ox + dx, oy + dy);
    b.drawImage(this.rk, ox, oy);
  }

  private drawCrew(s: SceneState): void {
    const g = this.b;
    const jitter = s.phase === "flying" && !this.reduced && s.multiplier > 3 ? Math.round(Math.sin(this.time * 60) * 0.6) : 0;
    for (const c of s.crew) {
      const p = this.seatPos(c.seat);
      const frames = this.sprites(`c${c.id}`, c.frames);
      const f = frames[Math.floor(this.time * 4 + c.id) % frames.length];
      let hop = 0;
      if (c.joinedT < 0.35) hop = -Math.round(Math.sin((c.joinedT / 0.35) * Math.PI) * 6);
      const y = p.y + jitter;
      // Seat platform in the Friend's family tint.
      g.fillStyle = WHITE; g.fillRect(p.x - 8, y + 15, 16, 4);
      g.fillStyle = K; g.fillRect(p.x - 7, y + 16, 14, 2);
      g.fillStyle = FAMILY_COLORS[c.familyId] ?? CORAL; g.fillRect(p.x - 6, y + 16, 12, 1);
      g.drawImage(f, p.x - 9, y - 1 + hop);
    }
  }

  private exhaust(s: SceneState, dt: number, power: number): void {
    const t = this.trail;
    const cx = this.cx, ny = this.rocketY + (power < 0.5 ? 3 : 16);
    if (power < 0.5) { this.puffs(cx, ny, 1, 0.6, 10); return; }
    const n = this.reduced ? 1 : Math.max(1, Math.round((2 + Math.min(6, s.multiplier)) * dt * 20));
    for (let i = 0; i < n; i++) {
      this.particles.push({
        x: cx + (Math.random() - 0.5) * 8, y: ny + Math.random() * 6,
        vx: (Math.random() - 0.5) * 16, vy: 30 + Math.random() * 40,
        life: 0, max: 0.6 + Math.random() * 0.7, size: 2 + Math.random() * 2, grow: 7,
        color: WHITE, shape: "puff", g: 0, top: false,
      });
      if (Math.random() < 0.6) {
        this.particles.push({
          x: cx + (Math.random() - 0.5) * 6, y: ny, vx: (Math.random() - 0.5) * 24, vy: 40 + Math.random() * 50,
          life: 0, max: 0.4 + Math.random() * 0.4, size: t.shape === "puff" ? 1 : 3, grow: 0,
          color: t.sparks[Math.floor(Math.random() * t.sparks.length)], shape: t.shape === "puff" ? "spark" : t.shape, g: 0, top: false,
        });
      }
    }
  }

  private stepParticles(dt: number, scrollV: number, top: boolean): void {
    const g = this.b;
    const keep: Particle[] = [];
    // Puff outlines first so overlapping smoke reads as one cloud.
    const puffs: Particle[] = [];
    for (const p of this.particles) {
      if (p.top !== top) { keep.push(p); continue; }
      p.life += dt;
      if (p.life >= p.max) continue;
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += (p.vy + scrollV * 0.5) * dt;
      p.vx *= Math.pow(0.4, dt);
      keep.push(p);
      if (p.shape === "puff") { puffs.push(p); continue; }
      const x = Math.round(p.x), y = Math.round(p.y);
      if (p.shape === "chunk") {
        g.fillStyle = K; g.fillRect(x - 1, y - 1, p.size + 2, p.size + 2);
        g.fillStyle = p.color; g.fillRect(x, y, p.size, p.size);
      } else if (p.shape === "heart") {
        g.fillStyle = K;
        g.fillRect(x - 2, y - 1, 5, 4); g.fillRect(x - 1, y + 3, 3, 1);
        g.fillStyle = p.color;
        g.fillRect(x - 1, y, 1, 1); g.fillRect(x + 1, y, 1, 1); g.fillRect(x - 1, y + 1, 3, 1); g.fillRect(x, y + 2, 1, 1);
      } else if (p.shape === "star") {
        g.fillStyle = p.color; g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3);
      } else {
        g.fillStyle = p.color; g.fillRect(x, y, p.size, p.size);
      }
    }
    const radius = (p: Particle) => Math.max(1, Math.round(p.size + p.grow * (p.life / p.max)));
    for (const p of puffs) this.disc(p.x, p.y, radius(p) + 1, K);
    for (const p of puffs) {
      const r = radius(p);
      this.disc(p.x, p.y, r, WHITE);
      if (r > 3 && p.life / p.max > 0.5) this.shadeDisc(p.x, p.y, r, K, 0.12);
    }
    this.particles = keep.length > 700 ? keep.slice(-700) : keep;
  }

  private drawBoom(dt: number): void {
    if (this.boom < 0) return;
    this.boom += dt;
    if (this.boom > 0.45) { this.boom = -1; return; }
    const g = this.b;
    const k = this.boom / 0.45;
    const R = 16 + k * 26;
    const spikes = 12;
    const star = (scale: number, color: string) => {
      g.fillStyle = color;
      for (let yy = -R * scale; yy <= R * scale; yy++) {
        for (let xx = -R * scale; xx <= R * scale; xx++) {
          const a = Math.atan2(yy, xx);
          const rr = R * scale * (0.72 + 0.28 * Math.abs(Math.cos((a * spikes) / 2)));
          if (xx * xx + yy * yy <= rr * rr) g.fillRect(Math.round(this.boomAt.x + xx), Math.round(this.boomAt.y + yy), 1, 1);
        }
      }
    };
    if (k < 0.8) {
      star(1.05, K);
      star(1, SUN);
      star(0.7, CORAL);
      star(0.38, WHITE);
      if (k < 0.5) this.sign("BOOM", this.boomAt.x, this.boomAt.y - 4, "center", WHITE, K);
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
        const w = c.big ? 15 : 12;
        g.fillStyle = K;
        g.fillRect(x - w + 2, y - 13, 1, 12); g.fillRect(x + w - 2, y - 13, 1, 12);
        g.fillRect(x - 5, y - 13, 1, 10); g.fillRect(x + 5, y - 13, 1, 10);
        for (let i = 0; i < 8; i++) {
          const ww = Math.round(w * Math.sqrt(1 - ((7 - i) / 8) ** 2));
          g.fillStyle = WHITE; g.fillRect(x - ww - 2, y - 22 + i, ww * 2 + 5, 1);
          g.fillStyle = K; g.fillRect(x - ww - 1, y - 22 + i, ww * 2 + 3, 1);
          for (let k = -ww; k <= ww; k++) {
            if (i === 0 && Math.abs(k) > ww - 1) continue;
            g.fillStyle = Math.floor((k + w) / 4) % 2 ? c.color : WHITE;
            g.fillRect(x + k, y - 22 + i, 1, 1);
          }
        }
        g.fillStyle = K; g.fillRect(x - w, y - 14, w * 2 + 1, 1);
      }
      g.drawImage(c.sprite, x - 9, y - 4);
      if (c.t < 2.4) this.sign(c.label, x, y - 33, "center", c.big ? SIGNAL : WHITE);
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
      if (!this.reduced && Math.random() < 0.5) {
        this.particles.push({ x: d.x, y: d.y, vx: 0, vy: -6, life: 0, max: 0.5, size: 1, grow: 4, color: WHITE, shape: "puff", g: 0, top: false });
        this.particles.push({ x: d.x + (Math.random() - 0.5) * 6, y: d.y, vx: 0, vy: -10, life: 0, max: 0.3, size: 2, grow: 0, color: Math.random() < 0.5 ? SUN : CORAL, shape: "spark", g: 0, top: true });
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
