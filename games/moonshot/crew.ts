/**
 * The simulated crew: real Rare Friends Generations NFTs (canonical on-chain
 * sprites, pre-read from the artwork registry and baked into crew-sprites.json)
 * who hitch a ride on each launch with their own simulated RF stakes.
 *
 * Their behaviour is simulated for the preview — at launch these seats would
 * be filled by real players. Their stakes feed the same fuel burn and Launch
 * Pool as the player's.
 */
import { decodeSpriteBitmap } from "@rarefriends/friendsdk";
import roster from "./crew-sprites.json";
import { ONE_RF, fuelOf } from "./economy";

export const FAMILY_NAMES = [
  "Skeleton", "Mask", "Family", "Cellular", "Asymmetry",
  "Hoverer", "Colossus", "Sparkling", "Hollow",
] as const;

/** One Rare Friends game-palette tint per family (seat trim, parachutes, list chips). */
export const FAMILY_COLORS = [
  "#B3A0D8", "#7DB4DB", "#F2CE68", "#B9D984", "#ED927E",
  "#7DB4DB", "#ED927E", "#F2CE68", "#B3A0D8",
];

export type SpriteRows = readonly string[];

export interface RosterFriend {
  id: number;
  familyId: number;
  frames: SpriteRows[];
}

type RawRoster = { id: number; f: number; b: string[] }[];

export const ROSTER: RosterFriend[] = (roster as RawRoster).map(r => ({
  id: r.id,
  familyId: r.f,
  frames: r.b.filter(hex => /[^0]/.test(hex)).map(hex => decodeSpriteBitmap(BigInt("0x" + hex)).rows),
}));

export type CrewStatus = "boarding" | "riding" | "ejected" | "burned";

export interface CrewMember {
  friend: RosterFriend;
  seat: number; // 0..7: even seats on the left, odd on the right, top to bottom
  stake: bigint;
  fuel: bigint;
  riding: bigint;
  target: number | null; // null = diamond hands, rides to the end
  joinAt: number; // seconds into boarding
  status: CrewStatus;
  cashedAt: number | null;
  payout: bigint;
}

export const MAX_CREW = 8;

const STAKES = [2n, 5n, 5n, 10n, 10n, 10n, 20n, 25n, 25n, 50n, 50n, 100n, 250n];

function pick<T>(arr: readonly T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)];
}

/** Target cash-out: cautious, steady, bold or diamond hands. */
function drawTarget(rand: () => number): number | null {
  const r = rand();
  if (r < 0.34) return 1.15 + rand() * 0.6;
  if (r < 0.74) return 1.8 + rand() * 2.2;
  if (r < 0.95) return 4 + rand() * 11;
  return null;
}

export function makeCrew(rand: () => number, boardingSeconds: number, excludeId?: number): CrewMember[] {
  const count = 5 + Math.floor(rand() * (MAX_CREW - 4));
  const pool = ROSTER.filter(f => f.id !== excludeId);
  const chosen: RosterFriend[] = [];
  while (chosen.length < count && pool.length > 0) {
    chosen.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  const seats = Array.from({ length: MAX_CREW }, (_, i) => i).sort(() => rand() - 0.5);
  return chosen.map((friend, i) => {
    const stake = pick(STAKES, rand) * ONE_RF;
    const fuel = fuelOf(stake);
    return {
      friend,
      seat: seats[i],
      stake,
      fuel,
      riding: stake - fuel,
      target: drawTarget(rand),
      joinAt: 0.3 + rand() * (boardingSeconds - 1.4),
      status: "boarding" as CrewStatus,
      cashedAt: null,
      payout: 0n,
    };
  });
}

export function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic stand-in sprite when the player's Friend art can't be read. */
export function fallbackSprite(seed: number): SpriteRows {
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const g: string[][] = Array.from({ length: 16 }, () => Array(16).fill("."));
  for (let y = 3; y < 15; y++) {
    for (let x = 3; x < 8; x++) {
      const inside = ((x - 7.5) / 4.6) ** 2 + ((y - 8.5) / 5.8) ** 2 <= 1;
      if (inside && rnd() < 0.82) { g[y][x] = "#"; g[y][15 - x] = "#"; }
    }
  }
  g[7][5] = "."; g[7][10] = "."; g[8][5] = "."; g[8][10] = ".";
  return g.map(r => r.join(""));
}
