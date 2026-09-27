// Verifies Moonshot's crash math against the design-doc spec by importing the
// real economy.ts module (single source of truth) and simulating 200,000 rounds.
import {
  drawCrashPoint,
  multiplierAt,
  crashTimeSeconds,
  cashOutValue,
  ONE_RF,
} from './games/moonshot/economy.ts';

// Deterministic RNG so results are reproducible.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N = 200000;
const rng = mulberry32(1337);
let instant = 0;
const strategies = [1.5, 2, 5, 10];
const sumRet = Object.fromEntries(strategies.map((m) => [m, 0]));
let winProb2 = 0;

for (let i = 0; i < N; i++) {
  const c = drawCrashPoint(rng);
  if (c === 1.0) instant++;
  for (const m of strategies) sumRet[m] += c >= m ? m : 0;
  if (c >= 2) winProb2++;
}

console.log(`rounds simulated : ${N}`);
console.log(`instant-crash rate (C=1.00): ${(instant / N * 100).toFixed(3)}%  (target ~3.000%)`);
console.log(`P(C >= 2) empirical          : ${(winProb2 / N).toFixed(4)}  (target 0.4850)`);
for (const m of strategies) {
  console.log(`mean return, cash-out @${m}x : ${(sumRet[m] / N).toFixed(4)}  (target 0.9700)`);
}
console.log(`time to 2x  : ${crashTimeSeconds(2).toFixed(2)}s (doc: ~6.9s)`);
console.log(`time to 10x : ${crashTimeSeconds(10).toFixed(2)}s (doc: ~23s)`);
// Spot-check the growth curve and payout rounding.
console.log(`m(6.93s)    : ${multiplierAt(100, 6.9315).toFixed(3)} (expect ~2.000)`);
console.log(`payout 10RF @2.37x: ${cashOutValue(10n * ONE_RF, 2.37) === 23700000000000000000n ? 'ok' : 'MISMATCH'}`);

const ok =
  Math.abs(instant / N - 0.03) < 0.002 &&
  strategies.every((m) => Math.abs(sumRet[m] / N - 0.97) < 0.01);
console.log(ok ? 'PASS: math matches spec' : 'FAIL: math deviates from spec');
process.exit(ok ? 0 : 1);
