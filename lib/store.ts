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

// Ikkita bot bir xil Redis'ni ishlatgani uchun barcha kalitlar botId bilan
// ajratiladi - shu bilan bir foydalanuvchi ikkala botga xabar yozsa ham
// ularning kuzatuvlari aralashib ketmaydi.
const chatsKey = (botId: string) => `gifts:${botId}:chats`;
const trackedKey = (botId: string, chatId: number) => `gifts:${botId}:tracked:${chatId}`;
// Shu chat+gift uchun allaqachon xabar qilingan aniq nusxalar (slug) to'plami -
// har bir nusxa haqida faqat bir marta xabar berish uchun.
const notifiedKey = (botId: string, chatId: number, giftId: string) =>
  `gifts:${botId}:notified:${chatId}:${giftId}`;
// Chat vaqtincha to'xtatilganmi (/pause) - shu yerda bo'lgan chatlar uchun
// check-gifts hech qanday xabar yubormaydi, lekin kuzatuv ro'yxati saqlanib qoladi.
const pausedChatsKey = (botId: string) => `gifts:${botId}:pausedChats`;

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
  // Yangi chegara qo'yilganda eski bildirishnoma tarixini tozalaymiz -
  // hozirgi oraliqdagi nusxalar haqida qaytadan xabar berilsin.
  await redis.del(notifiedKey(botId, chatId, giftId));
}

export async function removeTracked(botId: string, chatId: number, giftId: string): Promise<boolean> {
  const removed = await redis.hdel(trackedKey(botId, chatId), giftId);
  await redis.del(notifiedKey(botId, chatId, giftId));
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

/** Shu chat+gift uchun avval xabar qilingan nusxalar (slug) to'plamini oladi */
export async function getNotifiedSlugs(botId: string, chatId: number, giftId: string): Promise<Set<string>> {
  const members = await redis.smembers(notifiedKey(botId, chatId, giftId));
  return new Set(members);
}

/** Yangi xabar qilingan nusxalarni (slug) tarixga qo'shadi */
export async function markSlugsNotified(
  botId: string,
  chatId: number,
  giftId: string,
  slugs: string[]
): Promise<void> {
  if (slugs.length === 0) return;
  const [first, ...rest] = slugs;
  await redis.sadd(notifiedKey(botId, chatId, giftId), first, ...rest);
}

export async function setPaused(botId: string, chatId: number, paused: boolean): Promise<void> {
  if (paused) {
    await redis.sadd(pausedChatsKey(botId), String(chatId));
  } else {
    await redis.srem(pausedChatsKey(botId), String(chatId));
  }
}

export async function getPausedChats(botId: string): Promise<Set<string>> {
  const members = await redis.smembers(pausedChatsKey(botId));
  return new Set(members);
}
