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
  rankOf,
  toRf,
  RANKS,
  ONE_RF,
  MIN_STAKE,
  FUEL_BPS,
  NOVA_FUEL_BPS,
  NOVA_EVERY,
  CAN_PRICE,
  GLORY_BPS,
  type Bet,
} from "./economy";
import { makeCrew, mulberry32, ROSTER, FAMILY_NAMES, FAMILY_COLORS, type CrewMember, type SpriteRows } from "./crew";
import { SKINS, TRAILS } from "./looks";
import { MoonshotAudio } from "./audio";
import { MoonshotScene, spriteCanvas, type SceneCrew } from "./scene";
import { loadPilot, type PilotSprite } from "./pilot";
import "./style.css";

type Phase = "boarding" | "flying" | "crashed";
type PlayerStatus = "none" | "riding" | "ejected" | "burned";
type Tab = "crew" | "flames" | "hangar";

const BOARDING_S = 6;
const AFTERMATH_S = 3.4;
const PRESETS = ["5", "10", "25", "50", "100"];
const CROWD_CANS_PER_S = 0.9; // simulated crowd fuel cans during a flight
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
  supernova: boolean;
  crew: CrewMember[];
  bet: Bet | null; // player's ignited bet this round
  status: PlayerStatus;
  cashedAt: number | null;
  payout: bigint;
  milestone: number;
  burned: bigint; // everything burned this launch (fuel + cans + glory)
  pool: bigint; // riding RF lost to the Launch Pool this round
  myCans: number;
}

interface World {
  burned: bigint; // all pilots, this session (simulated crowd included)
  novaMeter: bigint; // burn collected toward the next Supernova
  launches: number;
  started: number; // ms, for the burn rate
  hall: Map<number, number>; // crew Friend id -> RF burned this session (simulated)
}

interface Toast { id: number; text: string; kind: "good" | "bad" | "info" | "nova"; }

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

