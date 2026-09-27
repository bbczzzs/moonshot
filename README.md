# Moonshot 🚀

A crash-style multiplier game for the Rare Friends Vibeathon (**Token Activity**),
built with FriendSDK **v0.1.2**.

Your Rare Friend is the test pilot: stake RF, launch the rocket, ride the
multiplier as high as you dare, and cash out before it crashes. Crashed stakes
**burn** — every round is RF activity.

🎮 **Live demo:** https://bbczzzs.github.io/moonshot/ — requires a browser wallet on
Robinhood mainnet holding a hardwired Rare Friends Generations NFT (the SDK's
standard gate, same as every SDK entry). All balances are **simulated demo RF**.

## Repository layout

- `index.html` + `game.js`/`runtime.js`/css — the built static preview (served by GitHub Pages)
- `games/moonshot/` — the game source (`index.tsx`, `economy.ts`, `audio.ts`, `scene.ts`, …)
- `games/moonshot/README.md` — full game docs: rules, crash math, tests
- `verify-sdk-math.mjs` / `test-interaction.mjs` — math verification + browser interaction tests
- `GAME_DESIGN.md` — the original design doc

## Develop

- Node.js 22+
- `npm install`
- `npx friendsdk dev games/moonshot` — local preview with mock wallet + sample Friends
- `npx friendsdk build games/moonshot --outdir dist` — static build

## Crash math

3% instant crash, 3% house edge, `m(t) = e^0.1t`. Exact formula and 200,000-round
verification in `games/moonshot/README.md`. All RF simulated and labeled as demo.

## Credits

All visuals drawn in code (Canvas 2D), all audio synthesized live (WebAudio).
No external assets. No third-party character artwork — the co-pilot is an original character.
