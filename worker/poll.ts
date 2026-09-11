import { TelegramClient } from "teleproto";
import { getAllTracked, getNotifiedSlugs, markSlugsNotified, getPausedChats } from "../lib/store";
import { getListingsInRange } from "../lib/gifts";
import { sendMessage } from "../lib/botApi";
import { getConfiguredBots } from "../lib/bots";
import { tryAutoBuy, type AutoBuyResult } from "../lib/purchase";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1500);

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
  if (r.reason === "form_error" || r.reason === "form_price_exceeds_cap")
    return `⚠️ Avtomatik xarid o'tkazib yuborildi: xarid formasida muammo.`;
  if (r.success === false) return `❌ Avtomatik xarid muvaffaqiyatsiz: ${escapeHtml(r.error ?? "noma'lum xato")}`;
  return null;
}

async function checkOnce(client: TelegramClient): Promise<void> {
  const bots = getConfiguredBots();

  for (const bot of bots) {
    const tracked = await getAllTracked(bot.id);
    const pausedChats = await getPausedChats(bot.id);
    const active = tracked.filter((t) => !pausedChats.has(String(t.chatId)));

    for (const t of active) {
      const listings = await getListingsInRange(t.giftId, t.min, t.max, t.model, t.backdrop, 100, client);
      if (listings.length === 0) continue;

      const alreadyNotified = await getNotifiedSlugs(bot.id, t.chatId, t.giftId, t.model, t.backdrop);
      const newListings = listings.filter((l) => !alreadyNotified.has(l.slug));
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
    `[poll] Tez tekshiruv sikli boshlandi (har ${POLL_INTERVAL_MS}ms). ` +
      `Avtomatik xarid: ${AUTO_BUY_ENABLED ? (AUTO_BUY_DRY_RUN ? "YOQILGAN (DRY RUN)" : "YOQILGAN (HAQIQIY XARID!)") : "o'chirilgan"}.`
  );
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await checkOnce(client);
    } catch (err) {
      console.error("[poll] xatosi:", err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
