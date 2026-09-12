import { Redis } from "@upstash/redis";
import { sendOpsAlert } from "../lib/alerts";

const redis = Redis.fromEnv();

const CLEAN_SHUTDOWN_KEY = "gifts:worker:clean_shutdown";
const LAST_HEARTBEAT_KEY = "gifts:worker:last_heartbeat_at";
const CLEAN_SHUTDOWN_TTL_SEC = 60 * 60;

// "2-3 daqiqadan ortiq faoliyatsizlik" so'roviga muvofiq - ikkisining o'rtasi.
const STALE_THRESHOLD_MS = Number(process.env.WATCHDOG_STALE_MS || 150_000);
const CHECK_INTERVAL_MS = 30_000;

const lastAlive = new Map<string, number>();

/**
 * Har bir komponent (narx tekshiruv sikli, har bir botning buyruq sikli) har
 * safar bitta iteratsiyani (muvaffaqiyatli yoki xato bilan) tugatganda shu
 * orqali "men hali tirikman" deb belgilaydi. Agar biror komponent haqiqatan
 * ham qotib qolsa (masalan cheksiz kutish holatida), u shu chaqiruvni
 * qilolmay qoladi va watchdog buni pastda aniqlaydi.
 */
export function markAlive(component: string): void {
  lastAlive.set(component, Date.now());
}

/**
 * Ishga tushishda oldingi sessiya QANDAY tugaganini tekshiradi. Agar oldin
 * ishlagan (heartbeat mavjud) bo'lsa-yu, "toza to'xtash" belgisi topilmasa -
 * demak jarayon kutilmagan tarzda (crash, xotira yetishmovchiligi, server
 * qayta yuklanishi) to'xtagan va endi (pm2 avtomatik yoki qo'lda) qayta
 * ishga tushirilgan. Har doim keyingi tekshiruv uchun belgini tozalab qo'yadi -
 * shu bilan joriy sessiya "toza yopilmagan" holatdan boshlanadi va faqat
 * `registerGracefulShutdown` haqiqatan chaqirilsa "toza" deb belgilanadi.
 */
export async function checkForUncleanRestart(): Promise<void> {
  try {
    const [lastHeartbeat, cleanFlag] = await Promise.all([
      redis.get<number | string>(LAST_HEARTBEAT_KEY),
      redis.get<string>(CLEAN_SHUTDOWN_KEY),
    ]);

    if (lastHeartbeat != null && !cleanFlag) {
      const text =
        "⚠️ <b>Bot javob bermay qolgandi va qayta ishga tushdi</b>\n\n" +
        "Oldingi sessiya \"toza\" yopilmagan holda tugagan (crash, xotira yetishmovchiligi " +
        "yoki server qayta yuklanishi bo'lishi mumkin). pm2 uni avtomatik qayta ishga tushirdi. " +
        "Server loglarini tekshirib ko'rish tavsiya etiladi.";
      await sendOpsAlert(text, "unclean_restart");
    }
  } catch (err) {
    console.error("[watchdog] checkForUncleanRestart xatosi:", err);
  } finally {
    await redis.del(CLEAN_SHUTDOWN_KEY).catch(() => {});
  }
}

async function markCleanShutdown(): Promise<void> {
  await redis.set(CLEAN_SHUTDOWN_KEY, "1", { ex: CLEAN_SHUTDOWN_TTL_SEC }).catch(() => {});
}

/**
 * SIGINT/SIGTERM kelganda (pm2 restart/stop, Ctrl+C) - "toza to'xtadim" deb
 * Redis'ga belgilab, keyin chiqadi. Shu orqali qasddan qilingan restart
 * (deploy) bilan kutilmagan crash bir-biridan ajratiladi - faqat ikkinchisi
 * ogohlantirish yuboradi.
 */
export function registerGracefulShutdown(): void {
  const handler = (signal: string) => {
    console.log(`[watchdog] ${signal} qabul qilindi - toza to'xtash belgilanmoqda...`);
    markCleanShutdown().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

/**
 * Har CHECK_INTERVAL_MS'da bir marta ro'yxatdagi komponentlarning oxirgi
 * "tirik" belgisini tekshiradi - agar biror komponent STALE_THRESHOLD_MS'dan
 * ortiq vaqt davomida hech narsa bildirmagan bo'lsa (lekin jarayonning o'zi
 * hali "online" - aks holda pm2 uni allaqachon qayta ishga tushirgan
 * bo'lardi), ogohlantirish yuboradi.
 */
export function startStallWatchdog(): void {
  const tick = async () => {
    const now = Date.now();
    await redis.set(LAST_HEARTBEAT_KEY, now, { ex: 24 * 60 * 60 }).catch(() => {});

    for (const [component, ts] of lastAlive) {
      const staleMs = now - ts;
      if (staleMs > STALE_THRESHOLD_MS) {
        const staleMin = (staleMs / 60000).toFixed(1);
        const text =
          `⚠️ <b>Bot javob bermayapti / to'xtab qoldi</b>\n\n` +
          `Komponent: <code>${component}</code>\n` +
          `Oxirgi faoliyatdan beri: ~${staleMin} daqiqa\n\n` +
          `Jarayon hali "online" ko'rinishi mumkin, lekin ichki sikli qotib qolgan bo'lishi mumkin - ` +
          `server loglarini tekshirib, kerak bo'lsa qo'lda qayta ishga tushiring (pm2 restart).`;
        await sendOpsAlert(text, `stall:${component}`);
      }
    }
  };

  tick(); // darhol bir marta ham yozib qo'yamiz - crash keyingi safar aniqlanishi uchun
  setInterval(tick, CHECK_INTERVAL_MS);
}
