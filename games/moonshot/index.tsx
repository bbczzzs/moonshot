"use client";

import { useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { formatGameAmount } from "@rarefriends/friendsdk/ui";
import {
  Ledger,
  drawCrashPoint,
  multiplierAt,
  crashTimeSeconds,
  cashOutValue,
  ONE_RF,
  STARTING_BALANCE,
  type RoundRecord,
} from "./economy";
import { MoonshotAudio } from "./audio";
import { MoonshotScene, type FrameState } from "./scene";
import { loadFriendPilot, type PilotSprite } from "./pilot";
import "./style.css";

type Phase = "idle" | "countdown" | "flying" | "cashed" | "crashed";

const STAKE_PRESETS = [10n, 25n, 50n, 100n];
const COUNTDOWN_S = 3;
const SLOWMO_AT = 5;

const rf = (value: bigint) => `${formatGameAmount(value, 18)} RF`;

/**
 * Moonshot — a crash-style multiplier game for the Rare Friends Vibeathon.
 * The SDK runtime supplies wallet connection, Friend selection and the
 * ownership gate. The RF economy here is a simulated demo ledger in game
 * state (labeled as such everywhere); the crash math lives in economy.ts.
 */
export default function Moonshot({ friendId, client, paused }: GameComponentProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const multRef = useRef<HTMLSpanElement | null>(null);
  const sceneRef = useRef<MoonshotScene | null>(null);
  const audioRef = useRef<MoonshotAudio | null>(null);
  const ledgerRef = useRef<Ledger | null>(null);
  const pausedRef = useRef(paused);
  const epoch = useRef(0);
  const pilotEpoch = useRef(0);
  const pilotRef = useRef<PilotSprite | null>(null);
  const stakeInputRef = useRef("10");

  // Hot-loop mutable state (refs avoid re-render churn at 60fps).
  const sim = useRef({
    phase: "idle" as Phase,
    countdown: 0,
    flightT: 0,
    multiplier: 1,
    crashPoint: 1,
    stake: 10n * ONE_RF,
    resultT: 0,
    cashedAt: null as number | null,
    lastBeep: 4,
    slowmoDone: false,
    slowmoUntil: 0,
    lastFrame: 0,
  });

  // UI state (updated on transitions only).
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [balance, setBalance] = useState<bigint>(STARTING_BALANCE);
  const [stakeInput, setStakeInput] = useState("10");
  const [message, setMessage] = useState("Simulated demo RF — no real funds move.");
  const [history, setHistory] = useState<number[]>([]);
  const [stats, setStats] = useState(() => new Ledger().stats);
  const [lastResult, setLastResult] = useState<{ kind: "win" | "burn"; text: string } | null>(null);
  const [muted, setMuted] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [slowmoFlash, setSlowmoFlash] = useState(false);

  const modeLabel = client.mode === "preview" ? "Preview · Demo RF" : "Chain";

  const syncUi = () => {
    const ledger = ledgerRef.current;
    if (!ledger) return;
    setBalance(ledger.balance);
    setStats({ ...ledger.stats });
    setPhase(sim.current.phase);
  };

  // ---- lifecycle ----
  // The pilot is the player's ACTUAL selected Friend: its canonical on-chain
  // 16x16 sprite, voxel-rendered in the scene. This never blocks the session
  // handshake — if the chain read is unavailable, a deterministic generative
  // pixel pilot is used instead.
  useEffect(() => {
    const version = ++pilotEpoch.current;
    pilotRef.current = null;
    sceneRef.current?.setPilot(null);
    loadFriendPilot(friendId).then((pilot) => {
      if (version !== pilotEpoch.current) return;
      pilotRef.current = pilot;
      sceneRef.current?.setPilot(pilot);
    });
    return () => {
      pilotEpoch.current++;
    };
  }, [friendId]);

  // Session handshake first: the runtime only marks the game ready (and hides
  // its loading state) once the child calls client.read(). This must NOT wait
  // for the canvas — the canvas only exists after `ready` flips true.
  useEffect(() => {
    const version = ++epoch.current;
    setReady(false);
    setError("");
    // Required: let the runtime finish its loading state even though the
    // crash game does not use the chance-game economy actions.
    void client
      .read()
      .then(() => {
        if (version === epoch.current) setReady(true);
      })
      .catch((cause: unknown) => {
        if (version === epoch.current) {
          setError(cause instanceof Error ? cause.message : "Could not load the game session.");
        }
      });
    return () => {
      epoch.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, friendId]);

  // Scene + simulation setup. Runs once the canvas exists (after ready).
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = new MoonshotScene(canvas);
    const audio = new MoonshotAudio();
    const ledger = new Ledger();
    sceneRef.current = scene;
    audioRef.current = audio;
    ledgerRef.current = ledger;
    if (pilotRef.current) scene.setPilot(pilotRef.current);
    sim.current.stake = 10n * ONE_RF;
    setBalance(ledger.balance);
    setStats({ ...ledger.stats });
    setPhase("idle");
    sim.current.phase = "idle";
    setLastResult(null);
    setHistory([]);

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotion = () => {
      const b = mq.matches;
      setReducedMotion(b);
      scene.setReducedMotion(b);
    };
    onMotion();
    mq.addEventListener("change", onMotion);

    const ro = new ResizeObserver(() => scene.resize());
    ro.observe(canvas);

    let raf = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (cancelled || pausedRef.current) return;
      const s = sim.current;
      let dt = Math.min(0.05, (now - (s.lastFrame || now)) / 1000);
      s.lastFrame = now;

      if (s.phase === "countdown") {
        s.countdown -= dt;
        const n = Math.ceil(s.countdown);
        if (n < s.lastBeep && n >= 1) {
          s.lastBeep = n;
          audio.countdownBeep(n === 1);
        }
        if (s.countdown <= 0) {
          s.phase = "flying";
          s.flightT = 0;
          s.multiplier = 1;
          s.slowmoDone = false;
          audio.launchRumble();
          audio.climbStart();
          scene.addTrauma(0.45);
          setPhase("flying");
        }
      } else if (s.phase === "flying") {
        const slowmo = now < s.slowmoUntil;
        const scaled = dt * (slowmo ? 0.35 : 1);
        s.flightT += scaled;
        s.multiplier = multiplierAt(s.crashPoint, s.flightT);
        audio.climbSet(s.multiplier);
        if (multRef.current) {
          multRef.current.textContent = `${s.multiplier.toFixed(2)}x`;
          multRef.current.style.color = s.multiplier < 2 ? "#38e1ff" : s.multiplier < 5 ? "#ffd23f" : "#ff6a4d";
        }
        if (!s.slowmoDone && s.multiplier >= SLOWMO_AT) {
          s.slowmoDone = true;
          s.slowmoUntil = now + 650;
          setSlowmoFlash(true);
          window.setTimeout(() => {
            if (!cancelled) setSlowmoFlash(false);
          }, 700);
        }
        if (s.flightT >= crashTimeSeconds(s.crashPoint)) {
          doCrash();
        }
      } else if (s.phase === "cashed" || s.phase === "crashed") {
        s.resultT += dt;
      }

      const frame: FrameState = {
        phase: s.phase,
        countdown: Math.max(0, s.countdown),
        flightT: s.flightT,
        multiplier: s.multiplier,
        crashPoint: s.crashPoint,
        resultT: s.resultT,
        cashedAt: s.cashedAt,
      };
      scene.frame(frame, dt);
    };
    raf = requestAnimationFrame(loop);

    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      event.preventDefault();
      if (pausedRef.current) return;
      primaryAction();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      mq.removeEventListener("change", onMotion);
      window.removeEventListener("keydown", onKey);
      audio.dispose();
      sceneRef.current = null;
      audioRef.current = null;
      ledgerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Mirror the runtime pause flag without tearing down the session: opening a
  // runtime menu mid-flight must freeze the round, never forfeit the stake.
  useEffect(() => {
    pausedRef.current = paused;
    const audio = audioRef.current;
    if (audio) audio.setPaused(paused);
  }, [paused]);

  useEffect(() => {
    stakeInputRef.current = stakeInput;
  }, [stakeInput]);

  // ---- actions ----
  function parseStake(): bigint | null {
    const n = Math.floor(Number(stakeInputRef.current));
    if (!Number.isFinite(n) || n < 1) return null;
    return BigInt(n) * ONE_RF;
  }

  function resetMultDom() {
    if (multRef.current) {
      multRef.current.textContent = "1.00x";
      multRef.current.style.color = "#38e1ff";
    }
  }

  function launch() {
    const s = sim.current;
    const ledger = ledgerRef.current;
    const audio = audioRef.current;
    if (!ledger || !audio || s.phase !== "idle" || pausedRef.current) return;
    const stake = parseStake();
    if (stake === null) {
      setMessage("Enter a stake of at least 1 RF.");
      return;
    }
    if (!ledger.stake(stake)) {
      setMessage(`Not enough demo RF — balance is ${rf(ledger.balance)}.`);
      return;
    }
    audio.unlock();
    audio.tick(520);
    s.stake = stake;
    s.crashPoint = drawCrashPoint();
    s.phase = "countdown";
    s.countdown = COUNTDOWN_S;
    s.resultT = 0;
    s.cashedAt = null;
    s.lastBeep = 4;
    s.flightT = 0;
    s.multiplier = 1;
    resetMultDom();
    setLastResult(null);
    setMessage("Simulated demo RF — no real funds move.");
    syncUi();
  }

  function cashOut() {
    const s = sim.current;
    const ledger = ledgerRef.current;
    const audio = audioRef.current;
    if (!ledger || !audio || s.phase !== "flying" || pausedRef.current) return;
    const m = multiplierAt(s.crashPoint, s.flightT);
    const payout = cashOutValue(s.stake, m);
    const record: RoundRecord = { stake: s.stake, crashPoint: s.crashPoint, cashedAt: m, payout };
    ledger.settle(record);
    s.phase = "cashed";
    s.resultT = 0;
    s.cashedAt = m;
    s.multiplier = m;
    audio.cashOut();
    const profit = payout - s.stake;
    setLastResult({ kind: "win", text: `Cashed out ${m.toFixed(2)}x · +${rf(profit)}` });
    setHistory(h => [s.crashPoint, ...h].slice(0, 12));
    syncUi();
  }

  function doCrash() {
    const s = sim.current;
    const ledger = ledgerRef.current;
    const audio = audioRef.current;
    if (!ledger || !audio || s.phase !== "flying") return;
    const record: RoundRecord = { stake: s.stake, crashPoint: s.crashPoint, cashedAt: null, payout: 0n };
    ledger.settle(record);
    s.phase = "crashed";
    s.resultT = 0;
    s.multiplier = s.crashPoint;
    if (multRef.current) {
      multRef.current.textContent = `${s.crashPoint.toFixed(2)}x`;
      multRef.current.style.color = "#ff4d5e";
    }
    audio.crash();
    setLastResult({ kind: "burn", text: `Crashed at ${s.crashPoint.toFixed(2)}x · burned ${rf(s.stake)}` });
    setHistory(h => [s.crashPoint, ...h].slice(0, 12));
    syncUi();
  }

  function flyAgain() {
    const s = sim.current;
    if (s.phase !== "cashed" && s.phase !== "crashed") return;
    audioRef.current?.tick(440);
    s.phase = "idle";
    s.resultT = 0;
    s.cashedAt = null;
    s.multiplier = 1;
    resetMultDom();
    setLastResult(null);
    setPhase("idle");
  }

  function primaryAction() {
    const p = sim.current.phase;
    if (p === "idle") launch();
    else if (p === "flying") cashOut();
    else if (p === "cashed" || p === "crashed") flyAgain();
  }

  const toggleMute = () => {
    const audio = audioRef.current;
    const next = !muted;
    setMuted(next);
    audio?.unlock();
    audio?.setMuted(next);
    if (!next) audio?.tick(660);
  };

  const toggleMotion = () => {
    const next = !reducedMotion;
    setReducedMotion(next);
    sceneRef.current?.setReducedMotion(next);
  };

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
    return (
      <div className="ms-loading" role="status">
        <p>Fueling the rocket…</p>
      </div>
    );
  }

  const canLaunch = phase === "idle" && !paused;
  const flying = phase === "flying";

  return (
    <section className={reducedMotion ? "ms-root ms-reduced-motion" : "ms-root"} aria-label="Moonshot" aria-busy={paused}>
      <header className="ms-topbar">
        <div className="ms-brand">
          <span className="ms-logo" aria-hidden="true">🚀</span>
          <strong>MOONSHOT</strong>
          <span className="ms-mode">{modeLabel}</span>
        </div>
        <div className="ms-top-actions">
          <span className="ms-pilot" title="Verified selected Friend">Pilot · Friend #{friendId.toString()}</span>
          <button type="button" aria-pressed={!muted} onClick={toggleMute} title="Toggle sound">
            {muted ? "🔇" : "🔊"}
          </button>
          <button type="button" aria-pressed={reducedMotion} onClick={toggleMotion} title="Reduce motion">
            {reducedMotion ? "◐" : "◑"}
          </button>
        </div>
      </header>

      <div className="ms-stage">
        <canvas ref={canvasRef} className="ms-canvas" onClick={() => flying && cashOut()} />
        <div className="ms-mult-wrap" aria-live="polite">
          <span ref={multRef} className="ms-mult">1.00x</span>
          {slowmoFlash && <span className="ms-slowmo">5x — HOLD ON!</span>}
        </div>
        <div className="ms-balances">
          <span>Balance · <strong>{rf(balance)}</strong></span>
          <span className="ms-burned" key={stats.totalBurned.toString()}>🔥 Burned · <strong>{rf(stats.totalBurned)}</strong></span>
        </div>
      </div>

      <div className="ms-controls">
        {phase === "idle" && (
          <>
            <div className="ms-stakes" role="group" aria-label="Stake amount in RF">
              {STAKE_PRESETS.map(v => {
                const n = v.toString();
                return (
                  <button
                    key={n}
                    type="button"
                    className={stakeInput === n ? "ms-chip ms-chip-active" : "ms-chip"}
                    disabled={paused}
                    onClick={() => { setStakeInput(n); audioRef.current?.tick(600); }}
                  >
                    {n}
                  </button>
                );
              })}
              <input
                className="ms-stake-input"
                inputMode="numeric"
                aria-label="Custom stake in RF"
                value={stakeInput}
                disabled={paused}
                onChange={e => setStakeInput(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
              />
            </div>
            <button type="button" className="ms-primary" disabled={!canLaunch} onClick={launch}>
              LAUNCH · {stakeInput || "0"} RF
            </button>
          </>
        )}
        {flying && (
          <button type="button" className="ms-primary ms-cashout" onClick={cashOut}>
            CASH OUT
          </button>
        )}
        {(phase === "cashed" || phase === "crashed") && (
          <button type="button" className="ms-primary" onClick={flyAgain}>
            FLY AGAIN
          </button>
        )}
        {phase === "countdown" && <div className="ms-wait">Ignition…</div>}
        {lastResult && (
          <p role="status" className={lastResult.kind === "win" ? "ms-result ms-win" : "ms-result ms-burn"}>
            {lastResult.text}
          </p>
        )}
        <p className="ms-message">{message}</p>
        <p className="ms-hint">Space = launch / cash out · Tap the sky to cash out</p>
      </div>

      <div className="ms-panels">
        <div className="ms-panel" aria-label="Recent crash points">
          <h3>Recent flights</h3>
          <div className="ms-history">
            {history.length === 0 && <span className="ms-empty">No flights yet — be the first.</span>}
            {history.map((c, i) => (
              <span key={`${i}-${c}`} className={c >= 2 ? "ms-pill ms-pill-green" : "ms-pill ms-pill-red"}>
                {c.toFixed(2)}x
              </span>
            ))}
          </div>
        </div>
        <div className="ms-panel" aria-label="Session stats">
          <h3>Session activity</h3>
          <dl className="ms-stats">
            <div><dt>Rounds</dt><dd>{stats.rounds}</dd></div>
            <div><dt>Staked</dt><dd>{rf(stats.totalStaked)}</dd></div>
            <div><dt>Burned</dt><dd>{rf(stats.totalBurned)}</dd></div>
            <div><dt>Biggest win</dt><dd>{rf(stats.biggestWin)}</dd></div>
            <div><dt>Best ride</dt><dd>{stats.biggestMultiplier.toFixed(2)}x</dd></div>
          </dl>
        </div>
      </div>

      <footer className="ms-foot">
        <p>
          Crash point: 3% instant bust · 3% house edge · m(t) = e<sup>0.1t</sup>.
          All RF is simulated demo RF. Reloading starts a new session.
        </p>
      </footer>
    </section>
  );
}
