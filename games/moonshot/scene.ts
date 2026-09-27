/**
 * Moonshot scene renderer: voxel / chunky-pixel-art midnight launch, Canvas 2D.
 *
 * The multiplier curve is drawn live as the rocket's blocky comet trail —
 * the chart IS the artwork. The pilot is the player's ACTUAL selected Friend:
 * its canonical on-chain 16x16 sprite, voxel-rendered (each pixel faked as a
 * 3D cube) and animated through its idle-up frames.
 *
 * All coordinates are CSS pixels; the canvas is scaled for devicePixelRatio
 * in resize(). Static art (rocket, pilot frames) is pre-rendered once to
 * offscreen canvases so the per-frame cost stays tiny.
 */
import type { PilotSprite } from "./pilot";

export type ScenePhase = "idle" | "countdown" | "flying" | "cashed" | "crashed";

export interface FrameState {
  phase: ScenePhase;
  countdown: number; // seconds remaining (countdown phase)
  flightT: number; // scaled seconds since liftoff
  multiplier: number; // current multiplier
  crashPoint: number; // this round's crash point
  resultT: number; // seconds since cash-out / crash
  cashedAt: number | null;
}

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; size: number;
  color: string; gravity: number;
  rot: number; vr: number; // spin for chunky debris / confetti
}

interface TrailPoint { x: number; y: number; m: number; }

interface Star { x: number; y: number; s: number; phase: number; speed: number; bright: boolean; }
interface Cloud { x: number; y: number; s: number; speed: number; }
interface Meteor { x: number; y: number; vx: number; vy: number; t: number; life: number; }
interface Ring { x: number; y: number; t: number; life: number; maxR: number; color: string; width: number; delay: number; }

/** Voxel palette per Friend family: Skeleton, Mask, Family, Cellular, Asymmetry, Hoverer, Colossus, Sparkling, Hollow. */
const FAMILY_PALETTE = [
  "#e8e4d8", "#b48cff", "#ffab5e", "#5effa8", "#38e1ff",
  "#6ab8ff", "#ff6a4d", "#ffd23f", "#9aa0c3",
];
const OUTLINE = "#0a0e24";

function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Risk palette: cyan -> gold -> molten red. */
function riskColor(m: number): string {
  if (m < 2) return "#38e1ff";
  if (m < 5) {
    const t = (m - 2) / 3;
    return mix("#38e1ff", "#ffd23f", t);
  }
  const t = Math.min(1, (m - 5) / 5);
  return mix("#ffd23f", "#ff4d2e", t);
}

