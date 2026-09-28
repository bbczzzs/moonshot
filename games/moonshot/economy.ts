/**
 * Moonshot economy — pure logic: no DOM, no React, no SDK imports.
 *
 * Every launch burns FUEL (10% of the stake) — guaranteed, win or lose. The
 * remaining 90% "rides" the rocket on a fair crash curve:
 *
 *   U ~ Uniform[0,1),  C = floor(100 / (1 - U)) / 100      (C >= 1.00)
 *   P(C >= m) = 1 / m  for any two-decimal m >= 1.01
 *
 * so cashing out at any fixed m returns exactly the riding amount on average:
 * E[payout] = 0.90 * stake. The whole 10% house edge is the fuel burn — the
 * house keeps nothing. Riders still aboard at the crash lose their ride to the
 * Launch Pool, which pays everyone who ejected (zero-sum in expectation).
 * About 1% of rounds bust at 1.00x before anyone can eject.
 *
 * Growth: m(t) = e^(0.12 t)  =>  2x at ~5.8 s, 10x at ~19 s.
 *
 * Everything here is simulated demo RF. The Ledger's explicit mutations are
 * the seam for a future on-chain adapter (burn() / pool transfers).
 */

export const ONE_RF = 10n ** 18n;
export const FUEL_BPS = 1000n; // 10% of every stake is burned at ignition
export const NOVA_FUEL_BPS = 2000n; // Supernova launches burn 20%
export const CAN_PRICE = 1n * (10n ** 18n); // a fuel can: 1 RF, burned 100%
export const GLORY_BPS = 1000n; // Burn for Glory: 10% of each payout
export const NOVA_EVERY = 300n * (10n ** 18n); // community furnace RF per Supernova
export const GROWTH_RATE = 0.12;
export const STARTING_BALANCE = 1000n * ONE_RF;
export const MIN_STAKE = 1n * ONE_RF;

export function drawCrashPoint(rand: () => number = Math.random): number {
  const u = Math.min(rand(), 1 - Number.EPSILON);
  return Math.max(1, Math.floor(100 / (1 - u)) / 100);
}

export function multiplierAt(tSeconds: number, growthRate = GROWTH_RATE): number {
  return Math.exp(growthRate * Math.max(0, tSeconds));
}

export function timeToMultiplier(m: number, growthRate = GROWTH_RATE): number {
  return Math.log(Math.max(1, m)) / growthRate;
}

/** Two-decimal floor, matching the displayed multiplier. */
export function floorMult(m: number): number {
  return Math.floor(m * 100 + 1e-9) / 100;
}

export function fuelOf(stake: bigint, bps: bigint = FUEL_BPS): bigint {
  return (stake * bps) / 10000n;
}

export function payoutOf(riding: bigint, multiplier: number): bigint {
  return (riding * BigInt(Math.round(floorMult(multiplier) * 100))) / 100n;
}

export interface Bet {
  stake: bigint;
  fuel: bigint;
  riding: bigint;
}

export interface PlayerStats {
  rounds: number;
  volume: bigint;
  fuelBurned: bigint;
  hangarBurned: bigint;
  canBurned: bigint;
  gloryBurned: bigint;
  paidOut: bigint;
  lostToPool: bigint;
  biggestWin: bigint;
  bestCashout: number;
  wins: number;
}

export const emptyStats = (): PlayerStats => ({
  rounds: 0,
  volume: 0n,
  fuelBurned: 0n,
  hangarBurned: 0n,
  canBurned: 0n,
  gloryBurned: 0n,
  paidOut: 0n,
  lostToPool: 0n,
  biggestWin: 0n,
  bestCashout: 0,
  wins: 0,
});

/** The player's simulated RF ledger. */
export class Ledger {
  balance: bigint;
  stats: PlayerStats = emptyStats();

  constructor(startingBalance: bigint = STARTING_BALANCE) {
    this.balance = startingBalance;
  }

  get totalBurned(): bigint {
    const s = this.stats;
    return s.fuelBurned + s.hangarBurned + s.canBurned + s.gloryBurned;
  }

  /** Reserve a stake for the next launch (refundable until liftoff). */
  reserve(stake: bigint): boolean {
    if (stake < MIN_STAKE || stake > this.balance) return false;
    this.balance -= stake;
    return true;
  }

