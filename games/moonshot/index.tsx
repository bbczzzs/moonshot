"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import {
  Ledger,
  drawCrashPoint,
  multiplierAt,
  floorMult,
  payoutOf,
  parseRf,
  fmtRf,
  fuelOf,
  ONE_RF,
  MIN_STAKE,
  STARTING_BALANCE,
  type Bet,
  type PlayerStats,
} from "./economy";
import { makeCrew, mulberry32, FAMILY_NAMES, FAMILY_COLORS, type CrewMember, type SpriteRows } from "./crew";
import { SKINS, TRAILS } from "./looks";
import { MoonshotAudio } from "./audio";
import { MoonshotScene, spriteCanvas, type SceneCrew } from "./scene";
import { loadPilot, type PilotSprite } from "./pilot";
import "./style.css";

type Phase = "boarding" | "flying" | "crashed";
type PlayerStatus = "none" | "riding" | "ejected" | "burned";
type Tab = "crew" | "hangar" | "stats";

const BOARDING_S = 6;
const AFTERMATH_S = 3.4;
const PRESETS = ["5", "10", "25", "50", "100"];
const MILESTONES: { m: number; label: string }[] = [
  { m: 2, label: "Passed the Moon" },
  { m: 3, label: "Past the satellites" },
  { m: 5, label: "Mars flyby" },
  { m: 10, label: "Saturn's rings" },
  { m: 25, label: "Into the nebula" },
  { m: 50, label: "Black hole slingshot" },
  { m: 100, label: "MOONSHOT" },
];

const rf = (v: bigint) => `${fmtRf(v)} RF`;

interface Round {
  n: number;
  phase: Phase;
  phaseT: number;
  multiplier: number;
  crashPoint: number;
  crew: CrewMember[];
  bet: Bet | null; // player's ignited bet this round
  status: PlayerStatus;
  cashedAt: number | null;
  payout: bigint;
  milestone: number;
  fuelBurned: bigint; // everyone's fuel this round
  pool: bigint; // riding RF lost to the Launch Pool this round
}

interface World {
  burned: bigint; // all pilots, this session (simulated)
  volume: bigint;
  launches: number;
  started: number; // ms, for the burn rate
  perLaunch: number[]; // RF burned by each recent launch (fuel), newest last
}

interface Toast { id: number; text: string; kind: "good" | "bad" | "info"; }

/** Pixel avatar for list rows (data URL, cached). */
const avatarCache = new Map<string, string>();
function avatar(key: string, rows: SpriteRows | undefined, fill = "#000000"): string {
  if (!rows) return "";
  const k = `${key}:${fill}`;
  let url = avatarCache.get(k);
  if (!url) {
    url = spriteCanvas(rows, fill).toDataURL();
    avatarCache.set(k, url);
  }
  return url;
}

function multClass(m: number): string {
  if (m < 1.5) return "lo";
  if (m < 2) return "mid";
  if (m < 10) return "hi";
  return "mega";
}

/**
 * Moonshot — a live crash game for the Rare Friends Vibeathon (Token Activity).
 * The SDK runtime supplies wallet connection, Friend selection and the
 * ownership gate; every RF amount here is a simulated demo ledger.
 */
