/**
 * The player's pilot: their selected Friend's canonical on-chain sprite, read
 * through the SDK's artwork reader. Never rejects — if the read fails (slow
 * RPC, offline), a deterministic stand-in is used and the UI says so.
 */
import { createFriendReader } from "@rarefriends/friendsdk/sprites";
import { fallbackSprite, type SpriteRows } from "./crew";

export interface PilotSprite {
  frames: SpriteRows[];
  familyId: number;
  fallback: boolean;
}

const reader = createFriendReader();
const cache = new Map<string, Promise<PilotSprite>>();

export function loadPilot(friendId: bigint): Promise<PilotSprite> {
  const key = friendId.toString();
  const hit = cache.get(key);
  if (hit) return hit;
  const job = (async (): Promise<PilotSprite> => {
    try {
      const art = await reader.read(friendId);
      const clips = [art.clips.idle.down, art.clips.idle.right, art.clips.walk.down, art.clips.walk.right];
      const frames = clips.map(c => c.filter(f => f.bitmap !== 0n)).find(c => c.length);
      if (!frames) throw new Error("no artwork frames");
      return { frames: frames.map(f => f.rows), familyId: art.familyId, fallback: false };
    } catch {
      return {
        frames: [fallbackSprite(Number(BigInt.asUintN(32, friendId)))],
        familyId: Number(friendId % 9n),
        fallback: true,
      };
    }
  })();
  cache.set(key, job);
  return job;
}
