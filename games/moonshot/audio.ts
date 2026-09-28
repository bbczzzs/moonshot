/**
 * Moonshot audio: 100% synthesized with WebAudio, zero assets.
 *
 * The rising whine pitched to the live multiplier IS the tension mechanic —
 * keep it smooth (exponentialRamp) and always tied to the current multiplier.
 * All sounds are no-ops until unlock() is called from a user gesture.
 */
export class MoonshotAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private climbOsc: OscillatorNode | null = null;
  private climbOsc2: OscillatorNode | null = null;
  private climbGain: GainNode | null = null;
  private muted = true;

  /** Call from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.5, this.ctx.currentTime, 0.02);
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Short UI blip. */
  tick(freq = 660): void {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  countdownBeep(final: boolean): void {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "square";
    osc.frequency.value = final ? 880 : 440;
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (final ? 0.35 : 0.15));
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.4);
  }

  /** Engine rumble: filtered noise swell. */
  launchRumble(): void {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.now();
    const dur = 1.6;
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(120, t);
    filter.frequency.exponentialRampToValueAtTime(900, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    noise.connect(filter).connect(g).connect(this.master);
    noise.start(t);
  }

  /** Start the climbing whine. Call climbSet(m) every frame while flying. */
  climbStart(): void {
    if (!this.ctx || !this.master || this.climbOsc) return;
    const t = this.now();
    this.climbGain = this.ctx.createGain();
    this.climbGain.gain.setValueAtTime(0.0001, t);
    this.climbGain.gain.exponentialRampToValueAtTime(0.12, t + 0.4);
    this.climbGain.connect(this.master);
    this.climbOsc = this.ctx.createOscillator();
    this.climbOsc.type = "sawtooth";
    this.climbOsc.frequency.value = 90;
    this.climbOsc2 = this.ctx.createOscillator();
    this.climbOsc2.type = "sine";
    this.climbOsc2.frequency.value = 180;
    const g2 = this.ctx.createGain();
    g2.gain.value = 0.4;
    this.climbOsc.connect(this.climbGain);
    this.climbOsc2.connect(g2).connect(this.climbGain);
    this.climbOsc.start(t);
    this.climbOsc2.start(t);
  }

  /** multiplier >= 1: pitch rises with risk. */
  climbSet(multiplier: number): void {
    if (!this.ctx || !this.climbOsc || !this.climbOsc2 || this.muted) return;
    const t = this.now();
    const f = 90 * Math.pow(multiplier, 0.85);
    this.climbOsc.frequency.setTargetAtTime(Math.min(f, 1400), t, 0.05);
    this.climbOsc2.frequency.setTargetAtTime(Math.min(f * 2, 2800), t, 0.05);
  }

  climbStop(): void {
    if (!this.ctx || !this.climbOsc) return;
    const t = this.now();
    this.climbGain?.gain.setTargetAtTime(0.0001, t, 0.08);
    const osc = this.climbOsc, osc2 = this.climbOsc2;
    window.setTimeout(() => {
      try { osc?.stop(); osc2?.stop(); } catch { /* already stopped */ }
    }, 400);
    this.climbOsc = null;
    this.climbOsc2 = null;
    this.climbGain = null;
  }

  /** Cash-out: bright ascending arpeggio. */
  cashOut(): void {
    if (!this.ctx || !this.master || this.muted) return;
    this.climbStop();
    const t = this.now();
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    notes.forEach((freq, i) => {
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      const start = t + i * 0.07;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.3, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.5);
      osc.connect(g).connect(this.master!);
      osc.start(start);
      osc.stop(start + 0.55);
    });
  }

  /** Crash: sub boom + comedic slide-whistle down. */
  crash(): void {
    if (!this.ctx || !this.master || this.muted) return;
    this.climbStop();
    const t = this.now();
    // Sub boom
    const boom = this.ctx.createOscillator();
    const boomG = this.ctx.createGain();
    boom.type = "sine";
    boom.frequency.setValueAtTime(160, t);
    boom.frequency.exponentialRampToValueAtTime(38, t + 0.7);
    boomG.gain.setValueAtTime(0.6, t);
    boomG.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    boom.connect(boomG).connect(this.master);
    boom.start(t);
    boom.stop(t + 0.85);
    // Noise burst
    const dur = 0.5;
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.35, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + dur);
    noise.connect(ng).connect(this.master);
    noise.start(t);
    // Slide whistle of defeat
    const slide = this.ctx.createOscillator();
    const slideG = this.ctx.createGain();
    slide.type = "sine";
    slide.frequency.setValueAtTime(1400, t + 0.25);
    slide.frequency.exponentialRampToValueAtTime(280, t + 1.1);
    slideG.gain.setValueAtTime(0.0001, t + 0.25);
    slideG.gain.exponentialRampToValueAtTime(0.18, t + 0.35);
    slideG.gain.exponentialRampToValueAtTime(0.001, t + 1.15);
    slide.connect(slideG).connect(this.master);
    slide.start(t + 0.25);
    slide.stop(t + 1.2);
  }

  /** A crew member ejects: short pop + chirp. */
  eject(): void {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(900, t);
    osc.frequency.exponentialRampToValueAtTime(1500, t + 0.06);
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  /** A landmark is passed. */
  milestone(): void {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.now();
    [880, 1318.5].forEach((f, i) => {
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = "triangle";
      osc.frequency.value = f;
      const s = t + i * 0.09;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.16, s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, s + 0.3);
      osc.connect(g).connect(this.master!);
      osc.start(s);
      osc.stop(s + 0.32);
    });
  }

  /** RF burned in the furnace (hangar purchase): whoosh + low thump. */
  burn(): void {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.now();
    const dur = 0.6;
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.sin((i / data.length) * Math.PI);
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(400, t);
    filter.frequency.exponentialRampToValueAtTime(2400, t + dur);
    const g = this.ctx.createGain();
    g.gain.value = 0.3;
    noise.connect(filter).connect(g).connect(this.master);
    noise.start(t);
  }

  /** Freeze/unfreeze all audio when the runtime pauses the game (menus open). */
  setPaused(paused: boolean): void {
    if (!this.ctx) return;
    if (paused) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  dispose(): void {
    try { this.climbStop(); } catch { /* noop */ }
    if (this.ctx) void this.ctx.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
  }
}
