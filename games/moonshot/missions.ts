/**
 * Session missions: short goals that pay Flame XP (never RF) and give players
 * a reason to keep launching. Finishing all of them unlocks the Astronaut skin.
 */
export interface Mission {
  id: string;
  label: string;
  goal: number;
  xp: number;
}

export const MISSIONS: Mission[] = [
  { id: "eject3", label: "Eject above 3x", goal: 1, xp: 30 },
  { id: "back3", label: "Back 3 riders who eject safely", goal: 3, xp: 40 },
  { id: "cans10", label: "Throw 10 fuel cans", goal: 10, xp: 25 },
  { id: "half", label: "Eject half, then land the rest", goal: 1, xp: 30 },
  { id: "nova", label: "Fly a Supernova launch", goal: 1, xp: 50 },
];

export type MissionProgress = Record<string, number>;

export const emptyProgress = (): MissionProgress =>
  Object.fromEntries(MISSIONS.map(m => [m.id, 0]));
