import { TelegramClient } from "teleproto";
import { getAllTracked, getNotifiedSlugs, markSlugsNotified, getPausedChats } from "../lib/store";
import { getListingsInRange } from "../lib/gifts";
import { sendMessage } from "../lib/botApi";
import { getConfiguredBots } from "../lib/bots";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1500);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function checkOnce(client: TelegramClient): Promise<void> {
  const bots = getConfiguredBots();

  for (const bot of bots) {
    const tracked = await getAllTracked(bot.id);
    const pausedChats = await getPausedChats(bot.id);
    const active = tracked.filter((t) => !pausedChats.has(String(t.chatId)));

    for (const t of active) {
      const listings = await getListingsInRange(t.giftId, t.min, t.max, t.model, 100, client);
      if (listings.length === 0) continue;

      const alreadyNotified = await getNotifiedSlugs(bot.id, t.chatId, t.giftId, t.model);
      const newListings = listings.filter((l) => !alreadyNotified.has(l.slug));
      if (newListings.length === 0) continue;

      for (const listing of newListings) {
        const attrLines = [
          listing.model && `Model: ${escapeHtml(listing.model)}`,
          listing.symbol && `Symbol: ${escapeHtml(listing.symbol)}`,
          listing.backdrop && `Backdrop: ${escapeHtml(listing.backdrop)}`,
        ].filter(Boolean);

        const text =
          `🎁 <b>${escapeHtml(t.title)}</b> #${listing.num}\n` +
          (attrLines.length ? attrLines.join("\n") + "\n" : "") +
          `Narx: <b>${listing.priceStars} ⭐</b>\n` +
          `Sizning chegarangiz: ${t.min}-${t.max} ⭐\n\n` +
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
        t.model
      );
    }
  }
}

export async function startPollLoop(client: TelegramClient): Promise<void> {
  console.log(`[poll] Tez tekshiruv sikli boshlandi (har ${POLL_INTERVAL_MS}ms).`);
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