export default function Moonshot({ friendId, client, paused }: GameComponentProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const multRef = useRef<HTMLDivElement | null>(null);
  const cashRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<HTMLSpanElement | null>(null);
  const sceneRef = useRef<MoonshotScene | null>(null);
  const audioRef = useRef<MoonshotAudio | null>(null);
  const ledgerRef = useRef(new Ledger());
  const pausedRef = useRef(paused);
  const pilotRef = useRef<PilotSprite | null>(null);
  const randRef = useRef(mulberry32((Date.now() ^ Number(BigInt.asUintN(32, friendId))) >>> 0));
  const reservedRef = useRef<bigint | null>(null); // stake held for the next launch
  const worldRef = useRef<World>({ burned: 0n, volume: 0n, launches: 0, started: Date.now(), perLaunch: [] });
  const autoRef = useRef({ cash: false, cashAt: 2, bet: false, betLeft: 0 as number, stake: 10n * ONE_RF });
  const roundRef = useRef<Round>(newRound(0));
  const toastId = useRef(0);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [pilot, setPilot] = useState<PilotSprite | null>(null);
  const [, setTick] = useState(0);
  const [stakeText, setStakeText] = useState("10");
  const [autoCash, setAutoCash] = useState(false);
  const [autoCashText, setAutoCashText] = useState("2.00");
  const [autoBet, setAutoBet] = useState(false);
  const [autoBetRounds, setAutoBetRounds] = useState<number>(10);
  const [history, setHistory] = useState<number[]>([]);
  const [tab, setTab] = useState<Tab>("crew");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [muted, setMuted] = useState(true);
  const [reduced, setReduced] = useState(false);
  const [skin, setSkin] = useState("classic");
  const [trail, setTrail] = useState("flame");
  const [owned, setOwned] = useState<Set<string>>(() => new Set(["classic", "flame"]));
  const [confirmBuy, setConfirmBuy] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ title: string; sub: string; kind: "win" | "burn" | "info" } | null>(null);
  const [message, setMessage] = useState("");

  const rerender = () => setTick(t => (t + 1) % 1_000_000);

  function newRound(n: number): Round {
    return {
      n, phase: "boarding", phaseT: 0, multiplier: 1, crashPoint: 1,
      crew: [], bet: null, status: "none", cashedAt: null, payout: 0n, milestone: 0,
      fuelBurned: 0n, pool: 0n,
    };
  }

  function toast(text: string, kind: Toast["kind"] = "info") {
    const id = ++toastId.current;
    setToasts(t => [...t.slice(-2), { id, text, kind }]);
    window.setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2600);
  }

  // ---- identity + session ----
  useEffect(() => {
    let live = true;
    pilotRef.current = null;
    setPilot(null);
    loadPilot(friendId).then(p => {
      if (!live) return;
      pilotRef.current = p;
      setPilot(p);
      sceneRef.current?.setPilot(p.frames);
    });
    return () => { live = false; };
  }, [friendId]);

  useEffect(() => {
    let live = true;
    setReady(false);
    setError("");
    // The runtime finishes loading once the child reads its session, even
    // though Moonshot runs its own simulated ledger rather than chance plays.
    client.read()
      .then(() => { if (live) setReady(true); })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : "Could not load the game session."); });
    return () => { live = false; };
  }, [client, friendId]);

  useEffect(() => {
    pausedRef.current = paused;
    audioRef.current?.setPaused(paused);
  }, [paused]);

  useEffect(() => { autoRef.current.cash = autoCash; }, [autoCash]);
  useEffect(() => {
    const v = Number(autoCashText);
    autoRef.current.cashAt = Number.isFinite(v) && v >= 1.01 ? floorMult(v) : 1.01;
  }, [autoCashText]);
  useEffect(() => {
    const s = parseRf(stakeText);
    if (s !== null) autoRef.current.stake = s;
  }, [stakeText]);
  useEffect(() => { sceneRef.current?.setLook(skin, trail); }, [skin, trail]);

  // ---- main loop ----
  useEffect(() => {
    if (!ready) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = new MoonshotScene(canvas);
    const audio = new MoonshotAudio();
    sceneRef.current = scene;
    audioRef.current = audio;
    scene.setLook(skin, trail);
    if (pilotRef.current) scene.setPilot(pilotRef.current.frames);

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const applyMotion = () => { setReduced(mq.matches); scene.setReducedMotion(mq.matches); };
    applyMotion();
    mq.addEventListener("change", applyMotion);
    const ro = new ResizeObserver(() => scene.resize());
    ro.observe(canvas);

    startBoarding(roundRef.current.n + 1);

    let raf = 0;
    let last = 0;
    let uiClock = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      if (pausedRef.current) return;
      step(dt);
      const r = roundRef.current;
      const sceneCrew: SceneCrew[] = r.crew
        .filter(c => c.status === "riding")
        .map(c => ({ id: c.friend.id, frames: c.friend.frames, familyId: c.friend.familyId, seat: c.seat, joinedT: r.phase === "boarding" ? r.phaseT - c.joinAt : 9 }));
      scene.frame({
        phase: r.phase, phaseT: r.phaseT, multiplier: r.multiplier, crew: sceneCrew,
        playerAboard: r.status === "riding" || (r.phase === "boarding" && reservedRef.current !== null),
        playerWatching: r.status === "none" && !(r.phase === "boarding" && reservedRef.current !== null),
      }, dt);
      paintHud();
      uiClock += dt;
      if (uiClock > 0.12) { uiClock = 0; rerender(); }
    };
    raf = requestAnimationFrame(loop);

    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.code === "Space") { e.preventDefault(); if (!pausedRef.current) primary(); }
      else if (e.key === "m" || e.key === "M") toggleMute();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mq.removeEventListener("change", applyMotion);
      window.removeEventListener("keydown", onKey);
      audio.dispose();
      sceneRef.current = null;
      audioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  function startBoarding(n: number) {
    const r = newRound(n);
    r.crew = makeCrew(randRef.current, BOARDING_S, Number(friendId));
    roundRef.current = r;
    setBanner(null);
    const auto = autoRef.current;
    if (auto.bet && reservedRef.current === null) {
      const ledger = ledgerRef.current;
      if (auto.betLeft !== 0 && ledger.reserve(auto.stake)) {
        reservedRef.current = auto.stake;
        if (auto.betLeft > 0) auto.betLeft -= 1;
      } else {
        auto.bet = false;
        setAutoBet(false);
        toast(auto.betLeft === 0 ? "Auto-launch finished" : "Auto-launch stopped: not enough demo RF", "info");
      }
    }
  }

  function step(dt: number) {
    const r = roundRef.current;
    const scene = sceneRef.current!;
    const audio = audioRef.current!;
    const ledger = ledgerRef.current;
    r.phaseT += dt;

    if (r.phase === "boarding") {
      for (const c of r.crew) {
        if (c.status === "boarding" && r.phaseT >= c.joinAt) {
          c.status = "riding";
          scene.boarded(c.seat);
          audio.tick(500 + c.seat * 40);
        }
      }
      if (r.phaseT >= BOARDING_S) ignite(r);
      return;
    }

    if (r.phase === "flying") {
      // The crash point is the highest multiplier reached: ejecting at or
      // below it wins, so P(win at m) = 1/m exactly.
      const raw = multiplierAt(r.phaseT);
      const m = Math.min(raw, r.crashPoint);
      r.multiplier = m;
      audio.climbSet(m);
      // Crew ejections at their targets.
      for (const c of r.crew) {
        const at = c.target === null ? Infinity : floorMult(c.target);
        if (c.status === "riding" && at <= m) {
          c.status = "ejected";
          c.cashedAt = at;
          c.payout = payoutOf(c.riding, at);
          scene.ejectCrew({ id: c.friend.id, frames: c.friend.frames, familyId: c.friend.familyId, seat: c.seat, joinedT: 9 }, at);
          audio.eject();
        }
      }
      // Player auto cash-out.
      const auto = autoRef.current;
      if (r.status === "riding" && auto.cash && m >= auto.cashAt) cashOut(auto.cashAt);
      if (raw >= r.crashPoint) {
        crash(r);
        return;
      }
      // Milestones.
      const next = MILESTONES[r.milestone];
      if (next && m >= next.m) {
        r.milestone += 1;
        toast(`→ ${next.label} · ${next.m}x`, "good");
        audio.milestone();
      }
      return;
    }

    if (r.phase === "crashed" && r.phaseT >= AFTERMATH_S) {
      startBoarding(r.n + 1);
    }
  }

  function ignite(r: Round) {
    const ledger = ledgerRef.current;
    const audio = audioRef.current!;
    r.phase = "flying";
    r.phaseT = 0;
    r.multiplier = 1;
    r.crashPoint = drawCrashPoint(randRef.current);
    // Crew who never made it aboard sit this one out.
    r.crew = r.crew.filter(c => c.status === "riding");
    for (const c of r.crew) {
      r.fuelBurned += c.fuel;
      worldRef.current.volume += c.stake;
    }
    const stake = reservedRef.current;
    reservedRef.current = null;
    if (stake !== null) {
      r.bet = ledger.ignite(stake);
      r.status = "riding";
      r.fuelBurned += r.bet.fuel;
      worldRef.current.volume += stake;
    }
    worldRef.current.burned += r.fuelBurned;
    worldRef.current.launches += 1;
    worldRef.current.perLaunch = [...worldRef.current.perLaunch, Number(r.fuelBurned * 100n / ONE_RF) / 100].slice(-16);
    audio.launchRumble();
    audio.climbStart();
  }

  function crash(r: Round) {
    const ledger = ledgerRef.current;
    const audio = audioRef.current!;
    const scene = sceneRef.current!;
    const aboard = r.crew.filter(c => c.status === "riding");
    for (const c of aboard) { c.status = "burned"; r.pool += c.riding; }
    const playerAboard = r.status === "riding";
    if (playerAboard && r.bet) {
      ledger.crashed(r.bet);
      r.pool += r.bet.riding;
      r.status = "burned";
    }
    scene.crash(aboard.map(c => ({ id: c.friend.id, frames: c.friend.frames, familyId: c.friend.familyId, seat: c.seat, joinedT: 9 })), playerAboard);
    audio.crash();
    r.phase = "crashed";
    r.phaseT = 0;
    setHistory(h => [r.crashPoint, ...h].slice(0, 14));
    if (r.status === "burned" && r.bet) {
      setBanner({ title: `CRASHED @ ${r.crashPoint.toFixed(2)}x`, sub: `Your ride of ${rf(r.bet.riding)} went to the Launch Pool`, kind: "burn" });
    } else if (r.status === "ejected" && r.bet) {
      setBanner({ title: `CRASHED @ ${r.crashPoint.toFixed(2)}x`, sub: `You ejected at ${r.cashedAt?.toFixed(2)}x · +${rf(r.payout - r.bet.stake)}`, kind: "win" });
    } else {
      setBanner({ title: `CRASHED @ ${r.crashPoint.toFixed(2)}x`, sub: `${aboard.length} of ${r.crew.length} crew still aboard`, kind: "info" });
    }
  }

  function cashOut(at?: number) {
    const r = roundRef.current;
    if (r.phase !== "flying" || r.status !== "riding" || !r.bet || pausedRef.current) return;
    const m = floorMult(at ?? r.multiplier);
    if (m < 1.01 || m > r.crashPoint) return;
    const payout = ledgerRef.current.cashOut(r.bet, m);
    r.status = "ejected";
    r.cashedAt = m;
    r.payout = payout;
    sceneRef.current?.ejectPlayer(m);
    audioRef.current?.cashOut();
    toast(`Ejected at ${m.toFixed(2)}x · ${rf(payout)}`, "good");
    rerender();
  }

  function placeBet() {
    if (reservedRef.current !== null) return;
    const stake = parseRf(stakeText);
    if (stake === null || stake < MIN_STAKE) { setMessage("Stake must be at least 1 RF."); return; }
    if (!ledgerRef.current.reserve(stake)) { setMessage(`Not enough demo RF — balance ${rf(ledgerRef.current.balance)}.`); return; }
    reservedRef.current = stake;
    setMessage("");
    audioRef.current?.unlock();
    audioRef.current?.tick(720);
    rerender();
  }

  function cancelBet() {
    const stake = reservedRef.current;
    if (stake === null) return;
    ledgerRef.current.refund(stake);
    reservedRef.current = null;
    audioRef.current?.tick(360);
    rerender();
  }

  function primary() {
    const r = roundRef.current;
    if (r.phase === "flying" && r.status === "riding") cashOut();
    else if (reservedRef.current !== null) cancelBet();
    else placeBet();
  }

  function toggleAutoBet() {
    const auto = autoRef.current;
    if (autoBet) {
      auto.bet = false;
      setAutoBet(false);
      return;
    }
    const stake = parseRf(stakeText);
    if (stake === null || stake < MIN_STAKE) { setMessage("Set a stake of at least 1 RF first."); return; }
    auto.stake = stake;
    auto.bet = true;
    auto.betLeft = autoBetRounds === 0 ? -1 : autoBetRounds;
    setAutoBet(true);
    audioRef.current?.unlock();
    if (roundRef.current.phase === "boarding" && reservedRef.current === null) {
      if (ledgerRef.current.reserve(stake)) {
        reservedRef.current = stake;
        if (auto.betLeft > 0) auto.betLeft -= 1;
      }
    }
  }

  function toggleMute() {
    const audio = audioRef.current;
    setMuted(m => {
      const next = !m;
      audio?.unlock();
      audio?.setMuted(next);
      if (!next) audio?.tick(660);
      return next;
    });
  }

  function buy(kind: "skin" | "trail", id: string, price: number) {
    if (owned.has(id)) {
      if (kind === "skin") setSkin(id); else setTrail(id);
      audioRef.current?.tick(600);
      return;
    }
    if (confirmBuy !== id) { setConfirmBuy(id); return; }
    setConfirmBuy(null);
    const cost = BigInt(price) * ONE_RF;
    if (!ledgerRef.current.buy(cost)) { toast("Not enough demo RF", "bad"); return; }
    worldRef.current.burned += cost;
    setOwned(o => new Set(o).add(id));
    if (kind === "skin") setSkin(id); else setTrail(id);
    audioRef.current?.unlock();
    audioRef.current?.burn();
    toast(`Burned ${price} RF · ${kind === "skin" ? "skin" : "trail"} unlocked`, "good");
  }

  /** Per-frame DOM writes (no React churn). */
  function paintHud() {
    const r = roundRef.current;
    const el = multRef.current;
    if (el) {
      if (r.phase === "boarding") {
        el.textContent = "";
      } else {
        const m = r.phase === "crashed" ? r.crashPoint : r.multiplier;
        el.textContent = `${floorMult(m).toFixed(2)}x`;
        el.dataset.tone = r.phase === "crashed" ? "crash" : multClass(m);
      }
    }
    if (timerRef.current) timerRef.current.textContent = Math.max(0, BOARDING_S - r.phaseT).toFixed(1);
    if (cashRef.current && r.bet && r.status === "riding") {
      cashRef.current.textContent = rf(payoutOf(r.bet.riding, r.multiplier));
    }
  }

  const stakePreview = useMemo(() => {
    const s = parseRf(stakeText);
    return s === null ? null : { stake: s, fuel: fuelOf(s), riding: s - fuelOf(s) };
  }, [stakeText]);

  // ---- render ----
  if (error) {
    return (
      <div className="ms-loading" role="alert">
        <p>{error}</p>
        <button type="button" onClick={() => window.location.reload()}>Retry</button>
      </div>
    );
  }
  if (!ready) {
    return <div className="ms-loading" role="status"><div className="ms-loading-mark" aria-hidden="true"><i /><i /><i /><i /></div><p>Fueling the rocket…</p></div>;
  }

  const r = roundRef.current;
  const ledger = ledgerRef.current;
  const st: PlayerStats = ledger.stats;
  const reserved = reservedRef.current;
  const world = worldRef.current;
  const riding = r.phase === "flying" && r.status === "riding";
  const pilotRows = pilot?.frames[0];
  const netPl = ledger.balance + (reserved ?? 0n) - STARTING_BALANCE + st.hangarBurned;
  const crewAboard = r.crew.filter(c => c.status !== "boarding").length;
  const minutes = Math.max(0.25, (Date.now() - world.started) / 60000);
  const burnRate = (world.burned * 100n) / BigInt(Math.round(minutes * 100));

  let primaryLabel: ReactNode;
  let primaryClass = "ms-go";
  if (riding) {
    primaryLabel = <><small>CASH OUT</small><span ref={cashRef}>{r.bet ? rf(payoutOf(r.bet.riding, r.multiplier)) : ""}</span></>;
    primaryClass = "ms-go ms-go-cash";
  } else if (reserved !== null) {
    primaryLabel = <><small>{r.phase === "boarding" ? "YOU'RE BOARDING" : "BOOKED FOR NEXT LAUNCH"}</small><span>Cancel · {rf(reserved)}</span></>;
    primaryClass = "ms-go ms-go-booked";
  } else {
    primaryLabel = <><small>{r.phase === "boarding" ? "JOIN THIS LAUNCH" : "BOOK NEXT LAUNCH"}</small><span>Bet {stakePreview ? rf(stakePreview.stake) : "—"}</span></>;
  }

  return (
    <section className={reduced ? "ms-root ms-reduced" : "ms-root"} aria-label="Moonshot" aria-busy={paused}>
      <header className="ms-top">
        <div className="ms-brand">
          <span className="ms-logo" aria-hidden="true" />
          <strong>MOONSHOT</strong>
          <span className="ms-demo" title="All RF in this preview is simulated">DEMO RF</span>
        </div>
        <div className="ms-hist" aria-label="Recent crash points">
          {history.length === 0 && <span className="ms-hist-empty">first launch incoming…</span>}
          {history.map((c, i) => <span key={`${history.length - i}`} className={`ms-hp ms-${multClass(c)}`}>{c.toFixed(2)}x</span>)}
        </div>
        <div className="ms-furnace" title="RF burned this session by every pilot (simulated): fuel + hangar">
          <span className="ms-flame" aria-hidden="true" />
          <span className="ms-furnace-label">BURNED</span>
          <strong>{fmtRf(world.burned)}</strong>
        </div>
        <div className="ms-bal"><span>BALANCE</span><strong>{fmtRf(ledger.balance)}</strong></div>
        <div className="ms-icons">
          <button type="button" aria-pressed={!muted} aria-label={muted ? "Sound on" : "Sound off"} onClick={toggleMute}>{muted ? "🔇" : "🔊"}</button>
          <button type="button" aria-pressed={reduced} aria-label="Reduce motion" title="Reduce motion"
            onClick={() => { const n = !reduced; setReduced(n); sceneRef.current?.setReducedMotion(n); }}>{reduced ? "◐" : "◑"}</button>
        </div>
      </header>

      <div className="ms-main">
        <aside className="ms-bet" aria-label="Your bet">
          <div className="ms-pilot">
            {pilotRows && <img src={avatar("me", pilotRows)} alt="" className="ms-av ms-av-lg" />}
            <div>
              <strong>Friend #{friendId.toString()}</strong>
              <span>{pilot ? `${FAMILY_NAMES[pilot.familyId] ?? "Friend"} · pilot${pilot.fallback ? " (art offline)" : ""}` : "loading pilot…"}</span>
            </div>
          </div>

          <label className="ms-field">
            <span className="ms-eyebrow">Stake <em>RF</em></span>
            <div className="ms-stake">
              <button type="button" aria-label="Halve stake" onClick={() => { const s = parseRf(stakeText); if (s) setStakeText(fmtRf(s / 2n > MIN_STAKE ? s / 2n : MIN_STAKE).replace(/,/g, "")); }}>½</button>
              <input inputMode="decimal" aria-label="Stake in RF" value={stakeText}
                onChange={e => setStakeText(e.target.value.replace(/[^0-9.]/g, "").slice(0, 9))} disabled={autoBet} />
              <button type="button" aria-label="Double stake" onClick={() => { const s = parseRf(stakeText); if (s) setStakeText(fmtRf(s * 2n).replace(/,/g, "")); }}>2×</button>
            </div>
          </label>
          <div className="ms-chips">
            {PRESETS.map(p => (
              <button key={p} type="button" className={stakeText === p ? "on" : ""} disabled={autoBet} onClick={() => { setStakeText(p); audioRef.current?.tick(620); }}>{p}</button>
            ))}
          </div>
          {stakePreview && (
            <p className="ms-fuel"><b>{fmtRf(stakePreview.fuel)} RF</b> burns as fuel · {fmtRf(stakePreview.riding)} rides</p>
          )}

          <button type="button" className={primaryClass} onClick={primary} disabled={paused}>
            {primaryLabel}
          </button>
          {message && <p className="ms-msg" role="status">{message}</p>}

          <div className="ms-auto">
            <label className="ms-toggle">
              <input type="checkbox" checked={autoCash} onChange={e => setAutoCash(e.target.checked)} />
              <span>Auto eject at</span>
              <input className="ms-mini" inputMode="decimal" aria-label="Auto eject multiplier" value={autoCashText}
                onChange={e => setAutoCashText(e.target.value.replace(/[^0-9.]/g, "").slice(0, 7))} />
              <em>x</em>
            </label>
            <div className="ms-toggle">
              <button type="button" className={autoBet ? "ms-autobet on" : "ms-autobet"} onClick={toggleAutoBet} aria-pressed={autoBet}>
                {autoBet ? "■ Stop auto-launch" : "▶ Auto-launch"}
              </button>
              <select aria-label="Auto-launch rounds" value={autoBetRounds} disabled={autoBet}
                onChange={e => setAutoBetRounds(Number(e.target.value))}>
                {[5, 10, 25, 50].map(n => <option key={n} value={n}>{n} rounds</option>)}
                <option value={0}>∞</option>
              </select>
            </div>
            {autoBet && <p className="ms-autonote">{autoRef.current.betLeft < 0 ? "Launching every round" : `${autoRef.current.betLeft} more launches queued`}</p>}
          </div>
          <div className="ms-burncard" aria-label="Burn meter">
            <div className="ms-burnhead">
              <span className="ms-flame" aria-hidden="true" />
              <span>FURNACE</span>
              <em>{fmtRf(burnRate)} RF/min</em>
            </div>
            <strong>{fmtRf(world.burned)} <small>RF burned</small></strong>
            <div className="ms-bars" aria-hidden="true">
              {Array.from({ length: 16 }, (_, i) => {
                const v = world.perLaunch[world.perLaunch.length - 16 + i];
                const max = Math.max(1, ...world.perLaunch);
                return <span key={i} style={{ height: v === undefined ? "2px" : `${Math.max(3, (v / max) * 100)}%` }} className={v === undefined ? "e" : ""} />;
              })}
            </div>
            <p>Fuel per launch · all pilots · simulated</p>
          </div>
          <p className="ms-keys">Space: bet / eject · M: sound</p>
        </aside>

        <div className="ms-stage">
          <canvas ref={canvasRef} className="ms-canvas" onPointerDown={() => { if (riding) cashOut(); }} />
          <div className="ms-hud">
            {r.phase === "boarding" ? (
              <div className="ms-count">
                <small>LAUNCH IN</small>
                <span ref={timerRef}>{Math.max(0, BOARDING_S - r.phaseT).toFixed(1)}</span>
                <small>{crewAboard} crew aboard{reserved !== null ? " + you" : ""}</small>
              </div>
            ) : (
              <div ref={multRef} className="ms-mult" data-tone="lo" aria-live="off">1.00x</div>
            )}
            <div className="ms-toasts" aria-live="polite">
              {toasts.map(t => <div key={t.id} className={`ms-toast ms-toast-${t.kind}`}>{t.text}</div>)}
            </div>
          </div>
          {banner && r.phase === "crashed" && (
            <div className={`ms-banner ms-banner-${banner.kind}`} role="status">
              <div className="ms-banner-bar"><span>Launch #{r.n}</span><span>{r.crew.length} crew</span></div>
              <strong>{banner.title}</strong>
              <span className="ms-banner-sub">{banner.sub}</span>
            </div>
          )}
          {riding && <div className="ms-tapnote">tap the sky to eject</div>}
        </div>

        <aside className="ms-side">
          <div className="ms-tabs" role="tablist">
            {(["crew", "hangar", "stats"] as Tab[]).map(t => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                {t === "crew" ? `Crew ${r.crew.length + (r.bet || reserved !== null ? 1 : 0)}` : t === "hangar" ? "Hangar" : "Stats"}
              </button>
            ))}
          </div>

          {tab === "crew" && (
            <div className="ms-panel">
              <ul className="ms-crew">
                {(r.bet || reserved !== null) && (
                  <li className={`me st-${r.status === "none" ? "booked" : r.status}`}>
                    {pilotRows && <img src={avatar("me", pilotRows)} alt="" className="ms-av" />}
                    <span className="nm">You</span>
                    <span className="stk">{rf(r.bet?.stake ?? reserved ?? 0n)}</span>
                    <span className="res">
                      {r.status === "ejected" && `${r.cashedAt?.toFixed(2)}x`}
                      {r.status === "burned" && "BURN"}
                      {r.status === "riding" && "aboard"}
                      {r.status === "none" && "boarding"}
                    </span>
                  </li>
                )}
                {r.crew.map(c => (
                  <li key={c.friend.id} className={`st-${c.status}`}>
                    <img src={avatar(`c${c.friend.id}`, c.friend.frames[0], c.status === "burned" ? "#ED927E" : "#000000")} alt="" className="ms-av" style={{ borderColor: FAMILY_COLORS[c.friend.familyId] }} />
                    <span className="nm">#{c.friend.id}</span>
                    <span className="stk">{fmtRf(c.stake)}</span>
                    <span className="res">
                      {c.status === "boarding" && "…"}
                      {c.status === "riding" && (r.phase === "boarding" ? "seated" : "aboard")}
                      {c.status === "ejected" && `${c.cashedAt?.toFixed(2)}x`}
                      {c.status === "burned" && "BURN"}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="ms-roundfoot">
                <div><span>Fuel burned this launch</span><strong>{r.phase === "boarding" ? "—" : rf(r.fuelBurned)}</strong></div>
                <div><span>Lost to Launch Pool</span><strong>{r.phase === "crashed" ? rf(r.pool) : "—"}</strong></div>
                <p>Crew are real Generations Friends with simulated stakes.</p>
              </div>
            </div>
          )}

          {tab === "hangar" && (
            <div className="ms-panel ms-hangar">
              <p className="ms-hnote">Cosmetics are paid in RF and <b>burned 100%</b>. Looks only — odds never change.</p>
              <h4>Rocket</h4>
              <div className="ms-grid">
                {SKINS.map(s => (
                  <button key={s.id} type="button" className={`ms-item ${skin === s.id ? "eq" : ""} ${confirmBuy === s.id ? "confirm" : ""}`} onClick={() => buy("skin", s.id, s.price)}>
                    <span className="sw" style={{ background: `linear-gradient(90deg, ${s.body} 0 60%, ${s.trim} 60% 80%, ${s.nose} 80%)` }} />
                    <span className="nm">{s.name}</span>
                    <span className="pr">{skin === s.id ? "equipped" : owned.has(s.id) ? "equip" : confirmBuy === s.id ? `burn ${s.price} RF?` : `${s.price} RF`}</span>
                  </button>
                ))}
              </div>
              <h4>Exhaust trail</h4>
              <div className="ms-grid">
                {TRAILS.map(t => (
                  <button key={t.id} type="button" className={`ms-item ${trail === t.id ? "eq" : ""} ${confirmBuy === t.id ? "confirm" : ""}`} onClick={() => buy("trail", t.id, t.price)}>
                    <span className="sw" style={{ background: `linear-gradient(90deg, ${t.flame[0]} 0 33%, ${t.flame[1]} 33% 66%, ${t.flame[2]} 66%)` }} />
                    <span className="nm">{t.name}</span>
                    <span className="pr">{trail === t.id ? "equipped" : owned.has(t.id) ? "equip" : confirmBuy === t.id ? `burn ${t.price} RF?` : `${t.price} RF`}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {tab === "stats" && (
            <div className="ms-panel ms-stats">
              <dl>
                <div><dt>Launches flown</dt><dd>{st.rounds}</dd></div>
                <div><dt>RF staked</dt><dd>{fmtRf(st.volume)}</dd></div>
                <div><dt>You burned (fuel)</dt><dd className="fire">{fmtRf(st.fuelBurned)}</dd></div>
                <div><dt>You burned (hangar)</dt><dd className="fire">{fmtRf(st.hangarBurned)}</dd></div>
                <div><dt>Ejections</dt><dd>{st.wins} / {st.rounds}</dd></div>
                <div><dt>Best eject</dt><dd>{st.bestCashout ? `${st.bestCashout.toFixed(2)}x` : "—"}</dd></div>
                <div><dt>Biggest win</dt><dd>{fmtRf(st.biggestWin)}</dd></div>
                <div><dt>Net (excl. hangar)</dt><dd className={netPl >= 0n ? "up" : "down"}>{netPl >= 0n ? "+" : ""}{fmtRf(netPl)}</dd></div>
              </dl>
              <h4>All pilots this session</h4>
              <dl>
                <div><dt>Launches</dt><dd>{world.launches}</dd></div>
                <div><dt>RF volume</dt><dd>{fmtRf(world.volume)}</dd></div>
                <div><dt>RF burned</dt><dd className="fire">{fmtRf(world.burned)}</dd></div>
              </dl>
              <h4>The math</h4>
              <p>Every launch burns <b>10% of each stake as fuel</b>. The other 90% rides a fair curve: P(crash ≥ m) = 1/m, so ejecting at any target returns 90% on average. The house keeps nothing; the whole edge is burned. Riders aboard at the crash lose their ride to the Launch Pool, which pays everyone who ejected. m(t) = e<sup>0.12t</sup>.</p>
              <p className="ms-sim">All RF here is simulated demo RF. Reloading starts a new session.</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
