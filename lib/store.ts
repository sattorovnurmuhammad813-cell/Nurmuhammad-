import { Redis } from "@upstash/redis";

// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN env vardan avtomatik o'qiydi
const redis = Redis.fromEnv();

export interface TrackedGift {
  chatId: number;
  giftId: string;
  title: string;
  min: number;
  max: number;
}

export interface GiftState {
  lastInRange: boolean;
  lastPrice: number | null;
}

const CHATS_KEY = "gifts:chats";
const trackedKey = (chatId: number) => `gifts:tracked:${chatId}`;
const stateKey = (chatId: number, giftId: string) => `gifts:state:${chatId}:${giftId}`;

function parseTracked(raw: unknown): Omit<TrackedGift, "chatId"> | null {
  if (raw == null) return null;
  const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  return obj as Omit<TrackedGift, "chatId">;
}

export async function addTracked(
  chatId: number,
  giftId: string,
  title: string,
  min: number,
  max: number
): Promise<void> {
  await redis.sadd(CHATS_KEY, String(chatId));
  await redis.hset(trackedKey(chatId), {
    [giftId]: JSON.stringify({ giftId, title, min, max }),
  });
  // Yangi chegara qo'yilganda eski bildirishnoma holatini tozalaymiz
  await redis.del(stateKey(chatId, giftId));
}

export async function removeTracked(chatId: number, giftId: string): Promise<boolean> {
  const removed = await redis.hdel(trackedKey(chatId), giftId);
  await redis.del(stateKey(chatId, giftId));
  return removed > 0;
}

export async function listTrackedForChat(chatId: number): Promise<TrackedGift[]> {
  const raw = await redis.hgetall<Record<string, unknown>>(trackedKey(chatId));
  if (!raw) return [];
  return Object.values(raw)
    .map(parseTracked)
    .filter((t): t is Omit<TrackedGift, "chatId"> => t !== null)
    .map((t) => ({ ...t, chatId }));
}

export async function getAllTracked(): Promise<TrackedGift[]> {
  const chatIds = await redis.smembers(CHATS_KEY);
  const all: TrackedGift[] = [];
  for (const chatId of chatIds) {
    const items = await listTrackedForChat(Number(chatId));
    if (items.length === 0) {
      // Bo'sh qolgan chatni ro'yxatdan tozalab qo'yamiz
      await redis.srem(CHATS_KEY, chatId);
      continue;
    }
    all.push(...items);
  }
  return all;
}

export async function getGiftState(chatId: number, giftId: string): Promise<GiftState | null> {
  const raw = await redis.get<GiftState>(stateKey(chatId, giftId));
  return raw ?? null;
}

export async function setGiftState(chatId: number, giftId: string, state: GiftState): Promise<void> {
  await redis.set(stateKey(chatId, giftId), state);
}
