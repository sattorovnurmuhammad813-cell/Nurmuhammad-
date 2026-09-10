import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";

/**
 * Bu VPS'da doimiy ishlaydigan worker uchun - Vercel'dagi lib/telegramClient.ts'dan
 * farqli o'laroq, ulanish BIR MARTA ochiladi va butun process umri davomida
 * saqlanadi (hech qachon qayta-qayta ochib-yopilmaydi). Bu bitta process bo'lgani
 * uchun AUTH_KEY_DUPLICATED xavfi yo'q - faqat BITTA ulanish bor, boshqa hech
 * qanday process (Vercel ham) shu bilan bir vaqtda ulanmasligi kerak.
 *
 * MUHIM: Worker ishga tushirilgach, Vercel'dagi check-gifts cron'ini albatta
 * TO'XTATING (cron-job.org'da Disable qiling) - aks holda ikkala tomon ham
 * bir xil sessiya bilan ulanib, yana AUTH_KEY_DUPLICATED xatosiga olib keladi.
 */
let client: TelegramClient | null = null;

export async function getUserClient(): Promise<TelegramClient> {
  if (client) return client;

  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const sessionString = process.env.TELEGRAM_SESSION_STRING;

  if (!apiId || !apiHash || !sessionString) {
    throw new Error(
      "TELEGRAM_API_ID, TELEGRAM_API_HASH yoki TELEGRAM_SESSION_STRING sozlanmagan (.env faylni tekshiring)."
    );
  }

  const c = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 10,
  });

  await c.connect();
  console.log("[telegramClient] MTProto ulandi (doimiy ulanish).");
  client = c;
  return c;
}
