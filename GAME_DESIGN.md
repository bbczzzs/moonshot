# MOONSHOT — Game Design Document

A crash-style multiplier game for the Rare Friends Vibeathon.
**Category:** Token Activity · **Approach:** FriendSDK (official path, wallet + Friend selection via SDK)

## The fantasy
Your Rare Friend is a test pilot strapped into a chunky cartoon rocket. Stake RF, launch,
ride the multiplier as high as you dare, and cash out before the rocket crashes.
Crash = your stake burns. Every round is a 15-second movie.

## Core loop
1. Player starts with **1,000 demo RF** (simulated, clearly labeled everywhere as demo).
2. Pick a stake: 10 / 25 / 50 / 100 RF, or custom amount.
3. Hit **LAUNCH** → 3-2-1 countdown → liftoff.
4. Multiplier climbs from 1.00x. The rocket's comet trail draws the curve live across the sky.
5. Tap **CASH OUT** any time → win `stake × multiplier`, added to balance.
6. If the rocket crashes first → stake is **burned** (added to the global "RF burned" counter).
7. Instant restart. Round history shows recent crash points.

## Crash math (published, verifiable)
- Crash point: let `U ~ Uniform[0,1)`. If `0.97/(1-U) < 1` → `C = 1.00` (exactly 3%:
  "instant crash"); otherwise `C = max(1.01, floor(0.97/(1-U)*100)/100)`.
- Instant-crash (1.00x) probability: **3%**. House edge: **3%**.
- Cashing out at a fixed multiplier `m`: win probability `P(C ≥ m) = 0.97 / m`
  (for `m ≥ 1.01`), expected return `0.97` per 1 RF staked — verified by a
  200,000-round simulation (`verify-sdk-math.mjs`).
- Growth curve: `m(t) = e^(0.1·t)` — 2x at ~7s, 10x at ~23s. Feels tense, rounds stay short.
- The RNG + economy lives in a clean `Economy` module with a documented interface,
  so it can later plug into real on-chain plumbing without touching game code.

## Activity metrics (the Token Activity pitch)
Persistent-for-session dashboard, always visible:
- Total RF staked · Total RF burned · Rounds played · Biggest win · Biggest multiplier
- "Burn ticker": every crash adds to a global burned counter with a flame animation.
These numbers ARE the submission's argument for the category.

## Art direction — "voxel midnight launch"
- Deep indigo night sky, chunky square-pixel stars (some twinkle), blocky
  drifting clouds, distant city lights below.
- Art-deco launch tower on the left; chunky voxel rocket center stage — every
  block is shaded like a little 3D cube.
- The multiplier curve = the rocket's blocky comet trail, drawn live as chunky
  squares. Palette shifts with risk: cyan → gold → molten red.
- Pilot: the player's ACTUAL selected Friend. Its canonical on-chain 16x16
  sprite (idle-up frames, animated ~6fps) is rendered as voxels tinted by its
  family palette (9 families → 9 distinct hues), riding on top of the rocket.
  If the chain sprite read is unavailable, a deterministic generative pixel
  pilot is used instead — the game always works offline.
- Crash: the Friend ejects with a blocky parachute and lands dazed (X eyes,
  wobble). Funny, never punishing.
- Pixel font (Press Start 2P, bundled) for the multiplier, buttons, headings;
  chunky 3px-bordered panels with hard offset shadows, zero blur.

## Juice & feel (this is the bar)
- Launch: countdown beeps, engine rumble, screen shake on liftoff.
- Climb: everything vibrates slightly; slow-mo effect past 5x.
- Cash out: one frozen beat, then expanding shockwave squares + chunky gold coin fountain + pixel confetti.
- Crash: blocky fireball, RF coin squares scattering, the Friend pilot ejects with a
  tiny blocky parachute, lands dazed (X eyes, wobble), "FLY AGAIN?" prompt.
  Funny, never punishing.

## Audio (all synthesized with WebAudio, zero assets)
- Countdown beeps → launch rumble (filtered noise) → rising whine pitched to the multiplier
  (the audio IS the tension) → cash-out chime arpeggio → crash boom + comedic slide-whistle down.
- Mute toggle. (Reduced-motion toggle dims shake/particles.)

## UI
- Pre-round: stake selector chips + custom input, big LAUNCH button, balance display.
- In-flight: LAUNCH becomes a giant CASH OUT button (thumb-friendly); tap anywhere on canvas
  also cashes out. Live multiplier readout, huge.
- Post-round: result banner (win amount / burned amount), instant "FLY AGAIN" button.
- Round history strip (last ~12 crash points, green/red).
- Stats dashboard (staked / burned / rounds / bests).
- Mobile-first responsive canvas; keyboard: Space = launch/cash out.

## Tech — FriendSDK build
- Built as a **FriendSDK game** (verify latest release — v0.1.1 announced, README references v0.1.2; use whichever is newest).
- Game directory with `index.tsx` (default-export React component receiving
  `GameComponentProps { friendId, client, paused }`), `game.json`, and assets.
- The SDK runtime supplies: 960×640 container (v0.1.2 allows custom layouts —
  **use a portrait-leaning custom layout**, crash games are mobile-first),
  wallet connection, owned Friend selection, hardwired-NFT eligibility checks,
  sandbox, and in-frame confirmations. Do NOT reimplement any of that.
- The selected Friend is the pilot: render the co-pilot character as a cosmetic
  companion alongside the player's actual selected Friend (cosmetics/custom art
  explicitly encouraged by founders). Preserve the Friend's canonical artwork
  where it appears.
- Simulated RF ledger in game state, labeled "demo" everywhere; use `client.mode`
  (`"preview"`/`"chain"`) to label balances. Clean `Economy` module with a documented
  interface, ready for future on-chain plumbing.
- Canvas 2D rendering inside the component, WebAudio for synthesized sound, all art
  drawn in code, zero external assets.
- Test with the SDK's mock wallets + sample Friends (`npx friendsdk test`);
  real-wallet verification happens with the user's own hardwired Generations NFT.
- Keyboard + touch controls; mute and reduced-motion toggles; loading/error states
  per SDK conventions.

## Non-goals for the MVP
- No multiplayer, no real wallet, no real RF. Simulated economy, labeled as demo everywhere.
- No persistence across sessions (founders haven't shipped persistence APIs; session stats only).