  refund(stake: bigint): void {
    this.balance += stake;
  }

  /** Liftoff: the fuel burns, the rest rides. */
  ignite(stake: bigint, bps: bigint = FUEL_BPS): Bet {
    const fuel = fuelOf(stake, bps);
    this.stats.rounds += 1;
    this.stats.volume += stake;
    this.stats.fuelBurned += fuel;
    return { stake, fuel, riding: stake - fuel };
  }

  /** Returns what reaches the balance; with `glory`, 10% of the payout burns first. */
  cashOut(bet: Bet, multiplier: number, glory = false): bigint {
    const gross = payoutOf(bet.riding, multiplier);
    const burn = glory ? (gross * GLORY_BPS) / 10000n : 0n;
    this.stats.gloryBurned += burn;
    const payout = gross - burn;
    this.balance += payout;
    this.stats.paidOut += payout;
    this.stats.wins += 1;
    const profit = payout - bet.stake;
    if (profit > this.stats.biggestWin) this.stats.biggestWin = profit;
    if (multiplier > this.stats.bestCashout) this.stats.bestCashout = floorMult(multiplier);
    return payout;
  }

  /**
   * Eject half: bank half the ride at `multiplier` and keep the other half
   * flying. Each half is an independent fair ride, so the odds don't change.
   */
  cashOutHalf(bet: Bet, multiplier: number, glory = false): bigint {
    const half = bet.riding / 2n;
    bet.riding -= half;
    const gross = payoutOf(half, multiplier);
    const burn = glory ? (gross * GLORY_BPS) / 10000n : 0n;
    this.stats.gloryBurned += burn;
    const payout = gross - burn;
    this.balance += payout;
    this.stats.paidOut += payout;
    if (multiplier > this.stats.bestCashout) this.stats.bestCashout = floorMult(multiplier);
    return payout;
  }

  crashed(bet: Bet): void {
    this.stats.lostToPool += bet.riding;
  }

  /** A fuel can thrown at a rider: 100% burned. */
  throwCan(): boolean {
    if (CAN_PRICE > this.balance) return false;
    this.balance -= CAN_PRICE;
    this.stats.canBurned += CAN_PRICE;
    return true;
  }

  /** Hangar purchases burn 100%. */
  buy(price: bigint): boolean {
    if (price > this.balance) return false;
    this.balance -= price;
    this.stats.hangarBurned += price;
    return true;
  }
}

/** Parse a user-entered RF amount (up to 2 decimals) into base units. */
export function parseRf(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d{1,7}(\.\d{0,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return BigInt(whole) * ONE_RF + (BigInt((frac + "00").slice(0, 2)) * ONE_RF) / 100n;
}

/** Compact RF formatting: 1,234.5 / 12.34 / 0.05 */
export function fmtRf(value: bigint, maxDecimals = 2): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const cents = (v * 100n) / ONE_RF;
  const whole = cents / 100n;
  const frac = Number(cents % 100n);
  let s = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (maxDecimals > 0 && frac !== 0) {
    s += "." + frac.toString().padStart(2, "0").replace(/0$/, "");
  }
  return (neg ? "-" : "") + s;
}

/** Flame ranks, earned with Flame XP (1 XP per RF burned; Glory and Supernova fuel earn 3). */
export const RANKS: { name: string; xp: number }[] = [
  { name: "Spark", xp: 0 },
  { name: "Ember", xp: 20 },
  { name: "Blaze", xp: 75 },
  { name: "Inferno", xp: 250 },
  { name: "Supernova", xp: 800 },
];

export function rankOf(xp: number): { index: number; name: string; next: number | null; progress: number } {
  let i = 0;
  while (i + 1 < RANKS.length && xp >= RANKS[i + 1].xp) i++;
  const next = i + 1 < RANKS.length ? RANKS[i + 1].xp : null;
  const progress = next === null ? 1 : (xp - RANKS[i].xp) / (next - RANKS[i].xp);
  return { index: i, name: RANKS[i].name, next, progress };
}

export const toRf = (v: bigint): number => Number((v * 100n) / ONE_RF) / 100;
