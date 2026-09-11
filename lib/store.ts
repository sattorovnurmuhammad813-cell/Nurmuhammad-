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
  /** Agar berilgan bo'lsa, faqat shu Model atributiga ega nusxalar haqida xabar beriladi */
  model?: string;
}

// Ikkita bot bir xil Redis'ni ishlatgani uchun barcha kalitlar botId bilan
// ajratiladi - shu bilan bir foydalanuvchi ikkala botga xabar yozsa ham
// ularning kuzatuvlari aralashib ketmaydi.
const chatsKey = (botId: string) => `gifts:${botId}:chats`;
const trackedKey = (botId: string, chatId: number) => `gifts:${botId}:tracked:${chatId}`;
// Shu chat+gift uchun allaqachon xabar qilingan aniq nusxalar (slug) to'plami -
// har bir nusxa haqida faqat bir marta xabar berish uchun.
const notifiedKey = (botId: string, chatId: number, trackKey: string) =>
  `gifts:${botId}:notified:${chatId}:${trackKey}`;
// Chat vaqtincha to'xtatilganmi (/pause) - shu yerda bo'lgan chatlar uchun
// check-gifts hech qanday xabar yubormaydi, lekin kuzatuv ro'yxati saqlanib qoladi.
const pausedChatsKey = (botId: string) => `gifts:${botId}:pausedChats`;
// /giftlar menyusida "Boshqa narx kiritish" bosilgach, shu chat uchun qaysi
// gift kutilayotganini saqlaydi - keyingi oddiy (buyruq bo'lmagan) xabar shu
// gift uchun maksimal narx sifatida talqin qilinadi. 5 daqiqadan keyin o'zi tozalanadi.
const pendingKey = (botId: string, chatId: number) => `gifts:${botId}:pending:${chatId}`;
const PENDING_TTL_SEC = 300;

/**
 * Bitta gift_id'ni bir nechta (masalan turli model bo'yicha) alohida-alohida
 * kuzatish mumkin bo'lishi uchun hash maydon kaliti giftId+model'dan tuziladi.
 */
export function trackKeyOf(giftId: string, model?: string): string {
  return model ? `${giftId}::${model.toLowerCase()}` : giftId;
}

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
  max: number,
  model?: string
): Promise<void> {
  const key = trackKeyOf(giftId, model);
  await redis.sadd(chatsKey(botId), String(chatId));
  await redis.hset(trackedKey(botId, chatId), {
    [key]: JSON.stringify({ giftId, title, min, max, model }),
  });
  // Yangi chegara qo'yilganda eski bildirishnoma tarixini tozalaymiz -
  // hozirgi oraliqdagi nusxalar haqida qaytadan xabar berilsin.
  await redis.del(notifiedKey(botId, chatId, key));
}

export async function removeTracked(
  botId: string,
  chatId: number,
  giftId: string,
  model?: string
): Promise<boolean> {
  const key = trackKeyOf(giftId, model);
  const removed = await redis.hdel(trackedKey(botId, chatId), key);
  await redis.del(notifiedKey(botId, chatId, key));
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

/** Shu chat+kuzatuv uchun avval xabar qilingan nusxalar (slug) to'plamini oladi */
export async function getNotifiedSlugs(botId: string, chatId: number, giftId: string, model?: string): Promise<Set<string>> {
  const members = await redis.smembers(notifiedKey(botId, chatId, trackKeyOf(giftId, model)));
  return new Set(members);
}

/** Yangi xabar qilingan nusxalarni (slug) tarixga qo'shadi */
export async function markSlugsNotified(
  botId: string,
  chatId: number,
  giftId: string,
  slugs: string[],
  model?: string
): Promise<void> {
  if (slugs.length === 0) return;
  const [first, ...rest] = slugs;
  await redis.sadd(notifiedKey(botId, chatId, trackKeyOf(giftId, model)), first, ...rest);
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

export interface PendingCustomPrice {
  giftId: string;
  title: string;
}

export async function setPendingCustomPrice(
  botId: string,
  chatId: number,
  giftId: string,
  title: string
): Promise<void> {
  await redis.set(pendingKey(botId, chatId), JSON.stringify({ giftId, title }), { ex: PENDING_TTL_SEC });
}

export async function getPendingCustomPrice(botId: string, chatId: number): Promise<PendingCustomPrice | null> {
  const raw = await redis.get<unknown>(pendingKey(botId, chatId));
  if (raw == null) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as PendingCustomPrice;
}

export async function clearPendingCustomPrice(botId: string, chatId: number): Promise<void> {
  await redis.del(pendingKey(botId, chatId));
}
