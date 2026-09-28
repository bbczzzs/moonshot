/**
 * Hangar cosmetics in the Rare Friends game palette. Bought with simulated RF
 * and burned 100% — a pure sink with no prize liability. Purely visual: they
 * never touch the crash math.
 */
export interface Skin {
  id: string;
  name: string;
  price: number; // RF, 0 = free
  body: string;
  shade: string; // checker-dithered over the body's shadow side
  trim: string;
  nose: string;
  glass: string;
  locked?: "missions"; // earned, not bought
}

export interface Trail {
  id: string;
  name: string;
  price: number;
  flame: [string, string, string]; // core, mid, outer
  sparks: string[];
  shape: "puff" | "heart" | "star";
}

export const SKINS: Skin[] = [
  { id: "classic", name: "Classic", price: 0, body: "#FFFFFF", shade: "#000000", trim: "#ED927E", nose: "#ED927E", glass: "#7DB4DB" },
  { id: "tin", name: "Tin Toy", price: 25, body: "#7DB4DB", shade: "#000000", trim: "#F2CE68", nose: "#F2CE68", glass: "#FFFFFF" },
  { id: "neon", name: "Meadow", price: 60, body: "#B9D984", shade: "#000000", trim: "#FFFFFF", nose: "#ED927E", glass: "#F2CE68" },
  { id: "gold", name: "Gold Rush", price: 150, body: "#F2CE68", shade: "#000000", trim: "#FFFFFF", nose: "#000000", glass: "#CCFF00" },
  { id: "void", name: "Signal", price: 300, body: "#000000", shade: "#FFFFFF", trim: "#CCFF00", nose: "#CCFF00", glass: "#B3A0D8" },
  { id: "astro", name: "Astronaut", price: 0, body: "#FFFFFF", shade: "#B3A0D8", trim: "#CCFF00", nose: "#B3A0D8", glass: "#F2CE68", locked: "missions" },
];

export const TRAILS: Trail[] = [
  { id: "flame", name: "Flame", price: 0, flame: ["#FFFFFF", "#F2CE68", "#ED927E"], sparks: ["#F2CE68", "#ED927E"], shape: "puff" },
  { id: "signal", name: "Signal Green", price: 40, flame: ["#FFFFFF", "#CCFF00", "#B9D984"], sparks: ["#CCFF00", "#B9D984"], shape: "puff" },
  { id: "hearts", name: "Pixel Hearts", price: 80, flame: ["#FFFFFF", "#ED927E", "#B3A0D8"], sparks: ["#ED927E", "#B3A0D8"], shape: "heart" },
  { id: "stardust", name: "Stardust", price: 120, flame: ["#FFFFFF", "#7DB4DB", "#B3A0D8"], sparks: ["#FFFFFF", "#7DB4DB", "#F2CE68"], shape: "star" },
];

export const skinById = (id: string) => SKINS.find(s => s.id === id) ?? SKINS[0];
export const trailById = (id: string) => TRAILS.find(t => t.id === id) ?? TRAILS[0];
