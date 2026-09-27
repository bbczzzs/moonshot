/**
 * Pilot sprites for Moonshot: the player's ACTUAL selected Friend, rendered
 * as its canonical on-chain 16x16 sprite.
 *
 * Chain read flow (plain fetch JSON-RPC, no viem in the game bundle):
 *   familyOf(tokenId) -> uint8 familyId
 *   seedOf(tokenId)   -> uint32 seed
 *   frames(familyId, seed) -> uint256[64] bitmaps
 * Idle-up frames are indices 8..15; each is decoded with the SDK's
 * decodeSpriteBitmap into 16 rows of "#"/".".
 *
 * If the chain read fails for ANY reason (sandbox blocks network, RPC slow,
 * mock test env), a deterministic generative 16x16 pixel pilot is produced
 * from the friendId instead — the game always looks great and works offline.
 */
import { decodeSpriteBitmap } from "@rarefriends/friendsdk";

export interface PilotSprite {
  /** 8 idle-up animation frames; each frame is 16 rows of 16 "#" / "." chars. */
  frames: string[][];
  /** 0..8 — picks the voxel palette (see scene.ts FAMILY_PALETTE). */
  familyId: number;
  familyName: string;
  /** True when this sprite was generated locally (chain read unavailable). */
  fallback: boolean;
}

const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const REGISTRY = "0x246E3E9730A7Eade94c79be0Fd78d210f89AEb8D";
// function selectors: familyOf(uint256), seedOf(uint256), frames(uint8,uint32)
const SEL_FAMILY = "0x32bd63d1";
const SEL_SEED = "0x82829f74";
const SEL_FRAMES = "0xead2ca3c";
const CALL_TIMEOUT_MS = 7000;

export const FAMILY_NAMES = [
  "Skeleton", "Mask", "Family", "Cellular", "Asymmetry",
  "Hoverer", "Colossus", "Sparkling", "Hollow",
] as const;

const cache = new Map<string, Promise<PilotSprite>>();

function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pad32(hex: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return h.padStart(64, "0");
}

async function ethCall(data: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: REGISTRY, data }, "latest"],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`rpc http ${res.status}`);
    const json = (await res.json()) as { result?: string; error?: { message?: string } };
    if (json.error || typeof json.result !== "string") {
      throw new Error(json.error?.message || "rpc error");
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function loadChainPilot(friendId: bigint): Promise<PilotSprite> {
  const tokenHex = pad32(friendId.toString(16));
  const familyRes = await ethCall(SEL_FAMILY + tokenHex);
  const familyId = parseInt(familyRes.slice(-2), 16);
  if (!Number.isInteger(familyId) || familyId < 0 || familyId >= FAMILY_NAMES.length) {
    throw new Error(`unknown family id ${familyId}`);
  }
  const seedRes = await ethCall(SEL_SEED + tokenHex);
  const seed = parseInt(seedRes.slice(-8), 16);
  if (!Number.isInteger(seed) || seed < 0) throw new Error("bad seed");
  const framesRes = await ethCall(
    SEL_FRAMES + pad32(familyId.toString(16)) + pad32(seed.toString(16)),
  );
  const hex = framesRes.startsWith("0x") ? framesRes.slice(2) : framesRes;
  if (hex.length < 64 * 64) throw new Error("short frames payload");
  // Idle-up clip = frames[8..15].
  const frames: string[][] = [];
  for (let i = 8; i < 16; i++) {
    const bitmap = BigInt("0x" + hex.slice(i * 64, i * 64 + 64));
    frames.push([...decodeSpriteBitmap(bitmap).rows]);
  }
  return { frames, familyId, familyName: FAMILY_NAMES[familyId], fallback: false };
}

/**
 * Deterministic generative fallback: a symmetric little astronaut-ish pilot
 * derived from the friendId. Same friendId always yields the same pilot.
 */
function makeFallbackPilot(friendId: bigint): PilotSprite {
  const seedNum = Number(BigInt.asUintN(32, friendId) ^ 0x9e3779b9n);
  const rnd = mulberry32(seedNum);
  const grid: string[][] = Array.from({ length: 16 }, () => Array(16).fill("."));

  // Helmet: blobby circle rows 2..10.
  for (let y = 2; y <= 10; y++) {
    for (let x = 0; x < 16; x++) {
      const dx = (x - 7.5) / 5.6;
      const dy = (y - 6) / 4.6;
      if (dx * dx + dy * dy <= 1 && rnd() < 0.9) grid[y][x] = "#";
    }
  }
  // Visor cutout: rows 4..7, cols 4..11, with a glint pixel or two.
  for (let y = 4; y <= 7; y++) {
    for (let x = 4; x <= 11; x++) grid[y][x] = ".";
  }
  grid[5][5] = "#";
  grid[5][6] = "#";
  // Antenna.
  grid[1][7] = "#"; grid[1][8] = "#";
  grid[0][7] = "#"; grid[0][8] = "#";
  // Body: rows 11..15, cols 5..10 with speckle.
  for (let y = 11; y <= 15; y++) {
    for (let x = 5; x <= 10; x++) {
      if (rnd() < 0.88) grid[y][x] = "#";
    }
  }
  // Backpack nubs.
  grid[12][4] = "#"; grid[13][4] = "#";
  grid[12][11] = "#"; grid[13][11] = "#";

  const frame = grid.map((row) => row.join(""));
  const familyId = Number(BigInt.asUintN(32, friendId) % 9n);
  return {
    frames: Array.from({ length: 8 }, () => frame),
    familyId,
    familyName: `${FAMILY_NAMES[familyId]} (local)`,
    fallback: true,
  };
}

/**
 * Load the pilot for a Friend. Never rejects: any chain failure yields the
 * generative fallback. Results are cached per friendId.
 */
export function loadFriendPilot(friendId: bigint): Promise<PilotSprite> {
  const key = friendId.toString();
  const hit = cache.get(key);
  if (hit) return hit;
  const job = (async (): Promise<PilotSprite> => {
    try {
      if (friendId <= 0n) throw new Error("no friend id");
      return await loadChainPilot(friendId);
    } catch {
      return makeFallbackPilot(friendId < 0n ? -friendId : friendId);
    }
  })();
  cache.set(key, job);
  return job;
}