function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function parseColor(c: string): [number, number, number] {
  if (c[0] === "#") {
    const h = c.slice(1);
    if (h.length === 3) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const m = c.match(/[\d.]+/g);
  if (m && m.length >= 3) return [+m[0], +m[1], +m[2]];
  return [255, 255, 255];
}

/** Multiply a color's brightness by f (clamped). Handles #rgb, #rrggbb, rgb(). */
function shade(c: string, f: number): string {
  const [r, g, b] = parseColor(c);
  const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${cl(r)},${cl(g)},${cl(b)})`;
}

/**
 * Fake a 3D cube for one pixel: base rect, lighter top + left strips,
 * darker bottom + right strips. Max 5 rects — static art is pre-rendered,
 * so per-frame cost stays tiny.
 */
function drawVoxelPixel(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, base: string): void {
  ctx.fillStyle = base;
  ctx.fillRect(x, y, s, s);
  const t = Math.max(1, Math.round(s * 0.28));
  ctx.fillStyle = shade(base, 1.4);
  ctx.fillRect(x, y, s, t);
  ctx.fillRect(x, y, t, s);
  ctx.fillStyle = shade(base, 0.5);
  ctx.fillRect(x, y + s - t, s, t);
  ctx.fillRect(x + s - t, y, t, s);
}

/** Chunky rocket, 17x24 blocks. D=outline W=white R=red G=gold C=cyan B=window E=engine. */
const ROCKET_MAP = [
  ".......DDD.......",
  "......DRRRD......",
  "......DRRRD......",
  ".....DRRRRRD.....",
  "....DRRRRRRRD....",
  "....DWWWWWWWD....",
  "....DWWWWWWWD....",
  "....DWWWWWWWD....",
  "....DWWCCCWWD....",
  "....DWWCBCWWD....",
  "....DWWCCCWWD....",
  "....DWWWWWWWD....",
  "....DWWWWWWWD....",
  "....DWGGGGGWD....",
  "...DRRWWWWWRRD...",
  "..DRRWWWWWWWRRD..",
  "..DRRRWWWWWRRRD..",
  ".DRRRRWWWWWRRRRD.",
  ".DRRRRWWWWWRRRRD.",
  ".DDRRRWWWWWRRRDD.",
  "...DDDEEEEEDDD...",
  "...DDDEEEEEDDD...",
  ".................",
  ".................",
];
const ROCKET_COLORS: Record<string, string> = {
  D: OUTLINE, W: "#eef1ff", R: "#e0455a", G: "#ffd23f",
  C: "#38e1ff", B: "#101736", E: "#3a4066",
};
const ROCKET_COLS = 17;
const ROCKET_ROWS = 24;

export class MoonshotScene {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private W = 0;
  private H = 0;
  private reducedMotion = false;
  private stars: Star[] = [];
  private clouds: Cloud[] = [];
  private city: { x: number; y: number; s: number; warm: boolean }[] = [];
  private particles: Particle[] = [];
  private trail: TrailPoint[] = [];
  private trauma = 0;
  private time = 0;
  private lastAlt = 0;
  private explosion: { x: number; y: number; t: number } | null = null;
  private eject: { x: number; y: number; vx: number; vy: number; landed: boolean } | null = null;
  private shockT = -1;
  private stars2: Star[] = [];
  private cloudsFar: Cloud[] = [];
  private meteors: Meteor[] = [];
  private rings: Ring[] = [];
  private meteorTimer = 2.5;
  // voxel art
  private pilot: PilotSprite | null = null;
  private pilotArt: HTMLCanvasElement[] | null = null;
  private rocketArt: HTMLCanvasElement | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D not supported");
    this.ctx = ctx;
    this.seed();
    this.buildRocketArt();
    this.resize();
  }

  setReducedMotion(b: boolean): void {
    this.reducedMotion = b;
    if (b) this.trauma = 0;
  }

  addTrauma(amount: number): void {
    if (!this.reducedMotion) this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Install the player's Friend pilot (canonical on-chain sprite frames). */
  setPilot(pilot: PilotSprite | null): void {
    this.pilot = pilot;
    this.pilotArt = pilot ? this.buildPilotArt(pilot) : null;
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.W = Math.max(1, rect.width);
    this.H = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private seed(): void {
    const rnd = mulberry32(20260927);
    this.stars = Array.from({ length: 120 }, (_, i) => ({
      x: rnd(), y: rnd() * 0.72, s: 2 + Math.floor(rnd() * 3),
      phase: rnd() * Math.PI * 2, speed: 0.6 + rnd() * 2.4,
      bright: i % 11 === 0,
    }));
    this.stars2 = Array.from({ length: 70 }, () => ({
      x: rnd(), y: rnd() * 0.8, s: 1 + Math.floor(rnd() * 2),
      phase: rnd() * Math.PI * 2, speed: 0.3 + rnd() * 1.1,
      bright: false,
    }));
    this.clouds = Array.from({ length: 5 }, () => ({
      x: rnd(), y: 0.08 + rnd() * 0.5, s: 0.5 + rnd() * 1.1, speed: 0.004 + rnd() * 0.01,
    }));
    this.cloudsFar = Array.from({ length: 6 }, () => ({
      x: rnd(), y: 0.05 + rnd() * 0.55, s: 0.3 + rnd() * 0.6, speed: 0.002 + rnd() * 0.005,
    }));
    this.city = Array.from({ length: 90 }, () => ({
      x: rnd(), y: 0.9 + rnd() * 0.09, s: 2 + Math.floor(rnd() * 3), warm: rnd() > 0.35,
    }));
  }

  /** Pre-render the chunky rocket once (voxel-shaded blocks). */
  private buildRocketArt(): void {
    const cell = 4;
    const c = document.createElement("canvas");
    c.width = ROCKET_COLS * cell;
    c.height = ROCKET_ROWS * cell;
    const g = c.getContext("2d");
    if (!g) return;
    for (let y = 0; y < ROCKET_ROWS; y++) {
      const row = ROCKET_MAP[y];
      for (let x = 0; x < ROCKET_COLS; x++) {
        const ch = row[x];
        if (ch === ".") continue;
        drawVoxelPixel(g, x * cell, y * cell, cell, ROCKET_COLORS[ch] ?? "#ffffff");
      }
    }
    this.rocketArt = c;
  }

  /** Pre-render the 8 pilot frames as voxel sprites with a chunky outline. */
  private buildPilotArt(pilot: PilotSprite): HTMLCanvasElement[] {
    const cell = 6;
    const pad = 1;
    const W = (16 + pad * 2) * cell;
    const H = (16 + pad * 2) * cell;
    const base = FAMILY_PALETTE[pilot.familyId] ?? "#38e1ff";
    return pilot.frames.map((rows) => {
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const g = c.getContext("2d");
      if (!g) return c;
      const on = (x: number, y: number) =>
        y >= 0 && y < 16 && x >= 0 && x < 16 && rows[y][x] === "#";
      // outline pass: dilated dark voxels under the sprite
      for (let y = -1; y <= 16; y++) {
        for (let x = -1; x <= 16; x++) {
          if (on(x, y)) continue;
          let near = false;
          for (let dy = -1; dy <= 1 && !near; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (on(x + dx, y + dy)) { near = true; break; }
            }
          }
          if (near) drawVoxelPixel(g, (x + pad) * cell, (y + pad) * cell, cell, OUTLINE);
        }
      }
      // main pass: the Friend's canonical pixels, voxel-shaded
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          if (on(x, y)) drawVoxelPixel(g, (x + pad) * cell, (y + pad) * cell, cell, base);
        }
      }
      return c;
    });
  }

  /** Altitude in px for a multiplier; the world scrolls by this. */
  private altitude(m: number): number {
    const t = Math.min(1, Math.log(Math.max(1, m)) / Math.log(40));
    return t * this.H * 0.9;
  }

  frame(state: FrameState, dt: number): void {
    this.time += dt;
    const { ctx, W, H } = this;
    const u = W / 480;
    const bk = 3 * u; // chunky block size

    // --- update ---
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const alt = state.phase === "flying" || state.phase === "cashed" || state.phase === "crashed"
      ? this.altitude(state.multiplier) : 0;
    const dAlt = alt - this.lastAlt;
    this.lastAlt = alt;

    // scroll trail + spawn new trail point while flying (blocky comet)
    for (const p of this.trail) p.y += dAlt;
    this.trail = this.trail.filter(p => p.y < H + 60);
    if (state.phase === "flying") {
      const r = this.rocketPos(state, alt);
      this.trail.push({ x: r.x, y: r.y + 12 * bk, m: state.multiplier });
      if (this.trail.length > 400) this.trail.shift();
      // exhaust embers (squares)
      if (!this.reducedMotion || Math.random() < 0.4) {
        this.spawn({
          x: r.x + (Math.random() - 0.5) * 10 * u, y: r.y + 12 * bk,
          vx: (Math.random() - 0.5) * 60 * u, vy: (120 + Math.random() * 120) * u,
          life: 0.5, maxLife: 0.5, size: (3 + Math.random() * 5) * u,
          color: Math.random() < 0.5 ? "#ffb02e" : "#ff7a2e", gravity: -40 * u,
          rot: 0, vr: 0,
        });
      }
    }
    if (state.phase === "crashed" && !this.explosion) {
      const r = this.rocketPos(state, alt);
      this.explosion = { x: r.x, y: r.y, t: 0 };
      this.addTrauma(1);
      // blocky fireball chunks
      const fireN = this.reducedMotion ? 16 : 72;
      for (let i = 0; i < fireN; i++) {
        const a = Math.random() * Math.PI * 2, sp = (60 + Math.random() * 380) * u;
        this.spawn({
          x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: 1.1, maxLife: 1.1, size: (5 + Math.random() * 11) * u,
          color: ["#ff4d2e", "#ffb02e", "#fff3c4", "#ff7a2e"][i % 4], gravity: 170 * u,
          rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 10,
        });
      }
      // dark wreckage chunks (heavy fall, spinning squares)
      const debrisN = this.reducedMotion ? 0 : 12;
      for (let i = 0; i < debrisN; i++) {
        const a = Math.random() * Math.PI * 2, sp = (50 + Math.random() * 200) * u;
        this.spawn({
          x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80 * u,
          life: 1.8, maxLife: 1.8, size: (5 + Math.random() * 7) * u,
          color: i % 2 ? "#2a2f4a" : "#5a6285", gravity: 720 * u,
          rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 12,
        });
      }
      // scattered RF coins — chunky gold squares
      const coinN = this.reducedMotion ? 10 : 34;
      for (let i = 0; i < coinN; i++) {
        const a = Math.random() * Math.PI * 2, sp = (80 + Math.random() * 300) * u;
        this.spawn({
          x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 140 * u,
          life: 1.9, maxLife: 1.9, size: (5 + Math.random() * 4) * u,
          color: ["#ffd23f", "#ffdf80", "#f5b800"][i % 3], gravity: 520 * u,
          rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 14,
        });
      }
      this.eject = { x: r.x, y: r.y - 10 * u, vx: (Math.random() - 0.5) * 60 * u, vy: -160 * u, landed: false };
    }
    if (this.explosion) this.explosion.t += dt;
    if (state.phase === "cashed" && this.shockT < 0) {
      this.shockT = 0;
      this.addTrauma(0.25);
      const r = this.rocketPos(state, alt);
      // thick coin fountain (squares)
      const coinN = this.reducedMotion ? 14 : 70;
      for (let i = 0; i < coinN; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4, sp = (140 + Math.random() * 360) * u;
        this.spawn({
          x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: 1.6, maxLife: 1.6, size: (4 + Math.random() * 7) * u,
          color: i % 3 === 0 ? "#fff3c4" : i % 3 === 1 ? "#ffd23f" : "#ffdf80", gravity: 430 * u,
          rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 12,
        });
      }
      // pixel confetti burst
      const confN = this.reducedMotion ? 0 : 30;
      const confettiColors = ["#38e1ff", "#ffd23f", "#ff6ad5", "#7dffb0", "#ffffff"];
      for (let i = 0; i < confN; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 3.0, sp = (120 + Math.random() * 300) * u;
        this.spawn({
          x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60 * u,
          life: 1.8, maxLife: 1.8, size: (5 + Math.random() * 6) * u,
          color: confettiColors[i % confettiColors.length], gravity: 260 * u,
          rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 16,
        });
      }
      // double shockwave SQUARES (second one delayed)
      if (!this.reducedMotion) {
        this.rings.push(
          { x: r.x, y: r.y, t: 0, life: 0.55, maxR: 130 * u, color: "#ffd23f", width: 10 * u, delay: 0 },
          { x: r.x, y: r.y, t: 0, life: 0.7, maxR: 190 * u, color: "#fff3c4", width: 5 * u, delay: 0.12 },
        );
      }
    }
    if (this.shockT >= 0) this.shockT += dt;
    // shockwave squares
    for (const ring of this.rings) ring.t += dt;
    this.rings = this.rings.filter(rg => rg.t - rg.delay < rg.life);
    // shooting stars (ambient; skipped in reduced motion)
    if (!this.reducedMotion) {
      this.meteorTimer -= dt;
      if (this.meteorTimer <= 0) {
        this.meteorTimer = 3.5 + Math.random() * 5.5;
        const mx = (0.15 + Math.random() * 0.7) * W;
        const my = (0.05 + Math.random() * 0.35) * H;
        const ang = Math.PI * (0.72 + Math.random() * 0.1); // streak down-left
        const sp = (420 + Math.random() * 260) * u;
        this.meteors.push({
          x: mx, y: my,
          vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
          t: 0, life: 0.7 + Math.random() * 0.4,
        });
      }
    }
    for (const mt of this.meteors) {
      mt.t += dt;
      mt.x += mt.vx * dt;
      mt.y += mt.vy * dt;
    }
    this.meteors = this.meteors.filter(mt => mt.t < mt.life);
    if (state.phase === "idle" || state.phase === "countdown") {
      this.explosion = null; this.eject = null; this.shockT = -1; this.trail = [];
      this.rings = [];
    }
    // ejectee physics
    if (this.eject && !this.eject.landed) {
      const e = this.eject;
      e.vy += 320 * u * dt; // parachute slows fall
      e.vy = Math.min(e.vy, 90 * u);
      e.x += (e.vx + Math.sin(this.time * 3) * 24 * u) * dt;
      e.y += e.vy * dt;
      if (e.y > H * 0.86) { e.y = H * 0.86; e.landed = true; }
    }
    // particles (all squares)
    for (const p of this.particles) {
      p.life -= dt;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
    this.particles = this.particles.filter(p => p.life > 0);
    for (const c of this.clouds) {
      c.x += c.speed * dt;
      if (c.x > 1.15) c.x = -0.15;
    }
    for (const c of this.cloudsFar) {
      c.x += c.speed * dt;
      if (c.x > 1.15) c.x = -0.15;
    }

    // --- render ---
    ctx.save();
    if (this.trauma > 0) {
      const s = this.trauma * this.trauma * 16 * u;
      ctx.translate((Math.random() - 0.5) * 2 * s, (Math.random() - 0.5) * 2 * s);
    }
    this.drawSky(state, alt, u);
    this.drawMeteors(u);
    this.drawTrail(u);
    if (state.phase === "crashed") this.drawCrashAftermath(state, u);
    else this.drawRocket(state, alt, u, bk);
    this.drawParticles();
    this.drawRings();
    if (this.eject) this.drawEjectee(u, bk);
    if (state.phase === "countdown") this.drawCountdown(state, u);
    if (!this.reducedMotion && this.explosion && this.explosion.t < 0.32) {
      // two-phase flash: hot white pop, then lingering orange wash
      const t = this.explosion.t;
      if (t < 0.12) {
        ctx.fillStyle = `rgba(255,246,220,${0.85 * (1 - t / 0.12)})`;
      } else {
        ctx.fillStyle = `rgba(255,140,60,${0.4 * (1 - (t - 0.12) / 0.2)})`;
      }
      ctx.fillRect(-20, -20, W + 40, H + 40);
    }
    ctx.restore();
  }

  private spawn(p: Particle): void {
    if (this.particles.length > 500) this.particles.shift();
    this.particles.push(p);
  }

  private rocketPos(state: FrameState, alt: number): { x: number; y: number } {
    const { W, H } = this;
    const u = W / 480;
    const flying = state.phase === "flying" || state.phase === "cashed";
    const baseX = W * 0.5, baseY = H * 0.8;
    if (!flying && state.phase !== "crashed") return { x: baseX, y: baseY };
    const drift = Math.min(1, alt / (H * 0.5));
    return { x: baseX + drift * W * 0.16, y: baseY - Math.min(alt, H * 0.34) };
  }

  private drawSky(state: FrameState, alt: number, u: number): void {
    const { ctx, W, H } = this;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#05081f");
    g.addColorStop(0.55, "#101647");
    g.addColorStop(0.85, "#2a1e5c");
    g.addColorStop(1, "#0a0a18");
    ctx.fillStyle = g;
    ctx.fillRect(-20, -20, W + 40, H + 40);

    // far stars: chunky dim squares, deeper parallax
    for (const s of this.stars2) {
      const y = (((s.y * H + alt * 0.12) % (H * 0.85)) + H * 0.85) % (H * 0.85);
      const tw = 0.25 + 0.3 * Math.sin(this.time * s.speed + s.phase);
      ctx.globalAlpha = Math.max(0, tw);
      ctx.fillStyle = "#9db8dd";
      ctx.fillRect(s.x * W, y, s.s * u, s.s * u);
    }
    ctx.globalAlpha = 1;

    // near stars: chunky squares with twinkle
    for (const s of this.stars) {
      const y = (((s.y * H + alt * 0.25) % (H * 0.8)) + H * 0.8) % (H * 0.8);
      const tw = 0.45 + 0.55 * Math.sin(this.time * s.speed + s.phase);
      ctx.globalAlpha = Math.max(0, tw);
      ctx.fillStyle = "#cfe8ff";
      const sz = s.s * u;
      ctx.fillRect(s.x * W, y, sz, sz);
      // plus-sparkle on the brightest stars at twinkle peak
      if (s.bright && tw > 0.88) {
        const fl = (tw - 0.88) / 0.12 * 9 * u;
        const a = (tw - 0.88) / 0.12 * 0.8;
        ctx.fillStyle = `rgba(220,240,255,${a})`;
        ctx.fillRect(s.x * W - fl, y + sz / 2 - u, fl * 2, 2 * u);
        ctx.fillRect(s.x * W + sz / 2 - u, y - fl, 2 * u, fl * 2);
      }
    }
    ctx.globalAlpha = 1;

    // pixel moon: soft halo, blocky disc, dithered square craters
    const mx = W * 0.82, my = H * 0.12 - alt * 0.15;
    const pulse = this.reducedMotion ? 1 : 0.85 + 0.15 * Math.sin(this.time * 1.3);
    const mg = ctx.createRadialGradient(mx, my, 4 * u, mx, my, 64 * u * pulse);
    mg.addColorStop(0, "rgba(255,246,214,0.9)");
    mg.addColorStop(0.35, "rgba(255,246,214,0.25)");
    mg.addColorStop(1, "rgba(255,246,214,0)");
    ctx.fillStyle = mg;
    ctx.fillRect(mx - 64 * u * pulse, my - 64 * u * pulse, 128 * u * pulse, 128 * u * pulse);
    ctx.strokeStyle = "rgba(255,246,214,0.12)";
    ctx.lineWidth = 2 * u;
    ctx.strokeRect(mx - 44 * u * pulse, my - 44 * u * pulse, 88 * u * pulse, 88 * u * pulse);
    // disc: stepped pixel circle
    const mr = 22 * u;
    ctx.fillStyle = "#fdf3cf";
    const step = Math.max(2, 3 * u);
    for (let yy = -mr; yy <= mr; yy += step) {
      const half = Math.sqrt(Math.max(0, mr * mr - yy * yy));
      ctx.fillRect(mx - half, my + yy, half * 2, step);
    }
    // dithered craters: checkerboard squares
    ctx.fillStyle = "rgba(214,192,140,0.85)";
    const crater = (cx: number, cy: number, r: number) => {
      const cs = Math.max(2, r / 2.5);
      for (let yy = -r; yy < r; yy += cs) {
        for (let xx = -r; xx < r; xx += cs) {
          if (xx * xx + yy * yy > r * r) continue;
          if (((xx / cs + yy / cs) & 1) === 0) ctx.fillRect(cx + xx, cy + yy, cs, cs);
        }
      }
    };
    crater(mx - 7 * u, my - 4 * u, 5 * u);
    crater(mx + 6 * u, my + 7 * u, 3.5 * u);
    crater(mx + 1 * u, my - 10 * u, 2.5 * u);

    // far blocky clouds (rect clusters)
    ctx.fillStyle = "rgba(90,110,190,0.10)";
    for (const c of this.cloudsFar) {
      const y = (((c.y * H + alt * 0.3) % (H + 200)) + H + 200) % (H + 200) - 100;
      this.blockyCloud(c.x * W, y, c.s * u * 0.7);
    }
    // near blocky clouds
    ctx.fillStyle = "rgba(120,140,220,0.16)";
    for (const c of this.clouds) {
      const y = (((c.y * H + alt * 0.5) % (H + 200)) + H + 200) % (H + 200) - 100;
      this.blockyCloud(c.x * W, y, c.s * u);
    }

    // launch tower: chunky rects (scrolls away on ascent)
    const towerBase = H * 0.88 + alt;
    if (towerBase < H + 200 * u) {
      const tx = W * 0.16, tw = 44 * u, th = H * 0.42;
      ctx.fillStyle = "#0d1230";
      ctx.fillRect(tx - tw / 2, towerBase - th, tw, th);
      ctx.fillStyle = "rgba(56,225,255,0.75)";
      ctx.fillRect(tx - tw / 2, towerBase - th, 2 * u, th);
      ctx.fillRect(tx + tw / 2 - 2 * u, towerBase - th, 2 * u, th);
      // cross braces as stepped rects
      ctx.fillStyle = "rgba(56,225,255,0.28)";
      for (let i = 0; i < 5; i++) {
        const y0 = towerBase - th + (i * th) / 5;
        const w = tw * (i % 2 === 0 ? 1 : 0.6);
        ctx.fillRect(tx - w / 2, y0, w, 2.5 * u);
      }
      // blinking square beacon
      const blink = Math.sin(this.time * 4) > 0;
      ctx.fillStyle = blink ? "#ff4d5e" : "rgba(255,77,94,0.25)";
      const bs = 6 * u;
      ctx.fillRect(tx - bs / 2, towerBase - th - 10 * u, bs, bs);
      // crane arm: thin beam from the tower toward the pad
      ctx.fillStyle = "#0d1230";
      ctx.fillRect(tx, towerBase - th * 0.8 - 2 * u, W * 0.42 - tx, 4 * u);
      ctx.fillStyle = "rgba(56,225,255,0.6)";
      ctx.fillRect(tx, towerBase - th * 0.8 - 2 * u, W * 0.42 - tx, 1.5 * u);
    }

    // ground + city lights (squares)
    const gy = H * 0.88 + alt;
    if (gy < H + 60) {
      ctx.fillStyle = "#070a16";
      ctx.fillRect(-20, gy, W + 40, H - gy + 40);
      for (const c of this.city) {
        const y = c.y * H + alt;
        if (y > H + 10) continue;
        ctx.fillStyle = c.warm ? "rgba(255,190,90,0.85)" : "rgba(140,200,255,0.7)";
        ctx.fillRect(c.x * W, y, c.s * u, c.s * u);
      }
      // pad: chunky rects
      ctx.fillStyle = "#141a3d";
      const px = W * 0.5;
      ctx.fillRect(px - 64 * u, gy, 128 * u, 12 * u);
      ctx.fillStyle = "rgba(56,225,255,0.5)";
      ctx.fillRect(px - 64 * u, gy, 128 * u, 2 * u);
      ctx.fillRect(px - 64 * u, gy + 10 * u, 128 * u, 2 * u);
    }
  }

  /** A blocky cloud = a cluster of rects. Assumes fillStyle already set. */
  private blockyCloud(x: number, y: number, s: number): void {
    const { ctx } = this;
    ctx.fillRect(x - 52 * s, y - 10 * s, 104 * s, 22 * s);
    ctx.fillRect(x - 30 * s, y - 20 * s, 66 * s, 14 * s);
    ctx.fillRect(x + 18 * s, y - 4 * s, 44 * s, 14 * s);
    ctx.fillRect(x - 62 * s, y - 2 * s, 24 * s, 10 * s);
  }

  /** Ambient shooting stars: square head with fading square tail. */
  private drawMeteors(u: number): void {
    const { ctx } = this;
    for (const mt of this.meteors) {
      const k = 1 - mt.t / mt.life;
      const steps = 4;
      for (let i = 0; i < steps; i++) {
        const f = i / steps;
        const px = mt.x - mt.vx * 0.09 * f;
        const py = mt.y - mt.vy * 0.09 * f;
        const sz = (4 - i * 0.8) * u * k + 0.6;
        ctx.fillStyle = i === 0
          ? `rgba(255,255,255,${0.95 * k})`
          : `rgba(160,200,255,${0.5 * k * (1 - f)})`;
        ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
      }
    }
  }

  /** Expanding shockwave SQUARES for the cash-out punch. */
  private drawRings(): void {
    const { ctx } = this;
    ctx.save();
    for (const rg of this.rings) {
      const age = rg.t - rg.delay;
      if (age < 0) continue;
      const k = age / rg.life;
      const ease = 1 - Math.pow(1 - k, 3);
      const half = Math.max(1, rg.maxR * ease);
      ctx.globalAlpha = Math.max(0, 0.9 * (1 - k));
      ctx.strokeStyle = rg.color;
      ctx.lineWidth = rg.width * (1 - k * 0.6);
      ctx.strokeRect(rg.x - half, rg.y - half, half * 2, half * 2);
    }
    ctx.restore();
  }

  /** The multiplier curve as a blocky comet: chunky squares, risk-colored. */
  private drawTrail(u: number): void {
    const { ctx } = this;
    const n = this.trail.length;
    if (n < 2) return;
    ctx.save();
    for (let i = 1; i < n; i++) {
      const p = this.trail[i];
      const f = i / n;
      const sz = (2 + 7 * f) * u;
      ctx.globalAlpha = Math.min(1, i / 24 + 0.15);
      ctx.fillStyle = riskColor(p.m);
      ctx.fillRect(p.x - sz / 2, p.y - sz / 2, sz, sz);
      // hot core on the newest squares
      if (f > 0.85) {
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        const cs = sz * 0.4;
        ctx.fillRect(p.x - cs / 2, p.y - cs / 2, cs, cs);
      }
    }
    ctx.restore();
  }

  /** Draw the chunky rocket with the Friend pilot riding on top. */
  private drawRocket(state: FrameState, alt: number, u: number, bk: number): void {
    const { ctx } = this;
    const r = this.rocketPos(state, alt);
    const bob = state.phase === "flying"
      ? Math.round(Math.sin(this.time * 30) * 1.2) * u
      : Math.round(Math.sin(this.time * 2) * 1.5) * u;
    const tilt = state.phase === "flying" ? Math.sin(this.time * 1.7) * 0.05 : 0;
    ctx.save();
    ctx.translate(r.x, r.y + bob);
    ctx.rotate(tilt);

    // blocky exhaust flame while flying (quantized flicker)
    if (state.phase === "flying") {
      const segs: Array<[number, string]> = [
        [5, "#fff3c4"], [4, "#ffd23f"], [3, "#ff9a2e"], [2, "#ff5a2e"],
      ];
      let yy = 10 * bk;
      for (const [w, col] of segs) {
        const h = (2 + Math.floor(Math.random() * 3)) * bk * 0.9;
        const ww = (w + (Math.random() < 0.5 ? 1 : 0)) * bk;
        ctx.fillStyle = col;
        ctx.fillRect(-ww / 2, yy, ww, h);
        yy += h;
      }
    }

    // rocket body (pre-rendered voxel art)
    if (this.rocketArt) {
      ctx.imageSmoothingEnabled = false;
      const w = ROCKET_COLS * bk;
      const h = ROCKET_ROWS * bk;
      ctx.drawImage(this.rocketArt, -w / 2, -h / 2, w, h);
    }

    // the Friend pilot rides on top of the nose
    const pilotW = 16 * bk;
    const pilotH = pilotW; // square-ish (18 cells incl. outline padding)
    const pilotY = -12 * bk - pilotH / 2 + 1.5 * bk;
    const thrilled = state.phase === "flying" && state.multiplier >= 5 && !this.reducedMotion;
    const hop = thrilled ? Math.abs(Math.sin(this.time * 9)) * 2.5 * bk * 0.4 : 0;
    this.drawPilotSprite(0, pilotY - hop, pilotW, false);
    ctx.restore();
  }

  /**
   * Draw the player's Friend pilot sprite (voxel pre-render, animated frames).
   * dazed = crash aftermath: tilted with X eyes.
   */
  private drawPilotSprite(x: number, y: number, size: number, dazed: boolean): void {
    const { ctx } = this;
    const art = this.pilotArt;
    if (!art || art.length === 0) return;
    const frame = this.reducedMotion ? 0 : Math.floor(this.time * 6) % art.length;
    const c = art[frame];
    ctx.save();
    ctx.translate(x, y);
    if (dazed) ctx.rotate(0.16 * Math.sin(this.time * 2.2));
    ctx.imageSmoothingEnabled = false;
    const h = size * (c.height / c.width);
    ctx.drawImage(c, -size / 2, -h / 2, size, h);
    if (dazed) {
      // X eyes over the face
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = Math.max(2, size * 0.04);
      ctx.lineCap = "round";
      const ex = size * 0.17, ey = -size * 0.1, er = size * 0.075;
      for (const s of [-1, 1]) {
        const cx = s * ex;
        ctx.beginPath();
        ctx.moveTo(cx - er, ey - er); ctx.lineTo(cx + er, ey + er);
        ctx.moveTo(cx + er, ey - er); ctx.lineTo(cx - er, ey + er);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawCrashAftermath(state: FrameState, u: number): void {
    const { ctx } = this;
    const e = this.explosion;
    if (e && e.t < 0.5) {
      // blocky expanding shock squares
      const t = e.t / 0.5;
      for (let i = 0; i < 3; i++) {
        const half = (14 + t * (60 + i * 30)) * u;
        ctx.globalAlpha = Math.max(0, 0.8 * (1 - t));
        ctx.strokeStyle = ["#fff3c4", "#ffb02e", "#ff6a4d"][i];
        ctx.lineWidth = (6 - i * 1.5) * u;
        ctx.strokeRect(e.x - half, e.y - half, half * 2, half * 2);
      }
      ctx.globalAlpha = 1;
    }
    // tumbling wreckage: chunky rect clusters
    if (e && e.t < 2.2) {
      const t = e.t;
      ctx.save();
      ctx.translate(e.x - 14 * u + t * 30 * u, e.y + t * t * 160 * u);
      ctx.rotate(t * 2.4);
      ctx.fillStyle = "#5a6285";
      ctx.fillRect(-14 * u, -10 * u, 20 * u, 34 * u);
      ctx.fillStyle = "#2a2f4a";
      ctx.fillRect(-14 * u, 14 * u, 20 * u, 10 * u);
      ctx.restore();
      ctx.save();
      ctx.translate(e.x + 16 * u - t * 44 * u, e.y - 20 * u + t * t * 190 * u);
      ctx.rotate(-t * 3.1);
      ctx.fillStyle = "#e0455a";
      ctx.fillRect(-10 * u, -8 * u, 20 * u, 16 * u);
      ctx.fillStyle = "#a92f42";
      ctx.fillRect(-10 * u, 0, 20 * u, 8 * u);
      ctx.restore();
    }
    // lingering smoke: chunky alpha squares
    if (e && e.t < 1.4 && !this.reducedMotion) {
      for (let i = 0; i < 3; i++) {
        const t = e.t;
        ctx.fillStyle = `rgba(90,95,130,${0.35 * (1 - t / 1.4)})`;
        const s = (14 + t * 26) * u;
        ctx.fillRect(
          e.x + Math.sin(i * 2.1 + t * 3) * 20 * u - s / 2,
          e.y - t * 60 * u - i * 18 * u - s / 2, s, s,
        );
      }
    }
    void state;
  }

  private drawEjectee(u: number, bk: number): void {
    const { ctx } = this;
    const e = this.eject;
    if (!e) return;
    ctx.save();
    if (!e.landed) {
      // blocky parachute canopy
      const sway = Math.sin(this.time * 3) * 0.12;
      ctx.translate(e.x, e.y);
      ctx.rotate(sway);
      const cw = 56 * u;
      ctx.fillStyle = "#ffd23f";
      ctx.fillRect(-cw / 2, -52 * u, cw, 12 * u);
      ctx.fillRect(-cw / 2 + 8 * u, -64 * u, cw - 16 * u, 12 * u);
      ctx.fillStyle = "#e0455a";
      ctx.fillRect(-10 * u, -64 * u, 20 * u, 24 * u);
      ctx.fillStyle = "rgba(40,40,70,0.8)";
      for (const s of [-1, -0.4, 0.4, 1]) {
        ctx.fillRect(s * 22 * u - u, -52 * u, 2 * u, 44 * u);
      }
      this.drawPilotSprite(0, 0, 15 * bk, true);
    } else {
      // landed, dazed: the Friend with X eyes + circling square sparkles
      this.drawPilotSprite(e.x, e.y, 15 * bk, true);
      ctx.fillStyle = "#ffd23f";
      for (let i = 0; i < 3; i++) {
        const a = this.time * 2.4 + (i * Math.PI * 2) / 3;
        const sx = e.x + Math.cos(a) * 24 * u;
        const sy = e.y - 30 * u + Math.sin(a) * 6 * u;
        const s = 5 * u;
        ctx.fillRect(sx - s / 2, sy - s / 2, s, s);
      }
      // settled dust: flat squares
      ctx.fillStyle = "rgba(120,125,160,0.3)";
      ctx.fillRect(e.x - 26 * u, e.y + 12 * u, 52 * u, 6 * u);
    }
    ctx.restore();
  }

  /** All particles are chunky spinning squares. */
  private drawParticles(): void {
    const { ctx } = this;
    for (const p of this.particles) {
      const t = p.life / p.maxLife;
      ctx.globalAlpha = Math.max(0, t);
      ctx.fillStyle = p.color;
      const s = Math.max(1, p.size * (0.4 + 0.6 * t));
      if (p.vr !== 0) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-s / 2, -s / 2, s, s);
        ctx.restore();
      } else {
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawCountdown(state: FrameState, u: number): void {
    const { ctx, W, H } = this;
    const n = Math.ceil(state.countdown);
    if (n < 1 || n > 3) return;
    const frac = state.countdown - Math.floor(state.countdown);
    const scale = 1 + (1 - frac) * 0.35;
    ctx.save();
    ctx.translate(W / 2, H * 0.34);
    ctx.scale(scale, scale);
    ctx.globalAlpha = 0.35 + 0.65 * frac;
    ctx.font = `${84 * u}px "Press Start 2P", "Courier New", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#eaf6ff";
    // hard pixel shadow (no blur)
    ctx.fillStyle = "#0a0e24";
    ctx.fillText(String(n), 4 * u, 4 * u);
    ctx.fillStyle = "#eaf6ff";
    ctx.fillText(String(n), 0, 0);
    ctx.restore();
    // "GET READY" label in pixel font
    ctx.save();
    ctx.font = `${20 * u}px "Press Start 2P", "Courier New", monospace`;
    ctx.textAlign = "center";
    ctx.fillStyle = "#0a0e24";
    ctx.fillText("GET READY", W / 2 + 2 * u, H * 0.34 + 72 * u + 2 * u);
    ctx.fillStyle = "rgba(234,246,255,0.9)";
    ctx.fillText("GET READY", W / 2, H * 0.34 + 72 * u);
    ctx.restore();
  }
}
