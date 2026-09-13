import { TelegramClient } from "teleproto";
import { getAllTracked, getNotifiedSlugs, markSlugsNotified, getPausedChats, type TrackedGift } from "../lib/store";
import { fetchResaleListings, filterListings, type ListingInfo } from "../lib/gifts";
import { sendMessage } from "../lib/botApi";
import { getConfiguredBots, type BotConfig } from "../lib/bots";
import { tryAutoBuy, type AutoBuyResult } from "../lib/purchase";
import { alertRiskSignal } from "../lib/alerts";
import { markAlive } from "./watchdog";

// Tekshiruv oralig'ini qat'iy sobit qilmasdan, har safar shu oraliqda tasodifiy
// tanlaymiz - bir xil ritmda ishlashning "robot" izini kamaytirish uchun
// (tezlikka sezilarli ta'sir qilmaydi, 1500ms o'rtachaga yaqin qoladi).
const POLL_INTERVAL_MIN_MS = Number(process.env.POLL_INTERVAL_MIN_MS || 1200);
const POLL_INTERVAL_MAX_MS = Number(process.env.POLL_INTERVAL_MAX_MS || 1800);

function randomPollDelayMs(): number {
  return POLL_INTERVAL_MIN_MS + Math.floor(Math.random() * (POLL_INTERVAL_MAX_MS - POLL_INTERVAL_MIN_MS + 1));
}

// --- AVTOMATIK XARID (auto-buy) sozlamalari ---
// MUHIM: standart holat har doim ENG XAVFSIZ tomonga og'adi:
//  - AUTO_BUY_ENABLED aniq "true" bo'lmasa - funksiya butunlay o'chirilgan.
//  - AUTO_BUY_DRY_RUN aniq "false" bo'lmasa - hech qachon haqiqiy pul sarflanmaydi,
//    faqat "shuni sotib olardim" deb log/xabar chiqadi.
const AUTO_BUY_ENABLED = process.env.AUTO_BUY_ENABLED === "true";
const AUTO_BUY_DRY_RUN = process.env.AUTO_BUY_DRY_RUN !== "false";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatAutoBuyLine(r: AutoBuyResult): string | null {
  if (!r.attempted && r.reason === "disabled") return null;
  if (r.dryRun) return `🧪 <b>DRY RUN</b>: shuni sotib olar edim (${r.priceStars} ⭐) — haqiqiy xarid QILINMADI.`;
  if (r.success) return `✅ <b>Avtomatik sotib olindi!</b> (${r.priceStars} ⭐)`;
  if (r.reason === "price_exceeds_cap") return `⚠️ Avtomatik xarid o'tkazib yuborildi: narx sizning chegaradan oshib ketdi.`;
  if (r.reason === "daily_limit") return `⚠️ Avtomatik xarid o'tkazib yuborildi: kunlik limit allaqachon ishlatilgan.`;
  if (r.reason === "insufficient_balance")
    return `⚠️ Avtomatik xarid o'tkazib yuborildi: balans yetarli emas (${r.balance} ⭐ bor, ${r.priceStars} ⭐ kerak).`;
  if (r.reason === "form_price_exceeds_cap")
    return `⚠️ Avtomatik xarid o'tkazib yuborildi: forma qaytargan narx chegaradan oshib ketdi (${r.priceStars} ⭐).`;
  if (r.reason === "listing_taken")
    return `⏱️ Kechikdik — bu e'lon band bo'lib qoldi (boshqa xaridor ulgurib sotib olgan bo'lishi mumkin).`;
  if (r.reason === "form_error")
    return `⚠️ Avtomatik xarid o'tkazib yuborildi: xarid formasida muammo${r.error ? ` — ${escapeHtml(r.error)}` : ""}.`;
  if (r.success === false) return `❌ Avtomatik xarid muvaffaqiyatsiz: ${escapeHtml(r.error ?? "noma'lum xato")}`;
  return null;
}