const sceneCrewOf = (c: CrewMember): SceneCrew =>
  ({ id: c.friend.id, frames: c.friend.frames, familyId: c.friend.familyId, seat: c.seat, joinedT: 9 });

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
  const worldRef = useRef<World>({ burned: 0n, novaMeter: 0n, launches: 0, started: Date.now(), hall: new Map() });
  const autoRef = useRef({ cash: false, cashAt: 2, bet: false, betLeft: 0 as number, stake: 10n * ONE_RF, glory: false });
  const xpRef = useRef(0);
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
  const [glory, setGlory] = useState(false);
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
      n, phase: "boarding", phaseT: 0, multiplier: 1, crashPoint: 1, supernova: false,
      crew: [], bet: null, status: "none", cashedAt: null, payout: 0n, milestone: 0,
      burned: 0n, pool: 0n, myCans: 0,
    };
  }

  function toast(text: string, kind: Toast["kind"] = "info") {
    const id = ++toastId.current;
    setToasts(t => [...t.slice(-1), { id, text, kind }]);
    window.setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2400);
  }

  /** Every burn flows through here: session furnace, Supernova meter and Flame XP. */
  function addBurn(amount: bigint, mine: boolean, xpMult = 1) {
    if (amount <= 0n) return;
    const w = worldRef.current;
    w.burned += amount;
    w.novaMeter += amount;
    roundRef.current.burned += amount;
    if (!mine) return;
    const before = rankOf(xpRef.current).index;
    xpRef.current += toRf(amount) * xpMult;
    const after = rankOf(xpRef.current);
    if (after.index > before) {
      toast(`Flame rank up · ${after.name}`, "nova");
      audioRef.current?.milestone();
    }
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
  useEffect(() => { autoRef.current.glory = glory; }, [glory]);
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
        .map(c => ({ ...sceneCrewOf(c), joinedT: r.phase === "boarding" ? r.phaseT - c.joinAt : 9 }));
      scene.frame({
        phase: r.phase, phaseT: r.phaseT, multiplier: r.multiplier, crew: sceneCrew,
        playerAboard: r.status === "riding" || (r.phase === "boarding" && reservedRef.current !== null),
        playerWatching: r.status === "none" && !(r.phase === "boarding" && reservedRef.current !== null),
        supernova: r.supernova,
      }, dt);
      paintHud();
      uiClock += dt;
      if (uiClock > 0.12) { uiClock = 0; rerender(); }
    };
    raf = requestAnimationFrame(loop);

    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      if (pausedRef.current) return;
      if (e.code === "Space") { e.preventDefault(); primary(); }
      else if (e.key === "f" || e.key === "F") throwCanAtRandom();
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
    const w = worldRef.current;
    if (w.novaMeter >= NOVA_EVERY) {
      w.novaMeter -= NOVA_EVERY;
      r.supernova = true;
      toast("SUPERNOVA LAUNCH · 20% fuel · 3× Flame XP", "nova");
    }
    roundRef.current = r;
    setBanner(null);
    rerender();
    const auto = autoRef.current;
    if (auto.bet && reservedRef.current === null) {
      const ledger = ledgerRef.current;
      if (auto.betLeft !== 0 && ledger.reserve(auto.stake)) {
        reservedRef.current = auto.stake;
        if (auto.betLeft > 0) auto.betLeft -= 1;
      } else {
        auto.bet = false;
        setAutoBet(false);
        toast(auto.betLeft === 0 ? "Auto-launch finished" : "Auto-launch stopped: not enough demo RF");
      }
    }
  }

  function step(dt: number) {
    const r = roundRef.current;
    const scene = sceneRef.current!;
    const audio = audioRef.current!;
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
      for (const c of r.crew) {
        const at = c.target === null ? Infinity : floorMult(c.target);
        if (c.status === "riding" && at <= m) {
          c.status = "ejected";
          c.cashedAt = at;
          c.payout = payoutOf(c.riding, at);
          scene.ejectCrew(sceneCrewOf(c), at);
          audio.eject();
        }
      }
      // The (simulated) crowd throws fuel cans at riders it is cheering on.
      if (randRef.current() < dt * CROWD_CANS_PER_S) {
        const riders = r.crew.filter(c => c.status === "riding");
        if (riders.length) {
          const target = riders[Math.floor(randRef.current() * riders.length)];
          const thrower = r.crew[Math.floor(randRef.current() * r.crew.length)];
          target.cans += 1;
          const hall = worldRef.current.hall;
          hall.set(thrower.friend.id, (hall.get(thrower.friend.id) ?? 0) + toRf(CAN_PRICE));
          addBurn(CAN_PRICE, false);
          scene.throwCan(target.seat, false);
        }
      }
      const auto = autoRef.current;
      if (r.status === "riding" && auto.cash && m >= auto.cashAt) cashOut(auto.cashAt);
      if (raw >= r.crashPoint) {
        crash(r);
        return;
      }
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
    const bps = r.supernova ? NOVA_FUEL_BPS : FUEL_BPS;
    r.phase = "flying";
    r.phaseT = 0;
    r.multiplier = 1;
    r.crashPoint = drawCrashPoint(randRef.current);
    // Crew who never made it aboard sit this one out.
    r.crew = r.crew.filter(c => c.status === "riding");
    const hall = worldRef.current.hall;
    for (const c of r.crew) {
      c.fuel = fuelOf(c.stake, bps);
      c.riding = c.stake - c.fuel;
      hall.set(c.friend.id, (hall.get(c.friend.id) ?? 0) + toRf(c.fuel));
      addBurn(c.fuel, false);
    }
    const stake = reservedRef.current;
    reservedRef.current = null;
    if (stake !== null) {
      r.bet = ledger.ignite(stake, bps);
      r.status = "riding";
      addBurn(r.bet.fuel, true, r.supernova ? 3 : 1);
    }
    worldRef.current.launches += 1;
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
    scene.crash(aboard.map(sceneCrewOf), playerAboard);
    audio.crash();
    r.phase = "crashed";
    r.phaseT = 0;
    setHistory(h => [r.crashPoint, ...h].slice(0, 10));
    const title = `CRASHED @ ${r.crashPoint.toFixed(2)}x`;
    if (r.status === "burned" && r.bet) {
      setBanner({ title, sub: `Your ride of ${rf(r.bet.riding)} went to the Launch Pool`, kind: "burn" });
    } else if (r.status === "ejected" && r.bet) {
      setBanner({ title, sub: `You ejected at ${r.cashedAt?.toFixed(2)}x · ${rf(r.payout)}`, kind: "win" });
    } else {
      setBanner({ title, sub: `${rf(r.burned)} burned this launch`, kind: "info" });
    }
  }

  function cashOut(at?: number) {
    const r = roundRef.current;
    if (r.phase !== "flying" || r.status !== "riding" || !r.bet || pausedRef.current) return;
    const m = floorMult(at ?? r.multiplier);
    if (m < 1.01 || m > r.crashPoint) return;
    const withGlory = autoRef.current.glory;
    const gross = payoutOf(r.bet.riding, m);
    const payout = ledgerRef.current.cashOut(r.bet, m, withGlory);
    addBurn(gross - payout, true, 3);
    r.status = "ejected";
    r.cashedAt = m;
    r.payout = payout;
    sceneRef.current?.ejectPlayer(m);
    audioRef.current?.cashOut();
    toast(withGlory ? `Ejected ${m.toFixed(2)}x · ${rf(payout)} · burned ${rf(gross - payout)} for glory` : `Ejected ${m.toFixed(2)}x · ${rf(payout)}`, "good");
    rerender();
  }

  function throwCan(c: CrewMember) {
    const r = roundRef.current;
    if (r.phase !== "flying" || c.status !== "riding" || pausedRef.current) return;
    if (!ledgerRef.current.throwCan()) { toast("Not enough demo RF", "bad"); return; }
    c.cans += 1;
    c.myCans += 1;
    r.myCans += 1;
    addBurn(CAN_PRICE, true);
    sceneRef.current?.throwCan(c.seat, true);
    audioRef.current?.unlock();
    audioRef.current?.burn();
    rerender();
  }

  function throwCanAtRandom() {
    const riders = roundRef.current.crew.filter(c => c.status === "riding");
    if (riders.length) throwCan(riders[Math.floor(Math.random() * riders.length)]);
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
    addBurn(cost, true);
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
    if (el && r.phase !== "boarding") {
      const m = r.phase === "crashed" ? r.crashPoint : r.multiplier;
      el.textContent = `${floorMult(m).toFixed(2)}x`;
      el.dataset.tone = r.phase === "crashed" ? "crash" : multClass(m);
    }
    if (timerRef.current) timerRef.current.textContent = Math.max(0, BOARDING_S - r.phaseT).toFixed(1);
    if (cashRef.current && r.bet && r.status === "riding") {
      const gross = payoutOf(r.bet.riding, r.multiplier);
      cashRef.current.textContent = rf(autoRef.current.glory ? gross - (gross * GLORY_BPS) / 10000n : gross);
    }
  }

  const r = roundRef.current;
  const bps = r.supernova ? NOVA_FUEL_BPS : FUEL_BPS;
  const stakePreview = useMemo(() => {
    const s = parseRf(stakeText);
    return s === null ? null : { stake: s, fuel: fuelOf(s, bps), riding: s - fuelOf(s, bps) };
  }, [stakeText, bps]);

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

  const ledger = ledgerRef.current;
  const st = ledger.stats;
  const reserved = reservedRef.current;
  const world = worldRef.current;
  const riding = r.phase === "flying" && r.status === "riding";
  const pilotRows = pilot?.frames[0];
  const rank = rankOf(xpRef.current);
  const novaPct = Math.min(100, Number((world.novaMeter * 100n) / NOVA_EVERY));
  const minutes = Math.max(0.25, (Date.now() - world.started) / 60000);
  const burnRate = (world.burned * 100n) / BigInt(Math.round(minutes * 100));
  const me = { id: -1, name: "You", rf: toRf(ledger.totalBurned), rows: pilotRows, pos: 0 };
  const ranked = [
    me,
    ...[...world.hall].map(([id, v]) => ({ id, name: `#${id}`, rf: v, rows: ROSTER.find(f => f.id === id)?.frames[0], pos: 0 })),
  ].sort((a, b) => b.rf - a.rf).map((h, i) => ({ ...h, pos: i + 1 }));
  const hall = ranked.slice(0, 8);
  if (!hall.some(h => h.id === -1)) hall.push(ranked.find(h => h.id === -1)!);

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
    <section className={`ms-root${reduced ? " ms-reduced" : ""}${r.supernova ? " ms-nova" : ""}`} aria-label="Moonshot" aria-busy={paused}>
      <header className="ms-top">
        <div className="ms-brand">
          <span className="ms-logo" aria-hidden="true" />
          <strong>MOONSHOT</strong>
          <span className="ms-demo" title="All RF in this preview is simulated">DEMO RF</span>
        </div>
        <div className="ms-hist" aria-label="Recent crash points">
          {history.map((c, i) => <span key={`${history.length - i}`} className={`ms-hp ms-${multClass(c)}`}>{c.toFixed(2)}x</span>)}
        </div>
        <div className="ms-furnace" title="RF burned this session by every pilot (simulated), and progress to the next Supernova launch">
          <span className="ms-flame" aria-hidden="true" />
          <strong>{fmtRf(world.burned)}</strong>
          <span className="ms-furnace-label">burned</span>
          <span className="ms-nova-meter" aria-label={`Supernova ${novaPct}%`}><i style={{ width: `${novaPct}%` }} /></span>
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
              <span>{pilot ? `${FAMILY_NAMES[pilot.familyId] ?? "Friend"}${pilot.fallback ? " · art offline" : ""}` : "loading…"}</span>
            </div>
            <span className={`ms-rank ms-rank-${rank.index}`} title={`${Math.floor(xpRef.current)} Flame XP`}>{rank.name}</span>
          </div>

          <div className="ms-field">
            <span className="ms-eyebrow">Stake <em>RF</em></span>
            <div className="ms-stake">
              <button type="button" aria-label="Halve stake" onClick={() => { const s = parseRf(stakeText); if (s) setStakeText(fmtRf(s / 2n > MIN_STAKE ? s / 2n : MIN_STAKE).replace(/,/g, "")); }}>½</button>
              <input inputMode="decimal" aria-label="Stake in RF" value={stakeText}
                onChange={e => setStakeText(e.target.value.replace(/[^0-9.]/g, "").slice(0, 9))} disabled={autoBet} />
              <button type="button" aria-label="Double stake" onClick={() => { const s = parseRf(stakeText); if (s) setStakeText(fmtRf(s * 2n).replace(/,/g, "")); }}>2×</button>
            </div>
            <div className="ms-chips">
              {PRESETS.map(p => (
                <button key={p} type="button" className={stakeText === p ? "on" : ""} disabled={autoBet} onClick={() => { setStakeText(p); audioRef.current?.tick(620); }}>{p}</button>
              ))}
            </div>
          </div>

          <button type="button" className={primaryClass} onClick={primary} disabled={paused}>
            {primaryLabel}
          </button>
          {stakePreview && !riding && (
            <p className="ms-fuel"><b>{fmtRf(stakePreview.fuel)} RF</b> burns as fuel{r.supernova ? " (Supernova 20%)" : ""}</p>
          )}
          {message && <p className="ms-msg" role="status">{message}</p>}

          <div className="ms-opts" role="group" aria-label="Options">
            <label className="ms-opt">
              <input type="checkbox" checked={autoCash} onChange={e => setAutoCash(e.target.checked)} />
              <span>Auto eject</span>
              <input className="ms-mini" inputMode="decimal" aria-label="Auto eject multiplier" value={autoCashText}
                onChange={e => setAutoCashText(e.target.value.replace(/[^0-9.]/g, "").slice(0, 7))} />
            </label>
            <label className="ms-opt">
              <input type="checkbox" checked={autoBet} onChange={toggleAutoBet} aria-label="Auto-launch" />
              <span>Auto-launch</span>
              <select aria-label="Auto-launch rounds" value={autoBetRounds} disabled={autoBet}
                onChange={e => setAutoBetRounds(Number(e.target.value))}>
                {[5, 10, 25, 50].map(n => <option key={n} value={n}>{n}×</option>)}
                <option value={0}>∞</option>
              </select>
            </label>
            <label className="ms-opt" title="Burn 10% of every payout for 3× Flame XP">
              <input type="checkbox" checked={glory} onChange={e => setGlory(e.target.checked)} aria-label="Burn for glory" />
              <span>Burn for glory</span>
              <em>10% · 3× XP</em>
            </label>
          </div>
        </aside>

        <div className="ms-stage">
          <canvas ref={canvasRef} className="ms-canvas" onPointerDown={() => { if (riding) cashOut(); }} />
          <div className="ms-hud">
            {r.phase === "boarding" ? (
              <div className="ms-count">
                {r.supernova ? <small className="ms-nova-chip">SUPERNOVA LAUNCH</small> : <small>LAUNCH IN</small>}
                <span ref={timerRef}>{Math.max(0, BOARDING_S - r.phaseT).toFixed(1)}</span>
                <small>{crewAboard(r)} crew{reserved !== null ? " + you" : ""}{r.supernova ? " · 20% fuel · 3× XP" : ""}</small>
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
              <strong>{banner.title}</strong>
              <span className="ms-banner-sub">{banner.sub}</span>
            </div>
          )}
        </div>

        <aside className="ms-side">
          <div className="ms-tabs" role="tablist">
            {(["crew", "flames", "hangar"] as Tab[]).map(t => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                {t === "crew" ? "Crew" : t === "flames" ? "Flames" : "Hangar"}
              </button>
            ))}
          </div>

          {tab === "crew" && (
            <div className="ms-panel">
              {r.phase === "flying" && <p className="ms-tip">Throw a fuel can at a rider: <b>1 RF, burned</b>. Key F.</p>}
              <ul className="ms-crew">
                {(r.bet || reserved !== null) && (
                  <li className={`me st-${r.status === "none" ? "booked" : r.status}`}>
                    {pilotRows && <img src={avatar("me", pilotRows)} alt="" className="ms-av" />}
                    <span className="nm">You</span>
                    <span className="stk">{fmtRf(r.bet?.stake ?? reserved ?? 0n)}</span>
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
                    <span className="nm">#{c.friend.id}{c.cans > 0 && <i className="ms-cans" title={`${c.cans} fuel cans`}>🔥{c.cans}</i>}</span>
                    <span className="stk">{fmtRf(c.stake)}</span>
                    <span className="res">
                      {c.status === "riding" && r.phase === "flying" ? (
                        <button type="button" className="ms-can" onClick={() => throwCan(c)} aria-label={`Throw a fuel can at #${c.friend.id} (1 RF, burned)`}>+1 🔥</button>
                      ) : (
                        <>
                          {c.status === "boarding" && "…"}
                          {c.status === "riding" && "seated"}
                          {c.status === "ejected" && `${c.cashedAt?.toFixed(2)}x`}
                          {c.status === "burned" && "BURN"}
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="ms-roundfoot">{r.phase === "boarding" ? "Crew are real Generations Friends · simulated stakes" : <>Burned this launch <b>{rf(r.burned)}</b></>}</p>
            </div>
          )}

          {tab === "flames" && (
            <div className="ms-panel ms-flames">
              <div className="ms-rankcard">
                <span className={`ms-rank ms-rank-${rank.index}`}>{rank.name}</span>
                <strong>{Math.floor(xpRef.current)} <small>Flame XP</small></strong>
                <div className="ms-xpbar"><i style={{ width: `${Math.round(rank.progress * 100)}%` }} /></div>
                <small>{rank.next === null ? "Top rank" : `${Math.ceil(rank.next - xpRef.current)} XP to ${RANKS[rank.index + 1].name}`}</small>
              </div>
              <dl className="ms-receipt">
                <div><dt>Fuel</dt><dd>{fmtRf(st.fuelBurned)}</dd></div>
                <div><dt>Fuel cans</dt><dd>{fmtRf(st.canBurned)}</dd></div>
                <div><dt>Glory</dt><dd>{fmtRf(st.gloryBurned)}</dd></div>
                <div><dt>Hangar</dt><dd>{fmtRf(st.hangarBurned)}</dd></div>
                <div className="tot"><dt>You burned</dt><dd>{rf(ledger.totalBurned)}</dd></div>
              </dl>
              <div className="ms-novacard">
                <span>Next Supernova</span>
                <div className="ms-xpbar ms-xpbar-nova"><i style={{ width: `${novaPct}%` }} /></div>
                <small>{fmtRf(world.novaMeter)} / {fmtRf(NOVA_EVERY)} RF burned by all pilots · {fmtRf(burnRate)} RF/min</small>
              </div>
              <h4>Hall of Flames</h4>
              <ol className="ms-hall">
                {hall.map(h => (
                  <li key={h.id} className={h.id === -1 ? "me" : ""}>
                    <span className="pos">{h.pos}</span>
                    {h.rows ? <img src={avatar(h.id === -1 ? "me" : `c${h.id}`, h.rows)} alt="" className="ms-av" /> : <span className="ms-av" />}
                    <span className="nm">{h.name}</span>
                    <span className="v">{h.rf.toFixed(h.rf < 10 ? 2 : 0)}</span>
                  </li>
                ))}
              </ol>
              <p className="ms-sim">Simulated demo RF · crew burns simulated</p>
            </div>
          )}

          {tab === "hangar" && (
            <div className="ms-panel ms-hangar">
              <p className="ms-hnote">Paid in RF and <b>burned 100%</b>. Looks only.</p>
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
        </aside>
      </div>
    </section>
  );
}

function crewAboard(r: Round): number {
  return r.crew.filter(c => c.status !== "boarding").length;
}
