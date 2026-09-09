import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";

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
