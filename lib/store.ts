import { Redis } from "@upstash/redis";

// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN env vardan avtomatik o'qiydi
const redis = Redis.fromEnv();

export interface TrackedGift {
  botId: string;
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

// Ikkita bot bir xil Redis'ni ishlatgani uchun barcha kalitlar botId bilan
// ajratiladi - shu bilan bir foydalanuvchi ikkala botga xabar yozsa ham
// ularning kuzatuvlari aralashib ketmaydi.
const chatsKey = (botId: string) => `gifts:${botId}:chats`;
const trackedKey = (botId: string, chatId: number) => `gifts:${botId}:tracked:${chatId}`;
const stateKey = (botId: string, chatId: number, giftId: string) =>
  `gifts:${botId}:state:${chatId}:${giftId}`;

function parseTracked(raw: unknown): Omit<TrackedGift, "botId" | "chatId"> | null {
  if (raw == null) return null;
  const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  return obj as Omit<TrackedGift, "botId" | "chatId">;
}

export async function addTracked(
  botId: string,
  chatId: number,
  giftId: string,
  title: string,
  min: number,
  max: number
): Promise<void> {
  await redis.sadd(chatsKey(botId), String(chatId));
  await redis.hset(trackedKey(botId, chatId), {
    [giftId]: JSON.stringify({ giftId, title, min, max }),
  });
  // Yangi chegara qo'yilganda eski bildirishnoma holatini tozalaymiz
  await redis.del(stateKey(botId, chatId, giftId));
}

export async function removeTracked(botId: string, chatId: number, giftId: string): Promise<boolean> {
  const removed = await redis.hdel(trackedKey(botId, chatId), giftId);
  await redis.del(stateKey(botId, chatId, giftId));
  return removed > 0;
}

export async function listTrackedForChat(botId: string, chatId: number): Promise<TrackedGift[]> {
  const raw = await redis.hgetall<Record<string, unknown>>(trackedKey(botId, chatId));
  if (!raw) return [];
  return Object.values(raw)
    .map(parseTracked)
    .filter((t): t is Omit<TrackedGift, "botId" | "chatId"> => t !== null)
    .map((t) => ({ ...t, botId, chatId }));
}

export async function getAllTracked(botId: string): Promise<TrackedGift[]> {
  const chatIds = await redis.smembers(chatsKey(botId));
  const all: TrackedGift[] = [];
  for (const chatId of chatIds) {
    const items = await listTrackedForChat(botId, Number(chatId));
    if (items.length === 0) {
      // Bo'sh qolgan chatni ro'yxatdan tozalab qo'yamiz
      await redis.srem(chatsKey(botId), chatId);
      continue;
    }
    all.push(...items);
  }
  return all;
}

export async function getGiftState(botId: string, chatId: number, giftId: string): Promise<GiftState | null> {
  const raw = await redis.get<GiftState>(stateKey(botId, chatId, giftId));
  return raw ?? null;
}

export async function setGiftState(
  botId: string,
  chatId: number,
  giftId: string,
  state: GiftState
): Promise<void> {
  await redis.set(stateKey(botId, chatId, giftId), state);
}
