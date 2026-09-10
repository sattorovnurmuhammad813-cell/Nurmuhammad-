import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

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

// Vercel bir vaqtning o'zida bir nechta konteyner (webhook + cron) ishga
// tushirishi mumkin. Oldin har bir konteyner o'z ulanishini "sovuq start"
// davomida ochiq saqlagan (singleton) - lekin bitta konteynerning ulanishi
// hali OCHIQ turgan paytda boshqa (yangi) konteyner ham ulansa, ikkalasi
// ham bir xil auth_key bilan PARALLEL ochiq qolib ketadi va Telegram buni
// shubhali deb hisoblab AUTH_KEY_DUPLICATED xatosi bilan bloklaydi - buni
// faqat so'rovlarni navbatga qo'yish (lock) yetarli emas edi, chunki
// ulanishning o'zi lock tashqarisida ochiq qolardi.
//
// Shu sabab endi har bir MTProto operatsiyasi uchun: lock olinadi -> YANGI
// ulanish ochiladi -> so'rov bajariladi -> ulanish DARHOL yopiladi -> lock
// bo'shatiladi. Shunday qilib bir vaqtning o'zida butun loyiha bo'yicha
// hech qachon bittadan ortiq ochiq ulanish bo'lmaydi.
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
 * ULANISH (nafaqat so'rov) bo'lishini kafolatlaydi (AUTH_KEY_DUPLICATED
 * oldini olish uchun).
 */
export async function withTelegramLock<T>(fn: (client: TelegramClient) => Promise<T>): Promise<T> {
  const id = `${Date.now()}-${Math.random()}`;
  const acquired = await acquireLock(id);
  if (!acquired) {
    throw new Error("Telegram mijozi band (lock timeout) - keyinroq qayta urining.");
  }

  let client: TelegramClient | null = null;
  try {
    client = await createClient();
    return await fn(client);
  } finally {
    if (client) {
      await client.disconnect().catch(() => {});
    }
    await releaseLock(id);
  }
}
