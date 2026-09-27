/**
 * Moonshot crash-game economy.
 *
 * Pure logic: no DOM, no React, no SDK imports. This module is the single source
 * of truth for the crash math and the simulated RF ledger.
 *
 * Crash model (published in README):
 *   Let U ~ Uniform[0,1). C = 1.00 when 0.97/(1-U) < 1 (exactly 3% of draws);
 *   otherwise C = floor(0.97/(1-U) * 100) / 100.
 *   - P(instant crash at 1.00x) = 3%
 *   - P(C >= m) = 0.97 / m  for m >= 1.01  =>  house edge 3%
 *   - Cashing out at a fixed multiplier m returns 0.97 per 1 RF staked (EV).
 * Growth: m(t) = e^(0.1 * t)  =>  2x at ~6.9s, 10x at ~23s.
 *
 * Future on-chain integration: replace `drawCrashPoint`'s RNG source with a
 * verifiable oracle feed and route `Ledger` mutations through signed RF
 * transfers. The interface below (draw/settle/record) is the seam.
 */

export const RF_DECIMALS = 18;
export const ONE_RF = 10n ** 18n;

export const HOUSE_EDGE_BPS = 300; // 3%
export const GROWTH_RATE = 0.1; // k in m(t) = e^(kt)
export const STARTING_BALANCE = 1000n * ONE_RF;

/** Draw a crash point from the house-edge distribution.
 *
 * Let U ~ Uniform[0,1) and keep = 1 - houseEdge.
 *   - If keep/(1-U) < 1  =>  C = 1.00            (exactly 3% of draws: "instant crash")
 *   - Else C = max(1.01, floor(keep/(1-U) * 100) / 100)
 * The 1.01 floor keeps the displayed 1.00 bucket at exactly the instant-crash
 * rate (cent-flooring would otherwise smear [1.00, 1.01) into it).
 * P(C >= m) = 0.97/m for m >= 1.01, so every fixed cash-out has EV 0.97 per 1 staked. */
export function drawCrashPoint(
  rand: () => number = Math.random,
  houseEdgeBps: number = HOUSE_EDGE_BPS,
): number {
  const keep = 1 - houseEdgeBps / 10000;
  const u = Math.min(rand(), 1 - Number.EPSILON);
  const exact = keep / (1 - u);
  if (exact < 1) return 1.0;
  return Math.max(1.01, Math.floor(exact * 100) / 100);
}

/** Multiplier shown at t seconds into the flight, capped at the crash point. */
export function multiplierAt(
  crashPoint: number,
  tSeconds: number,
  growthRate: number = GROWTH_RATE,
): number {
  return Math.min(crashPoint, Math.exp(growthRate * tSeconds));
}

/** Flight time in seconds until the rocket crashes. */
export function crashTimeSeconds(
  crashPoint: number,
  growthRate: number = GROWTH_RATE,
): number {
  return Math.log(crashPoint) / growthRate;
}

/** Payout in base units for cashing out `stake` at `multiplier` (rounds down). */
export function cashOutValue(stake: bigint, multiplier: number): bigint {
  return (stake * BigInt(Math.floor(multiplier * 100))) / 100n;
}

export interface RoundRecord {
  stake: bigint;
  crashPoint: number;
  cashedAt: number | null; // multiplier at cash-out, null when crashed
  payout: bigint; // 0 when crashed
}

export interface LedgerStats {
  rounds: number;
  totalStaked: bigint;
  totalBurned: bigint;
  biggestWin: bigint;
  biggestMultiplier: number;
}

/**
 * Simulated RF ledger. All balances are demo units for the preview build.
 * Mutations are explicit so a future on-chain adapter can mirror them.
 */
export class Ledger {
  balance: bigint;
  stats: LedgerStats = {
    rounds: 0,
    totalStaked: 0n,
    totalBurned: 0n,
    biggestWin: 0n,
    biggestMultiplier: 1,
  };

  constructor(startingBalance: bigint = STARTING_BALANCE) {
    this.balance = startingBalance;
  }

  canStake(amount: bigint): boolean {
    return amount > 0n && amount <= this.balance;
  }

  /** Lock a stake at launch. Returns false if unaffordable. */
  stake(amount: bigint): boolean {
    if (!this.canStake(amount)) return false;
    this.balance -= amount;
    this.stats.totalStaked += amount;
    return true;
  }

  /** Settle a finished round. Crashed stakes are burned. */
  settle(record: RoundRecord): void {
    this.stats.rounds += 1;
    if (record.cashedAt !== null) {
      this.balance += record.payout;
      const profit = record.payout - record.stake;
      if (profit > this.stats.biggestWin) this.stats.biggestWin = profit;
      if (record.cashedAt > this.stats.biggestMultiplier) {
        this.stats.biggestMultiplier = record.cashedAt;
      }
    } else {
      this.stats.totalBurned += record.stake;
      if (record.crashPoint > this.stats.biggestMultiplier) {
        this.stats.biggestMultiplier = record.crashPoint;
      }
    }
  }

  reset(startingBalance: bigint = STARTING_BALANCE): void {
    this.balance = startingBalance;
    this.stats = {
      rounds: 0,
      totalStaked: 0n,
      totalBurned: 0n,
      biggestWin: 0n,
      biggestMultiplier: 1,
    };
  }
}
