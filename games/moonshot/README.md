# Moonshot 🚀

**A live crash game where your Rare Friend pilots the rocket, a crew of real Generations Friends hitch a ride, and RF burns on every launch.**

Built with FriendSDK **v0.1.2** for the Rare Friends Vibeathon · Category: **Token Activity**

![Moonshot gameplay](../../media/moonshot-demo.gif)

## How it plays

A new launch every ~15 seconds:

1. **Boarding (6 s).** Crew Friends hop onto the rocket's outrigger seats. Tap **Join this launch** (or press Space). Your Friend climbs into the cockpit dome. You can cancel for a full refund until liftoff.
2. **Liftoff.** **10% of every stake burns as rocket fuel**, from every pilot, whatever the outcome. The multiplier climbs as `m(t) = e^(0.12t)`: 2x at ~5.8 s, 10x at ~19 s. You pass the **Moon at 2x**, satellites at 3x, **Mars at 5x**, **Saturn at 10x**, then a nebula, a black hole and a galaxy.
3. **Fuel cans.** Mid-flight, throw a **fuel can (1 RF, burned 100%)** at any crew rider from the crew list (or press F). They get a flame aura, and the crowd throws cans too.
4. **Eject.** Press **Cash out** (Space, or tap the sky) to parachute out with `ride × multiplier`. Crew eject at their own targets.
5. **Crash.** Whoever is still aboard burns with the rocket. Their ride goes to the Launch Pool, which funds everyone who ejected.

**Supernova launches.** Every RF burned by any pilot fills a community meter. Every 300 RF, the next launch is a **SUPERNOVA**: **20% fuel** for everyone aboard, a purple dithered sky, a rainbow flame, and **3× Flame XP**. You can sit it out.

**Flame rank.** Every RF you burn earns Flame XP: Spark → Ember → Blaze → Inferno → Supernova. The **Flames** tab shows your burn receipt, rank, the Supernova meter and the **Hall of Flames** leaderboard.

**Options.** **Auto eject** at a target multiplier. **Auto-launch** for 5, 10, 25 or 50 rounds, or indefinitely. **Burn for glory** burns 10% of every payout for 3× XP.

## Look and feel

Drawn in the Rare Friends world style with the FriendSDK game palette (meadow `#B9D984`, pond `#7DB4DB`, sun `#F2CE68`, coral `#ED927E`, lilac `#B3A0D8`, signal `#CCFF00`), black ink outlines and checker-dither shading. Friends stay canonical black and white. The launch site is a floating meadow island. As you climb, the sky dithers from white paper into black space (purple on a Supernova). The UI follows the SDK frame: `#eee` paper, `#111` ink, square corners, 1px rules and hard shadows. It's kept simple, with one bet panel, one stage, and three tabs (Crew · Flames · Hangar).

## RF costs, probabilities and rewards

Everything is **simulated demo RF** (1,000 to start) and labelled as such in the UI. No real funds move.

| Sink | Rule |
|---|---|
| **Fuel** | **10% of every stake, burned at liftoff**, whatever the outcome |
| **Supernova fuel** | **20%** on Supernova launches (every 300 RF burned by all pilots) |
| **Fuel cans** | **1 RF each, burned 100%**, thrown at riders mid-flight |
| **Burn for glory** | Optional: **10% of each payout burned** (3× Flame XP) |
| **Hangar** | 5 rocket skins and 4 exhaust trails (free to 300 RF), **burned 100%**, cosmetic only |

| Crash rule | |
|---|---|
| Crash point | `U ~ Uniform[0,1)`, `C = floor(100 / (1 − U)) / 100`. C is the highest multiplier reached |
| Win chance | `P(C ≥ m) = 1/m` for any two-decimal target m ≥ 1.01. About 1% of launches bust at 1.00x |
| Eject payout | `ride × m` (ride = stake − fuel), so the expected return at any fixed target is **exactly 90%** (80% on a Supernova) |
| House edge | Equal to the fuel, and **all of it is burned**. The house keeps nothing |
| Crash | Riders still aboard lose their ride to the Launch Pool, which pays ejectors (zero-sum in expectation) |

