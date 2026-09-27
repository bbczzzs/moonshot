/**
 * Moonshot scene renderer: neon midnight launch, drawn entirely in Canvas 2D.
 *
 * The multiplier curve is drawn live as the rocket's burning comet trail —
 * the chart IS the artwork. All coordinates are CSS pixels; the canvas is
 * scaled for devicePixelRatio in resize().
 */
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
  shape?: "circle" | "rect";
  rot?: number; vr?: number;
}

interface TrailPoint { x: number; y: number; m: number; }

interface Star { x: number; y: number; r: number; phase: number; speed: number; bright: boolean; }
interface Cloud { x: number; y: number; s: number; speed: number; }
interface Meteor { x: number; y: number; vx: number; vy: number; t: number; life: number; }
interface Ring { x: number; y: number; t: number; life: number; maxR: number; color: string; width: number; delay: number; }

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

export class MoonshotScene {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private W = 0;
  private H = 0;
  private reducedMotion = false;
  private stars: Star[] = [];
  private clouds: Cloud[] = [];
  private city: { x: number; y: number; r: number; warm: boolean }[] = [];
  private particles: Particle[] = [];
  private trail: TrailPoint[] = [];
  private trauma = 0;
  private time = 0;
  private lastAlt = 0;
  private blinkT = 0;
  private explosion: { x: number; y: number; t: number } | null = null;
  private eject: { x: number; y: number; vx: number; vy: number; landed: boolean } | null = null;
  private shockT = -1;
  private stars2: Star[] = [];
  private cloudsFar: Cloud[] = [];
  private meteors: Meteor[] = [];
  private rings: Ring[] = [];
  private meteorTimer = 2.5;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D not supported");
    this.ctx = ctx;
    this.seed();
    this.resize();
  }

  setReducedMotion(b: boolean): void {
    this.reducedMotion = b;
    if (b) this.trauma = 0;
  }

  addTrauma(amount: number): void {
    if (!this.reducedMotion) this.trauma = Math.min(1, this.trauma + amount);
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
    this.stars = Array.from({ length: 130 }, (_, i) => ({
      x: rnd(), y: rnd() * 0.72, r: 0.6 + rnd() * 1.6,
      phase: rnd() * Math.PI * 2, speed: 0.6 + rnd() * 2.4,
      bright: i % 11 === 0,
    }));
    // far star layer: dimmer, slower, deeper parallax
    this.stars2 = Array.from({ length: 70 }, () => ({
      x: rnd(), y: rnd() * 0.8, r: 0.4 + rnd() * 0.9,
      phase: rnd() * Math.PI * 2, speed: 0.3 + rnd() * 1.1,
      bright: false,
    }));
    this.clouds = Array.from({ length: 5 }, () => ({
      x: rnd(), y: 0.08 + rnd() * 0.5, s: 0.5 + rnd() * 1.1, speed: 0.004 + rnd() * 0.01,
    }));
    // far cloud layer: smaller, dimmer, slower drift
    this.cloudsFar = Array.from({ length: 6 }, () => ({
      x: rnd(), y: 0.05 + rnd() * 0.55, s: 0.3 + rnd() * 0.6, speed: 0.002 + rnd() * 0.005,
    }));
    this.city = Array.from({ length: 90 }, () => ({
      x: rnd(), y: 0.9 + rnd() * 0.09, r: 0.8 + rnd() * 2.2, warm: rnd() > 0.35,
    }));
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

    // --- update ---
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    this.blinkT += dt;
    const alt = state.phase === "flying" || state.phase === "cashed" || state.phase === "crashed"
      ? this.altitude(state.multiplier) : 0;
    const dAlt = alt - this.lastAlt;
    this.lastAlt = alt;

    // scroll trail + spawn new trail point while flying
    for (const p of this.trail) p.y += dAlt;
    this.trail = this.trail.filter(p => p.y < H + 60);
    if (state.phase === "flying") {
      const r = this.rocketPos(state, alt);
      this.trail.push({ x: r.x, y: r.y - 34 * u, m: state.multiplier });
      if (this.trail.length > 400) this.trail.shift();
      // exhaust embers
      if (!this.reducedMotion || Math.random() < 0.4) {
        this.spawn({
          x: r.x + (Math.random() - 0.5) * 10 * u, y: r.y + 30 * u,
          vx: (Math.random() - 0.5) * 60 * u, vy: (120 + Math.random() * 120) * u,
          life: 0.5, maxLife: 0.5, size: (3 + Math.random() * 5) * u,
          color: Math.random() < 0.5 ? "#ffb02e" : "#ff7a2e", gravity: -40 * u,
        });
      }
    }
    if (state.phase === "crashed" && !this.explosion) {
      const r = this.rocketPos(state, alt);
      this.explosion = { x: r.x, y: r.y, t: 0 };
      this.addTrauma(1);
      // fireball: bigger, denser
      const fireN = this.reducedMotion ? 16 : 72;
      for (let i = 0; i < fireN; i++) {
        const a = Math.random() * Math.PI * 2, sp = (60 + Math.random() * 380) * u;
        this.spawn({
          x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: 1.1, maxLife: 1.1, size: (5 + Math.random() * 11) * u,
          color: ["#ff4d2e", "#ffb02e", "#fff3c4", "#ff7a2e"][i % 4], gravity: 170 * u,
        });
      }
      // dark debris chunks (rects, heavy fall)
      const debrisN = this.reducedMotion ? 0 : 12;
      for (let i = 0; i < debrisN; i++) {
        const a = Math.random() * Math.PI * 2, sp = (50 + Math.random() * 200) * u;
        this.spawn({
          x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80 * u,
          life: 1.8, maxLife: 1.8, size: (5 + Math.random() * 7) * u,
          color: i % 2 ? "#2a2f4a" : "#5a6285", gravity: 720 * u,
          shape: "rect", rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 12,
        });
      }
      // scattered RF coins — more of them, varied golds
      const coinN = this.reducedMotion ? 10 : 34;
      for (let i = 0; i < coinN; i++) {
        const a = Math.random() * Math.PI * 2, sp = (80 + Math.random() * 300) * u;
        this.spawn({
          x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 140 * u,
          life: 1.9, maxLife: 1.9, size: (5 + Math.random() * 4) * u,
          color: ["#ffd23f", "#ffdf80", "#f5b800"][i % 3], gravity: 520 * u,
        });
      }
      this.eject = { x: r.x, y: r.y - 10 * u, vx: (Math.random() - 0.5) * 60 * u, vy: -160 * u, landed: false };
    }
    if (this.explosion) this.explosion.t += dt;
    if (state.phase === "cashed" && this.shockT < 0) {
      this.shockT = 0;
      this.addTrauma(0.25);
      const r = this.rocketPos(state, alt);
      // thick coin fountain
      const coinN = this.reducedMotion ? 14 : 70;
      for (let i = 0; i < coinN; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4, sp = (140 + Math.random() * 360) * u;
        this.spawn({
          x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: 1.6, maxLife: 1.6, size: (4 + Math.random() * 7) * u,
          color: i % 3 === 0 ? "#fff3c4" : i % 3 === 1 ? "#ffd23f" : "#ffdf80", gravity: 430 * u,
        });
      }
      // confetti burst
      const confN = this.reducedMotion ? 0 : 30;
      const confettiColors = ["#38e1ff", "#ffd23f", "#ff6ad5", "#7dffb0", "#ffffff"];
      for (let i = 0; i < confN; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 3.0, sp = (120 + Math.random() * 300) * u;
        this.spawn({
          x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60 * u,
          life: 1.8, maxLife: 1.8, size: (5 + Math.random() * 6) * u,
          color: confettiColors[i % confettiColors.length], gravity: 260 * u,
          shape: "rect", rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 16,
        });
      }
      // double shockwave ring (second one delayed)
      if (!this.reducedMotion) {
        this.rings.push(
          { x: r.x, y: r.y, t: 0, life: 0.55, maxR: 130 * u, color: "#ffd23f", width: 10 * u, delay: 0 },
          { x: r.x, y: r.y, t: 0, life: 0.7, maxR: 190 * u, color: "#fff3c4", width: 5 * u, delay: 0.12 },
        );
      }
    }
    if (this.shockT >= 0) this.shockT += dt;
    // shockwave rings
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
    // particles
    for (const p of this.particles) {
      p.life -= dt;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.shape === "rect" && p.vr !== undefined) p.rot = (p.rot ?? 0) + p.vr * dt;
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
    else this.drawRocket(state, alt, u);
    this.drawParticles(u);
    this.drawRings(u);
    if (this.eject) this.drawEjectee(u);
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

    // far stars: dimmer, slower, deeper parallax
    for (const s of this.stars2) {
      const y = (((s.y * H + alt * 0.12) % (H * 0.85)) + H * 0.85) % (H * 0.85);
      const tw = 0.25 + 0.3 * Math.sin(this.time * s.speed + s.phase);
      ctx.globalAlpha = tw;
      ctx.fillStyle = "#9db8dd";
      ctx.beginPath();
      ctx.arc(s.x * W, y, s.r * u, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // stars with parallax
    for (const s of this.stars) {
      const y = (((s.y * H + alt * 0.25) % (H * 0.8)) + H * 0.8) % (H * 0.8);
      const tw = 0.45 + 0.55 * Math.sin(this.time * s.speed + s.phase);
      ctx.globalAlpha = tw;
      ctx.fillStyle = "#cfe8ff";
      ctx.beginPath();
      ctx.arc(s.x * W, y, s.r * u, 0, Math.PI * 2);
      ctx.fill();
      // sparkle cross on the brightest stars at twinkle peak
      if (s.bright && tw > 0.88) {
        const fl = (tw - 0.88) / 0.12 * 9 * u;
        ctx.strokeStyle = `rgba(220,240,255,${(tw - 0.88) / 0.12 * 0.8})`;
        ctx.lineWidth = 1.2 * u;
        ctx.beginPath();
        ctx.moveTo(s.x * W - fl, y); ctx.lineTo(s.x * W + fl, y);
        ctx.moveTo(s.x * W, y - fl); ctx.lineTo(s.x * W, y + fl);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // moon with breathing glow
    const mx = W * 0.82, my = H * 0.12 - alt * 0.15;
    const pulse = this.reducedMotion ? 1 : 0.85 + 0.15 * Math.sin(this.time * 1.3);
    const mg = ctx.createRadialGradient(mx, my, 4 * u, mx, my, 64 * u * pulse);
    mg.addColorStop(0, "rgba(255,246,214,0.9)");
    mg.addColorStop(0.35, "rgba(255,246,214,0.25)");
    mg.addColorStop(1, "rgba(255,246,214,0)");
    ctx.fillStyle = mg;
    ctx.beginPath(); ctx.arc(mx, my, 64 * u * pulse, 0, Math.PI * 2); ctx.fill();
    // faint outer halo ring
    ctx.strokeStyle = "rgba(255,246,214,0.12)";
    ctx.lineWidth = 2 * u;
    ctx.beginPath(); ctx.arc(mx, my, 44 * u * pulse, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#fdf3cf";
    ctx.beginPath(); ctx.arc(mx, my, 22 * u, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(220,200,150,0.5)";
    ctx.beginPath(); ctx.arc(mx - 7 * u, my - 4 * u, 5 * u, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(mx + 6 * u, my + 7 * u, 3.5 * u, 0, Math.PI * 2); ctx.fill();

    // far cloud layer (dimmer, smaller)
    ctx.fillStyle = "rgba(90,110,190,0.10)";
    for (const c of this.cloudsFar) {
      const y = (((c.y * H + alt * 0.3) % (H + 200)) + H + 200) % (H + 200) - 100;
      ctx.beginPath();
      ctx.ellipse(c.x * W, y, 52 * c.s * u, 14 * c.s * u, 0, 0, Math.PI * 2);
      ctx.ellipse(c.x * W + 30 * c.s * u, y + 6 * u, 34 * c.s * u, 10 * c.s * u, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // clouds
    ctx.fillStyle = "rgba(120,140,220,0.16)";
    for (const c of this.clouds) {
      const y = (((c.y * H + alt * 0.5) % (H + 200)) + H + 200) % (H + 200) - 100;
      ctx.beginPath();
      ctx.ellipse(c.x * W, y, 70 * c.s * u, 20 * c.s * u, 0, 0, Math.PI * 2);
      ctx.ellipse(c.x * W + 40 * c.s * u, y + 8 * u, 46 * c.s * u, 15 * c.s * u, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // launch tower (scrolls away on ascent)
    const towerBase = H * 0.88 + alt;
    if (towerBase < H + 200 * u) {
      const tx = W * 0.16, tw = 44 * u, th = H * 0.42;
      ctx.fillStyle = "#0d1230";
      ctx.fillRect(tx - tw / 2, towerBase - th, tw, th);
      ctx.strokeStyle = "rgba(56,225,255,0.75)";
      ctx.lineWidth = 2 * u;
      ctx.beginPath();
      ctx.moveTo(tx - tw / 2, towerBase - th); ctx.lineTo(tx - tw / 2, towerBase);
      ctx.moveTo(tx + tw / 2, towerBase - th); ctx.lineTo(tx + tw / 2, towerBase);
      ctx.stroke();
      // cross braces
      ctx.strokeStyle = "rgba(56,225,255,0.28)";
      ctx.lineWidth = 1.5 * u;
      for (let i = 0; i < 5; i++) {
        const y0 = towerBase - th + (i * th) / 5;
        ctx.beginPath();
        ctx.moveTo(tx - tw / 2, y0); ctx.lineTo(tx + tw / 2, y0 + th / 5);
        ctx.stroke();
      }
      // beacon
      const blink = Math.sin(this.time * 4) > 0;
      ctx.fillStyle = blink ? "#ff4d5e" : "rgba(255,77,94,0.25)";
      ctx.beginPath(); ctx.arc(tx, towerBase - th - 8 * u, 5 * u, 0, Math.PI * 2); ctx.fill();
      // crane arm
      ctx.strokeStyle = "#0d1230";
      ctx.lineWidth = 8 * u;
      ctx.beginPath(); ctx.moveTo(tx, towerBase - th * 0.8); ctx.lineTo(W * 0.42, towerBase - th * 0.8); ctx.stroke();
    }

    // ground + city lights
    const gy = H * 0.88 + alt;
    if (gy < H + 60) {
      ctx.fillStyle = "#070a16";
      ctx.fillRect(-20, gy, W + 40, H - gy + 40);
      for (const c of this.city) {
        const y = c.y * H + alt;
        if (y > H + 10) continue;
        ctx.fillStyle = c.warm ? "rgba(255,190,90,0.85)" : "rgba(140,200,255,0.7)";
        ctx.beginPath(); ctx.arc(c.x * W, y, c.r * u, 0, Math.PI * 2); ctx.fill();
      }
      // pad
      ctx.fillStyle = "#141a3d";
      const px = W * 0.5;
      ctx.beginPath();
      ctx.ellipse(px, gy + 6 * u, 64 * u, 14 * u, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(56,225,255,0.5)";
      ctx.lineWidth = 2 * u;
      ctx.beginPath();
      ctx.ellipse(px, gy + 6 * u, 64 * u, 14 * u, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** Ambient shooting stars: bright head with a fading gradient tail. */
  private drawMeteors(u: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.lineCap = "round";
    for (const mt of this.meteors) {
      const k = 1 - mt.t / mt.life;
      const tail = 0.9;
      const tx = mt.x - mt.vx * tail * 0.35, ty = mt.y - mt.vy * tail * 0.35;
      const g = ctx.createLinearGradient(mt.x, mt.y, tx, ty);
      g.addColorStop(0, `rgba(255,255,255,${0.95 * k})`);
      g.addColorStop(1, "rgba(160,200,255,0)");
      ctx.strokeStyle = g;
      ctx.lineWidth = 2.4 * u;
      ctx.beginPath();
      ctx.moveTo(mt.x, mt.y);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${k})`;
      ctx.beginPath();
      ctx.arc(mt.x, mt.y, 2.2 * u * k + 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Expanding shockwave rings for the cash-out punch. */
  private drawRings(u: number): void {
    const { ctx } = this;
    ctx.save();
    for (const rg of this.rings) {
      const age = rg.t - rg.delay;
      if (age < 0) continue;
      const k = age / rg.life;
      const ease = 1 - Math.pow(1 - k, 3);
      const radius = Math.max(1, rg.maxR * ease);
      ctx.globalAlpha = Math.max(0, 0.9 * (1 - k));
      ctx.strokeStyle = rg.color;
      ctx.lineWidth = rg.width * (1 - k * 0.6);
      ctx.shadowColor = rg.color;
      ctx.shadowBlur = 18 * u;
      ctx.beginPath();
      ctx.arc(rg.x, rg.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    void u;
  }

  private drawTrail(u: number): void {
    const { ctx } = this;
    if (this.trail.length < 2) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < this.trail.length; i++) {
      const a = this.trail[i - 1], b = this.trail[i];
      ctx.strokeStyle = riskColor(b.m);
      ctx.globalAlpha = Math.min(1, i / 24 + 0.15);
      ctx.lineWidth = (2 + 7 * Math.min(1, i / this.trail.length)) * u;
      ctx.shadowColor = riskColor(b.m);
      ctx.shadowBlur = 14 * u;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Draw the rocket + co-pilot. Skipped after crash (aftermath draws wreckage). */
  private drawRocket(state: FrameState, alt: number, u: number): void {
    const { ctx } = this;
    const r = this.rocketPos(state, alt);
    const bob = state.phase === "flying" ? Math.sin(this.time * 30) * 2 * u : Math.sin(this.time * 2) * 3 * u;
    const tilt = state.phase === "flying" ? Math.sin(this.time * 1.7) * 0.05 : 0;
    ctx.save();
    ctx.translate(r.x, r.y + bob);
    ctx.rotate(tilt);

    // exhaust flame while flying
    if (state.phase === "flying") {
      const flick = 1 + Math.sin(this.time * 47) * 0.25;
      const fg = ctx.createLinearGradient(0, 26 * u, 0, (26 + 52 * flick) * u);
      fg.addColorStop(0, "rgba(255,240,180,0.95)");
      fg.addColorStop(0.4, "rgba(255,150,50,0.85)");
      fg.addColorStop(1, "rgba(255,80,30,0)");
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(-13 * u, 24 * u);
      ctx.quadraticCurveTo(0, (30 + 58 * flick) * u, 13 * u, 24 * u);
      ctx.closePath();
      ctx.fill();
    }

    // fins
    ctx.fillStyle = "#e0455a";
    ctx.beginPath();
    ctx.moveTo(-16 * u, 6 * u); ctx.lineTo(-30 * u, 30 * u); ctx.lineTo(-14 * u, 28 * u);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(16 * u, 6 * u); ctx.lineTo(30 * u, 30 * u); ctx.lineTo(14 * u, 28 * u);
    ctx.closePath(); ctx.fill();
    // body
    const bg = ctx.createLinearGradient(-18 * u, 0, 18 * u, 0);
    bg.addColorStop(0, "#8b93b8"); bg.addColorStop(0.5, "#e8ecff"); bg.addColorStop(1, "#8b93b8");
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(-17 * u, 26 * u);
    ctx.lineTo(-17 * u, -8 * u);
    ctx.quadraticCurveTo(-17 * u, -30 * u, 0, -38 * u);
    ctx.quadraticCurveTo(17 * u, -30 * u, 17 * u, -8 * u);
    ctx.lineTo(17 * u, 26 * u);
    ctx.quadraticCurveTo(0, 32 * u, -17 * u, 26 * u);
    ctx.fill();
    // nose tip
    ctx.fillStyle = "#e0455a";
    ctx.beginPath();
    ctx.moveTo(-9 * u, -24 * u);
    ctx.quadraticCurveTo(0, -40 * u, 9 * u, -24 * u);
    ctx.quadraticCurveTo(0, -19 * u, -9 * u, -24 * u);
    ctx.fill();
    // window + co-pilot
    ctx.fillStyle = "#0b1030";
    ctx.beginPath(); ctx.arc(0, -6 * u, 13 * u, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(56,225,255,0.9)";
    ctx.lineWidth = 2.5 * u;
    ctx.beginPath(); ctx.arc(0, -6 * u, 13 * u, 0, Math.PI * 2); ctx.stroke();
    this.drawCopilot(0, -6 * u, 9.5 * u, state.multiplier, state.phase);
    // RF roundel
    ctx.fillStyle = "#ffd23f";
    ctx.beginPath(); ctx.arc(0, 14 * u, 6.5 * u, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#7a4d00";
    ctx.font = `bold ${8 * u}px system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("RF", 0, 14.5 * u);
    ctx.restore();
  }

  /** Original co-pilot character: mint blob, pilot helmet, fluttering scarf. */
  private drawCopilot(x: number, y: number, r: number, multiplier: number, phase: ScenePhase): void {
    const { ctx } = this;
    const mood = phase !== "flying" ? "chill" : multiplier < 2 ? "chill" : multiplier < 5 ? "thrilled" : "terrified";
    ctx.save();
    ctx.translate(x, y);
    // terrified tremble (damped by reduced motion)
    if (mood === "terrified" && phase === "flying" && !this.reducedMotion) {
      ctx.translate((Math.random() - 0.5) * r * 0.16, (Math.random() - 0.5) * r * 0.16);
    }
    // scarf flutter
    const fl = Math.sin(this.time * (phase === "flying" ? 22 : 6)) * r * 0.5;
    ctx.fillStyle = "#e0455a";
    ctx.beginPath();
    ctx.moveTo(-r * 0.7, r * 0.35);
    ctx.quadraticCurveTo(-r * 1.9, r * 0.1 + fl, -r * 2.4, r * 0.7 + fl);
    ctx.quadraticCurveTo(-r * 1.7, r * 0.9 + fl * 0.5, -r * 0.6, r * 0.75);
    ctx.closePath(); ctx.fill();
    // body
    const bodyG = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r * 1.2);
    bodyG.addColorStop(0, "#a8ffdf");
    bodyG.addColorStop(1, "#4fd6a5");
    ctx.fillStyle = bodyG;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    // helmet
    ctx.fillStyle = "rgba(200,230,255,0.35)";
    ctx.beginPath(); ctx.arc(0, -r * 0.15, r * 1.02, Math.PI, 0); ctx.fill();
    ctx.strokeStyle = "rgba(220,240,255,0.8)";
    ctx.lineWidth = r * 0.12;
    ctx.beginPath(); ctx.arc(0, -r * 0.15, r * 1.02, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    // eyes — bigger and more readable per mood
    const eyeR = r * (mood === "terrified" ? 0.38 : mood === "thrilled" ? 0.33 : 0.25);
    const blink = this.blinkT % 3.7 < 0.12 && mood === "chill";
    for (const s of [-1, 1]) {
      const ex = s * r * 0.38, ey = -r * 0.05;
      if (blink) {
        ctx.strokeStyle = "#0c2b22"; ctx.lineWidth = r * 0.09;
        ctx.beginPath(); ctx.moveTo(ex - eyeR, ey); ctx.lineTo(ex + eyeR, ey); ctx.stroke();
      } else {
        ctx.fillStyle = "#fff";
        ctx.beginPath(); ctx.arc(ex, ey, eyeR, 0, Math.PI * 2); ctx.fill();
        const pr = eyeR * (mood === "chill" ? 0.48 : 0.34);
        const py = mood === "terrified" ? ey - eyeR * 0.28 : ey + Math.sin(this.time * 3) * r * 0.04;
        ctx.fillStyle = "#0c2b22";
        ctx.beginPath(); ctx.arc(ex, py, pr, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.beginPath(); ctx.arc(ex - pr * 0.3, py - pr * 0.3, pr * 0.35, 0, Math.PI * 2); ctx.fill();
        if (mood === "thrilled") {
          // sparkle in the pupil
          const sx = ex + pr * 0.5, sy = py - pr * 0.55, sr = pr * 0.45;
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = Math.max(1, pr * 0.2);
          ctx.beginPath();
          ctx.moveTo(sx - sr, sy); ctx.lineTo(sx + sr, sy);
          ctx.moveTo(sx, sy - sr); ctx.lineTo(sx, sy + sr);
          ctx.stroke();
        }
      }
    }
    // terrified: angled alarmed eyebrows
    if (mood === "terrified") {
      ctx.strokeStyle = "#0c2b22";
      ctx.lineWidth = r * 0.11;
      ctx.lineCap = "round";
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * r * 0.64, -r * 0.64);
        ctx.lineTo(s * r * 0.16, -r * 0.44);
        ctx.stroke();
      }
    }
    // thrilled: blush cheeks
    if (mood === "thrilled") {
      ctx.fillStyle = "rgba(255,110,150,0.55)";
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(s * r * 0.64, r * 0.34, r * 0.17, r * 0.11, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // mouth — bigger and mood-readable
    ctx.strokeStyle = "#0c2b22";
    ctx.lineWidth = r * 0.1;
    ctx.lineCap = "round";
    if (mood === "terrified") {
      // open "O" of panic
      ctx.fillStyle = "#0c2b22";
      ctx.beginPath();
      ctx.ellipse(0, r * 0.54, r * 0.17, r * 0.24, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      if (mood === "chill") {
        ctx.arc(0, r * 0.26, r * 0.34, Math.PI * 0.15, Math.PI * 0.85);
      } else {
        // thrilled: big open grin
        ctx.arc(0, r * 0.16, r * 0.42, Math.PI * 0.08, Math.PI * 0.92);
        ctx.fillStyle = "#7a2b3a";
        ctx.fill();
      }
      ctx.stroke();
    }
    if (mood === "terrified") {
      // two sweat drops racing off the helmet
      const drops: Array<[number, number]> = [[0.95, 0], [-0.82, 1.4]];
      for (const [ox, ph] of drops) {
        const fall = ((this.time * 60) + ph * r) % (r * 2.6);
        ctx.fillStyle = "rgba(140,200,255,0.9)";
        ctx.beginPath();
        ctx.arc(ox * r, -r * 0.95 + fall, r * 0.15, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private drawCrashAftermath(state: FrameState, u: number): void {
    const { ctx, W } = this;
    // fireball core: white-hot expanding bloom
    if (this.explosion && this.explosion.t < 0.4) {
      const t = this.explosion.t / 0.4;
      const radius = (26 + t * 78) * u;
      const fg = ctx.createRadialGradient(
        this.explosion.x, this.explosion.y, 2,
        this.explosion.x, this.explosion.y, radius,
      );
      fg.addColorStop(0, `rgba(255,252,235,${0.95 * (1 - t)})`);
      fg.addColorStop(0.35, `rgba(255,190,90,${0.75 * (1 - t)})`);
      fg.addColorStop(1, "rgba(255,90,40,0)");
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.arc(this.explosion.x, this.explosion.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    // falling wreckage halves
    if (this.explosion && this.explosion.t < 2.2) {
      const t = this.explosion.t;
      const e = this.explosion;
      ctx.save();
      ctx.translate(e.x - 14 * u + t * 30 * u, e.y + t * t * 160 * u);
      ctx.rotate(t * 2.4);
      ctx.fillStyle = "#5a6285";
      ctx.fillRect(-14 * u, -10 * u, 20 * u, 34 * u);
      ctx.restore();
      ctx.save();
      ctx.translate(e.x + 16 * u - t * 44 * u, e.y - 20 * u + t * t * 190 * u);
      ctx.rotate(-t * 3.1);
      ctx.fillStyle = "#e0455a";
      ctx.beginPath();
      ctx.moveTo(-10 * u, 0); ctx.lineTo(10 * u, 0); ctx.lineTo(0, -22 * u);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    // lingering smoke
    if (this.explosion && this.explosion.t < 1.4 && !this.reducedMotion) {
      for (let i = 0; i < 3; i++) {
        const t = this.explosion.t;
        ctx.fillStyle = `rgba(90,95,130,${0.35 * (1 - t / 1.4)})`;
        ctx.beginPath();
        ctx.arc(this.explosion.x + Math.sin(i * 2.1 + t * 3) * 20 * u, this.explosion.y - t * 60 * u - i * 18 * u, (14 + t * 26) * u, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    void W; void state;
  }

  private drawEjectee(u: number): void {
    const { ctx } = this;
    const e = this.eject;
    if (!e) return;
    ctx.save();
    if (!e.landed) {
      // parachute
      const sway = Math.sin(this.time * 3) * 0.12;
      ctx.translate(e.x, e.y);
      ctx.rotate(sway);
      ctx.fillStyle = "#ffd23f";
      ctx.beginPath();
      ctx.arc(0, -34 * u, 26 * u, Math.PI, 0);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#e0455a";
      ctx.beginPath();
      ctx.arc(0, -34 * u, 26 * u, Math.PI * 1.25, Math.PI * 1.75);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "rgba(40,40,70,0.8)";
      ctx.lineWidth = 1.5 * u;
      for (const s of [-1, -0.4, 0.4, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * 24 * u, -36 * u);
        ctx.lineTo(s * 8 * u, -8 * u);
        ctx.stroke();
      }
      this.drawCopilotDazed(0, 0, 13 * u);
    } else {
      // landed, dazed: X eyes + circling stars
      this.drawCopilotDazed(e.x, e.y, 13 * u);
      ctx.strokeStyle = "#ffd23f";
      ctx.lineWidth = 2 * u;
      for (let i = 0; i < 3; i++) {
        const a = this.time * 2.4 + (i * Math.PI * 2) / 3;
        const sx = e.x + Math.cos(a) * 22 * u, sy = e.y - 26 * u + Math.sin(a) * 6 * u;
        ctx.beginPath();
        for (let k = 0; k < 5; k++) {
          const aa = (k * Math.PI * 2) / 5 - Math.PI / 2;
          const rr = k % 2 === 0 ? 5 * u : 2.2 * u;
          const px = sx + Math.cos(aa) * rr, py = sy + Math.sin(aa) * rr;
          if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath(); ctx.stroke();
      }
      // dust puff settled
      ctx.fillStyle = "rgba(120,125,160,0.3)";
      ctx.beginPath();
      ctx.ellipse(e.x, e.y + 14 * u, 26 * u, 8 * u, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawCopilotDazed(x: number, y: number, r: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    const bodyG = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r * 1.2);
    bodyG.addColorStop(0, "#a8ffdf");
    bodyG.addColorStop(1, "#4fd6a5");
    ctx.fillStyle = bodyG;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#0c2b22";
    ctx.lineWidth = r * 0.14;
    ctx.lineCap = "round";
    for (const s of [-1, 1]) {
      const ex = s * r * 0.36, ey = -r * 0.05, er = r * 0.2;
      ctx.beginPath();
      ctx.moveTo(ex - er, ey - er); ctx.lineTo(ex + er, ey + er);
      ctx.moveTo(ex + er, ey - er); ctx.lineTo(ex - er, ey + er);
      ctx.stroke();
    }
    // wavy mouth
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) {
      const px = -r * 0.3 + (i * r * 0.6) / 6;
      const py = r * 0.5 + (i % 2 === 0 ? -r * 0.08 : r * 0.08);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    // tongue lolling out
    ctx.fillStyle = "#e0708a";
    ctx.beginPath();
    ctx.ellipse(r * 0.12, r * 0.72, r * 0.14, r * 0.2, 0.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#0c2b22";
    ctx.lineWidth = r * 0.07;
    ctx.beginPath();
    ctx.moveTo(r * 0.12, r * 0.62);
    ctx.lineTo(r * 0.12, r * 0.82);
    ctx.stroke();
    ctx.restore();
  }

  private drawParticles(u: number): void {
    const { ctx } = this;
    for (const p of this.particles) {
      const t = p.life / p.maxLife;
      ctx.globalAlpha = Math.max(0, t);
      ctx.fillStyle = p.color;
      if (p.shape === "rect") {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot ?? 0);
        const w = p.size * (0.5 + 0.5 * t);
        ctx.fillRect(-w / 2, -w / 4, w, w / 2);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.5, p.size * (0.4 + 0.6 * t)), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    void u;
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
    ctx.font = `900 ${84 * u}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "#38e1ff";
    ctx.shadowBlur = 30 * u;
    ctx.fillStyle = "#eaf6ff";
    ctx.fillText(String(n), 0, 0);
    ctx.restore();
    // "GET READY" label
    ctx.save();
    ctx.font = `700 ${20 * u}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(234,246,255,0.85)";
    ctx.fillText("GET READY", W / 2, H * 0.34 + 70 * u);
    ctx.restore();
  }
}
