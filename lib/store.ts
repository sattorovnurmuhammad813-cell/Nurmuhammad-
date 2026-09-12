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
  /** Agar berilgan bo'lsa, faqat shu Backdrop atributiga ega nusxalar haqida xabar beriladi */
  backdrop?: string;
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
// gift (va tanlangan Model/Backdrop) kutilayotganini saqlaydi - keyingi oddiy
// (buyruq bo'lmagan) xabar shu gift uchun maksimal narx sifatida talqin qilinadi.
// 5 daqiqadan keyin o'zi tozalanadi.
const pendingKey = (botId: string, chatId: number) => `gifts:${botId}:pending:${chatId}`;
const PENDING_TTL_SEC = 300;

/**
 * Bitta gift_id'ni bir nechta (masalan turli Model/Backdrop bo'yicha) alohida-
 * alohida kuzatish mumkin bo'lishi uchun hash maydon kaliti giftId+model+backdrop'dan
 * tuziladi.
 */
export function trackKeyOf(giftId: string, model?: string, backdrop?: string): string {
  let key = giftId;
  if (model) key += `::m=${model.toLowerCase()}`;
  if (backdrop) key += `::b=${backdrop.toLowerCase()}`;
  return key;
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
  model?: string,
  backdrop?: string
): Promise<void> {
  const key = trackKeyOf(giftId, model, backdrop);
  await redis.sadd(chatsKey(botId), String(chatId));
  await redis.hset(trackedKey(botId, chatId), {
    [key]: JSON.stringify({ giftId, title, min, max, model, backdrop }),
  });
  // Yangi chegara qo'yilganda eski bildirishnoma tarixini tozalaymiz -
  // hozirgi oraliqdagi nusxalar haqida qaytadan xabar berilsin.
  await redis.del(notifiedKey(botId, chatId, key));
}

export async function removeTracked(
  botId: string,
  chatId: number,
  giftId: string,
  model?: string,
  backdrop?: string
): Promise<boolean> {
  const key = trackKeyOf(giftId, model, backdrop);
  let removed = await redis.hdel(trackedKey(botId, chatId), key);
  await redis.del(notifiedKey(botId, chatId, key));

  // Backdrop qo'llab-quvvatlanishidan OLDIN trackKeyOf faqat "giftId::model"
  // (pastki registrda, "m=" prefiksisiz) formatidan foydalangan. O'sha davrda
  // qo'shilgan Model'li yozuvlar hech qachon yangi formatga o'tkazilmagan -
  // shu sabab ular removeTracked/removeAllTrackedForGift/untrack orqali umuman
  // o'chmay qolgan edi (kalit hech qachon mos kelmasgani uchun). Backdrop'siz
  // holatda shu eski formatni ham sinab ko'ramiz - shunda eski yozuvlar ham
  // muvaffaqiyatli o'chadi.
  if (model && !backdrop) {
    const legacyKey = `${giftId}::${model.toLowerCase()}`;
    const legacyRemoved = await redis.hdel(trackedKey(botId, chatId), legacyKey);
    await redis.del(notifiedKey(botId, chatId, legacyKey));
    removed += legacyRemoved;
  }

  return removed > 0;
}

/**
 * Shu gift_id uchun BARCHA kuzatuvlarni (Model/Backdrop kombinatsiyalaridan
 * qat'iy nazar) birdaniga o'chiradi - /giftlar'dagi 🗑️ tugmasi uchun.
 */
export async function removeAllTrackedForGift(botId: string, chatId: number, giftId: string): Promise<number> {
  const items = await listTrackedForChat(botId, chatId);
  const matching = items.filter((t) => t.giftId === giftId);
  for (const t of matching) {
    await removeTracked(botId, chatId, giftId, t.model, t.backdrop);
  }
  return matching.length;
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
export async function getNotifiedSlugs(
  botId: string,
  chatId: number,
  giftId: string,
  model?: string,
  backdrop?: string
): Promise<Set<string>> {
  const members = await redis.smembers(notifiedKey(botId, chatId, trackKeyOf(giftId, model, backdrop)));
  return new Set(members);
}

/** Yangi xabar qilingan nusxalarni (slug) tarixga qo'shadi */
export async function markSlugsNotified(
  botId: string,
  chatId: number,
  giftId: string,
  slugs: string[],
  model?: string,
  backdrop?: string
): Promise<void> {
  if (slugs.length === 0) return;
  const [first, ...rest] = slugs;
  await redis.sadd(notifiedKey(botId, chatId, trackKeyOf(giftId, model, backdrop)), first, ...rest);
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
  model?: string;
  backdrop?: string;
}

export async function setPendingCustomPrice(
  botId: string,
  chatId: number,
  giftId: string,
  title: string,
  model?: string,
  backdrop?: string
): Promise<void> {
  await redis.set(pendingKey(botId, chatId), JSON.stringify({ giftId, title, model, backdrop }), {
    ex: PENDING_TTL_SEC,
  });
}

export async function getPendingCustomPrice(botId: string, chatId: number): Promise<PendingCustomPrice | null> {
  const raw = await redis.get<unknown>(pendingKey(botId, chatId));
  if (raw == null) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as PendingCustomPrice;
}

export async function clearPendingCustomPrice(botId: string, chatId: number): Promise<void> {
  await redis.del(pendingKey(botId, chatId));
}
