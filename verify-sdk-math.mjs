// Verifies Moonshot's economy by importing the real economy.ts (single source
// of truth) and simulating 500,000 launches with a seeded RNG.
//   node verify-sdk-math.mjs
import {
  drawCrashPoint, multiplierAt, timeToMultiplier, payoutOf, fuelOf, Ledger, ONE_RF,
} from "./games/moonshot/economy.ts";

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N = 500_000;
const rng = mulberry32(1337);
const targets = [1.5, 2, 5, 10];
const ret = Object.fromEntries(targets.map(m => [m, 0n]));
const stake = 100n * ONE_RF;
let instant = 0, fuel = 0n, pool = 0n, paid = 0n;
for (let i = 0; i < N; i++) {
  const c = drawCrashPoint(rng);
  if (c === 1) instant++;
  const f = fuelOf(stake), riding = stake - f;
  fuel += f;
  for (const m of targets) if (m <= c) ret[m] += payoutOf(riding, m);
  // pool flow for a 2x strategy
  if (2 <= c) paid += payoutOf(riding, 2) - riding; else pool += riding;
}
const pct = v => (Number((v * 100000n) / (BigInt(N) * stake)) / 1000).toFixed(2) + "%";
console.log(`launches: ${N}`);
console.log(`instant bust @1.00x: ${(instant / N * 100).toFixed(3)}% (expected ~0.99%)`);
for (const m of targets) console.log(`eject at ${m}x: return ${pct(ret[m])} of stake (expected 90%)`);
console.log(`fuel burned: ${pct(fuel)} of volume (expected 10.00%)`);
console.log(`launch pool (2x strategy): in ${pct(pool)} / out ${pct(paid)} -> zero-sum within noise`);
console.log(`m(t): 2x at ${timeToMultiplier(2).toFixed(2)}s, 10x at ${timeToMultiplier(10).toFixed(2)}s; m(5s)=${multiplierAt(5).toFixed(3)}`);

const l = new Ledger();
l.reserve(10n * ONE_RF);
const bet = l.ignite(10n * ONE_RF);
const out = l.cashOut(bet, 2);
if (bet.fuel !== ONE_RF || out !== 18n * ONE_RF) throw new Error("ledger arithmetic mismatch");
if (!l.buy(25n * ONE_RF) || l.totalBurned !== 26n * ONE_RF) throw new Error("hangar burn mismatch");
for (const m of targets) {
  const r = Number((ret[m] * 10000n) / (BigInt(N) * stake)) / 100;
  if (Math.abs(r - 90) > 0.8) throw new Error(`RTP off at ${m}x: ${r}%`);
}
console.log("MATH PASS");
