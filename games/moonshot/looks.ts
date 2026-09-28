/**
 * Hangar cosmetics. Bought with simulated RF and burned 100% — a pure sink
 * with no prize liability. Purely visual: they never touch the crash math.
 */
export interface Skin {
  id: string;
  name: string;
  price: number; // RF, 0 = free
  body: string;
  shade: string;
  trim: string;
  nose: string;
  glass: string;
}

export interface Trail {
  id: string;
  name: string;
  price: number;
  colors: string[]; // hot -> cool
  shape: "puff" | "heart" | "star";
}

export const SKINS: Skin[] = [
  { id: "classic", name: "Classic", price: 0, body: "#efeadf", shade: "#b7b1a5", trim: "#ff5a3c", nose: "#ff5a3c", glass: "#9fe8ff" },
  { id: "tin", name: "Tin Toy", price: 25, body: "#cdd6de", shade: "#8894a1", trim: "#3d7cf5", nose: "#ffc83a", glass: "#c6f3ff" },
  { id: "neon", name: "Neon Night", price: 60, body: "#23244a", shade: "#15162e", trim: "#ff3fd8", nose: "#2ee8ff", glass: "#ff9cf0" },
  { id: "gold", name: "Gold Rush", price: 150, body: "#ffd54a", shade: "#c8951b", trim: "#fff4b8", nose: "#ff9a1a", glass: "#fff8d6" },
  { id: "void", name: "Void Runner", price: 300, body: "#15151d", shade: "#08080c", trim: "#8f6bff", nose: "#c3b2ff", glass: "#8f6bff" },
];

export const TRAILS: Trail[] = [
  { id: "flame", name: "Flame", price: 0, colors: ["#fff7cf", "#ffd23f", "#ff8a2a", "#ff4d2e", "#6b6f86"], shape: "puff" },
  { id: "signal", name: "Signal Green", price: 40, colors: ["#f2ffd6", "#c8ff5a", "#6dff8a", "#1fcf78", "#2b5c4a"], shape: "puff" },
  { id: "hearts", name: "Pixel Hearts", price: 80, colors: ["#ffe1f0", "#ff8ac6", "#ff4fa3", "#d42a7c", "#6a2c52"], shape: "heart" },
  { id: "stardust", name: "Stardust", price: 120, colors: ["#ffffff", "#bfe9ff", "#8fb5ff", "#b48cff", "#4b3f7a"], shape: "star" },
];

export const skinById = (id: string) => SKINS.find(s => s.id === id) ?? SKINS[0];
export const trailById = (id: string) => TRAILS.find(t => t.id === id) ?? TRAILS[0];