async function checkOnce(client: TelegramClient): Promise<void> {
  const bots = getConfiguredBots();

  // Har bir bot+chat+kuzatuvni bitta ro'yxatga yig'amiz, so'ng giftId bo'yicha
  // guruhlaymiz - bir nechta kuzatuv (turli chat/Model/Backdrop) bitta giftId'ga
  // ishora qilishi mumkin, shunda ularning barchasiga BITTA MTProto so'rovi
  // yetadi (oldin har bir kuzatuv uchun alohida so'rov yuborilar, bu esa
  // ulanishni band qilib, /giftlar va Menu buyruqlariga javobni sekinlashtirardi).
  const entriesByGift = new Map<string, { bot: BotConfig; t: TrackedGift }[]>();
  for (const bot of bots) {
    const tracked = await getAllTracked(bot.id);
    const pausedChats = await getPausedChats(bot.id);
    const active = tracked.filter((t) => !pausedChats.has(String(t.chatId)));

    for (const t of active) {
      const list = entriesByGift.get(t.giftId);
      if (list) list.push({ bot, t });
      else entriesByGift.set(t.giftId, [{ bot, t }]);
    }
  }

  for (const [giftId, entries] of entriesByGift) {
    let listings: ListingInfo[];
    try {
      listings = await fetchResaleListings(giftId, 100, client);
    } catch (err) {
      console.error(`[poll] fetchResaleListings(${giftId}) xatosi:`, err);
      alertRiskSignal(err, `checkOnce.fetchResaleListings(${giftId})`).catch(() => {});
      continue;
    }
    if (listings.length === 0) continue;

    for (const { bot, t } of entries) {
      const filtered = filterListings(listings, t.min, t.max, t.model, t.backdrop);
      if (filtered.length === 0) continue;

      const alreadyNotified = await getNotifiedSlugs(bot.id, t.chatId, t.giftId, t.model, t.backdrop);
      const newListings = filtered.filter((l) => !alreadyNotified.has(l.slug));
      if (newListings.length === 0) continue;

      for (const listing of newListings) {
        // MUHIM: xabar tayyorlashdan OLDIN, birinchi navbatda xaridga harakat
        // qilamiz - tezlik hal qiluvchi bo'lgani uchun.
        const buyResult = await tryAutoBuy(
          AUTO_BUY_ENABLED,
          AUTO_BUY_DRY_RUN,
          listing.slug,
          listing.priceStars,
          t.max,
          client
        );

        const attrLines = [
          listing.model && `Model: ${escapeHtml(listing.model)}`,
          listing.symbol && `Symbol: ${escapeHtml(listing.symbol)}`,
          listing.backdrop && `Backdrop: ${escapeHtml(listing.backdrop)}`,
        ].filter(Boolean);
        const buyLine = formatAutoBuyLine(buyResult);

        const text =
          `🎁 <b>${escapeHtml(t.title)}</b> #${listing.num}\n` +
          (attrLines.length ? attrLines.join("\n") + "\n" : "") +
          `Narx: <b>${listing.priceStars} ⭐</b>\n` +
          `Sizning chegarangiz: ${t.min}-${t.max} ⭐\n` +
          (buyLine ? buyLine + "\n" : "") +
          `\n` +
          listing.link;

        await sendMessage(bot.token, t.chatId, text, {
          buttons: [{ text: "🎁 View Collectible", url: listing.link }],
          showLinkPreview: true,
        });
      }

      await markSlugsNotified(
        bot.id,
        t.chatId,
        t.giftId,
        newListings.map((l) => l.slug),
        t.model,
        t.backdrop
      );
    }
  }
}

export async function startPollLoop(client: TelegramClient): Promise<void> {
  console.log(
    `[poll] Tez tekshiruv sikli boshlandi (${POLL_INTERVAL_MIN_MS}-${POLL_INTERVAL_MAX_MS}ms tasodifiy oraliqda). ` +
      `Avtomatik xarid: ${AUTO_BUY_ENABLED ? (AUTO_BUY_DRY_RUN ? "YOQILGAN (DRY RUN)" : "YOQILGAN (HAQIQIY XARID!)") : "o'chirilgan"}.`
  );
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await checkOnce(client);
    } catch (err) {
      console.error("[poll] xatosi:", err);
      alertRiskSignal(err, "startPollLoop").catch(() => {});
    }
    markAlive("poll");
    await new Promise((r) => setTimeout(r, randomPollDelayMs()));
  }
}