**Why Token Activity:** every launch is a spend event for every pilot aboard and a guaranteed burn event. On top of that come three voluntary sinks players *want* to use: fuel cans (social), Glory (status), and the Hangar (style). Supernova events spike the burn for everyone. Flame ranks and the Hall of Flames give players a reason to burn. The loop repeats about every 15 seconds and can run hands-free.

**The crew** are real Rare Friends Generations NFTs. Their canonical on-chain sprites were read from the artwork registry and baked into `crew-sprites.json`. Their stakes, eject targets and fuel cans are simulated for the preview; at launch these seats would be real players. Your own pilot is read live through the SDK's `createFriendReader()`.

## Run it

- Node.js 22+
- `npm install`
- `npx friendsdk dev games/moonshot`: local preview. It needs a browser wallet on **Robinhood mainnet (4663)** holding a hardwired Generations NFT (gen ≥ 1), which is the SDK's standard gate.
- `npx friendsdk build games/moonshot --outdir dist`: static build for any HTTPS host.

Controls: **Space** bets, cancels or ejects. **F** throws a fuel can. **M** toggles sound. Everything also has a button for touch. Sound is off by default. Reduced motion follows the system setting and has its own toggle. The runtime's pause (menus open) freezes the flight without forfeiting anything.

## Checks

- `node verify-sdk-math.mjs`: 500,000 simulated launches. Instant bust 1.00%. Return 89.97% / 90.08% / 89.99% / 89.68% at 1.5x / 2x / 5x / 10x targets. Fuel burn 10.00% of volume. Launch Pool in/out balanced. Supernova 20% fuel, Glory 10% of payout, fuel can 1 RF, ledger totals and the rank ladder asserted.
- `node test-interaction.mjs 960` and `node test-interaction.mjs 390`: in the real sandboxed runtime with the SDK's mock wallet. Covers joining during boarding, liftoff, a fuel can burning exactly 1 RF, pausing mid-flight (the multiplier freezes), ejecting (or a valid crash), crash history, a Hangar purchase burning exactly 25 RF, the Flames tab, Burn for glory, auto-launch booking the next boarding, and the sound toggle. **PASS** at both widths, no browser errors.
- `npx friendsdk check games/moonshot`: valid. `npx friendsdk test games/moonshot --width 1200` and `--width 360`: **PASS**.

## Known issues

- A real-wallet playthrough of this version on the public preview is still to be confirmed by the builder.
- Crew behaviour (stakes, targets, fuel cans) is simulated; the SDK has no multiplayer. The session burn and Hall of Flames include those simulated burns and are labelled as such.
- `game.json` carries the placeholder chance-game definition the runtime schema requires. Moonshot runs its own documented ledger (`economy.ts`) and does not use the chance-game actions. Going live needs a round contract: a `burn()` of the fuel, cans and glory; a pool that escrows rides and pays ejectors; and a verifiable crash-point seed (Dice/VRF) committed before boarding closes.
- Balances, cosmetics, XP and history reset on reload (the SDK sandbox has no storage).
- If the pilot's artwork can't be read (slow RPC), a deterministic stand-in sprite is shown and labelled "art offline".
- The GIF and screenshots were recorded from a local harness that mounts the same game component, so the wallet screen isn't shown. Automated tests use the SDK's mock wallet.

## Credits

All scenery, the rocket, planets, particles and UI are drawn in code. All audio is synthesized with WebAudio. Friend sprites are canonical Rare Friends Generations artwork (FriendSDK sprite reader / on-chain registry, see the SDK `NOTICE.md`). The palette is FriendSDK's `GAME_PALETTE`. Fonts: Silkscreen, Sometype Mono and Archivo (all SIL OFL, bundled).
