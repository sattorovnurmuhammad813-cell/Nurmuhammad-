import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

/**
 * Serverless funksiya har chaqirilganda yangi konteynerda ishga tushishi
 * mumkin bo'lgani uchun bu modul darajasidagi promise faqat bitta "sovuq
 * start" davomida keshlanadi - u global qat'iy ulanish emas.
 */
let clientPromise: Promise<TelegramClient> | null = null;

async function createClient(): Promise<TelegramClient> {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const sessionString = process.env.TELEGRAM_SESSION_STRING;

  if (!apiId || !apiHash || !sessionString) {
    throw new Error(
      "TELEGRAM_API_ID, TELEGRAM_API_HASH yoki TELEGRAM_SESSION_STRING " +
        "environment variable sifatida sozlanmagan. README.md dagi " +
        "o'rnatish bo'limiga qarang."
    );
  }

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.connect();
  return client;
}

export async function getClient(): Promise<TelegramClient> {
  if (!clientPromise) {
    clientPromise = createClient().catch((err) => {
      // Xato bo'lsa, keyingi chaqiruvda qayta urinib ko'rish uchun keshni tozalaymiz
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

// Vercel bir vaqtning o'zida bir nechta konteyner (webhook + cron) ishga
// tushirishi mumkin - agar ularning har biri bir xil sessiya bilan bir
// vaqtda alohida ulanish ochsa, Telegram buni shubhali deb hisoblab
// AUTH_KEY_DUPLICATED xatosi bilan bloklaydi. Shu sabab barcha MTProto
// so'rovlari Redis orqali navbatga qo'yiladi - bir vaqtning o'zida
// butun loyiha bo'yicha faqat bitta so'rov bajariladi.
const LOCK_KEY = "gifts:mtproto:lock";
const LOCK_TTL_MS = 20_000;
const ACQUIRE_TIMEOUT_MS = 25_000;
const RETRY_DELAY_MS = 300;

async function acquireLock(id: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ACQUIRE_TIMEOUT_MS) {
    const ok = await redis.set(LOCK_KEY, id, { nx: true, px: LOCK_TTL_MS });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  return false;
}

async function releaseLock(id: string): Promise<void> {
  const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
  await redis.eval(script, [LOCK_KEY], [id]);
}

/**
 * MTProto orqali Telegram'ga so'rov yuboradigan har qanday funksiya shu
 * yordamchi orqali chaqirilishi kerak - bu bir vaqtning o'zida faqat bitta
 * ulanish/so'rov bo'lishini kafolatlaydi (AUTH_KEY_DUPLICATED oldini olish uchun).
 */
export async function withTelegramLock<T>(fn: (client: TelegramClient) => Promise<T>): Promise<T> {
  const id = `${Date.now()}-${Math.random()}`;
  const acquired = await acquireLock(id);
  if (!acquired) {
    throw new Error("Telegram mijozi band (lock timeout) - keyinroq qayta urining.");
  }
  try {
    const client = await getClient();
    return await fn(client);
  } finally {
    await releaseLock(id);
  }
}
