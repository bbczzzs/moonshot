# Moonshot

A crash-style multiplier game for the Rare Friends Vibeathon (**Token Activity**),
built with FriendSDK **v0.1.2**. Your Rare Friend is the test pilot: stake RF,
launch the rocket, ride the multiplier, and cash out before it crashes. Crashed
stakes **burn** — every round is RF activity.

## Play

Requires a browser wallet on **Robinhood mainnet (chain 4663)** holding a
hardwired Rare Friends Generations NFT (generation ≥ 1), per the SDK's standard
gate. Preview balances are **simulated demo RF** — no real funds move.

1. Pick a stake: 10 / 25 / 50 / 100 RF, or a custom amount.
2. Press **LAUNCH** (or Space). 3-2-1 countdown, then liftoff.
3. The multiplier climbs as `m(t) = e^(0.1t)`. The rocket's comet trail draws
   the curve live across the sky, shifting cyan → gold → red as risk rises.
4. Press **CASH OUT** (or Space, or tap the sky) any time to bank `stake × multiplier`.
5. If the rocket crashes first, your stake **burns** (added to the session's
   burn ticker). Instant restart with **FLY AGAIN**.

Past 5x the game drops into a brief dramatic slow-mo. The co-pilot's face tells
you how scared you should be.

## Crash math (exact, verifiable)

Let `U ~ Uniform[0,1)`:

- `keep/(1-U) < 1` → crash point `C = 1.00` — exactly **3%** of rounds ("instant crash")
- otherwise `C = max(1.01, floor(keep/(1-U) × 100) / 100)`, with `keep = 0.97`

| Claim | Value |
|---|---|
| P(instant crash at 1.00x) | 3% |
| P(C ≥ m) for m ≥ 1.01 | 0.97 / m |
| House edge | 3% (EV of any fixed cash-out = 0.97 per 1 RF) |
| Time to 2x | ~6.9 s |
| Time to 10x | ~23 s |

Verified by `verify-sdk-math.mjs` (200,000 simulated rounds, deterministic seed):
instant-crash 3.003%, P(C ≥ 2) = 0.4852, mean return at 1.5x/2x/5x/10x cash-outs =
0.9702 / 0.9705 / 0.9695 / 0.9667.

## RF integration

- Simulated demo ledger (1,000 RF starting balance) in game state, labeled
  "Demo RF (simulated)" everywhere including the top bar and footer.
- `client.mode` (`"preview"` / `"chain"`) labels the session.
- Crash math and ledger live in an isolated `economy.ts` module with a documented
  interface, ready to be re-pointed at approved on-chain plumbing later without
  touching game code. No real RF is staked, paid, or burned in this build.

The `game.json` chance-game definition only satisfies the runtime schema (the
runtime requires one even for games that don't use the chance-game economy
actions). It is not used or shown as a mechanic.

## Tech

- `index.tsx` — React adapter (`GameComponentProps`: `friendId`, `client`, `paused`)
- `economy.ts` — crash RNG, growth curve, simulated ledger (pure logic)
- `scene.ts` — Canvas 2D renderer (all art drawn in code; original co-pilot character)
- `audio.ts` — WebAudio synthesized sound (no assets)
- `host.css` — portrait layout (`480px`, `3 / 4`)
- Pause-safe: the game clock and audio freeze when the runtime sets `paused`.
- Mute toggle + reduced-motion toggle (also honors `prefers-reduced-motion`).

## Run

From the project root (FriendSDK 0.1.2 installed):

```sh
npx friendsdk check ./games/moonshot   # schema + build validation
npx friendsdk dev ./games/moonshot     # local preview at http://localhost:4173
npx friendsdk test ./games/moonshot --screenshot ./artifacts/moonshot.png  # mock-wallet automated test
npx friendsdk build ./games/moonshot   # static preview bundle
```

Real-wallet playtest: connect a wallet holding a hardwired Generations NFT on
Robinhood mainnet, select the Friend, and fly.

## Known issues

- The selected Friend's identity is shown as "Pilot · Friend #id" in the top bar;
  the canonical sprite is not re-rendered inside the custom canvas (the sandbox
  exposes no sprite API to game code). The co-pilot is an original character.
- Session stats reset on reload (the SDK provides no persistence API in v0.1.2).
- Audio starts muted; unmute after the first tap (browser autoplay policy).
