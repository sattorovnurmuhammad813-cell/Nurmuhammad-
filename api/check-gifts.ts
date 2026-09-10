import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAllTracked, getNotifiedSlugs, markSlugsNotified, getPausedChats } from "../lib/store";
import { getListingsInRange } from "../lib/gifts";
import { sendMessage } from "../lib/botApi";
import { getConfiguredBots } from "../lib/bots";

function isAuthorized(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // CRON_SECRET sozlanmagan bo'lsa, cheklovsiz (faqat dev uchun)

  const authHeader = req.headers["authorization"];
  if (authHeader === `Bearer ${secret}`) return true; // Vercel native Cron shu headerni qo'shadi

  const querySecret = req.query.secret;
  if (typeof querySecret === "string" && querySecret === secret) return true; // tashqi pinger uchun

  return false;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    const bots = getConfiguredBots();
    if (bots.length === 0) {
      res.status(200).json({ checked: 0, notified: 0, error: "hech qanday bot sozlanmagan" });
      return;
    }

    let checked = 0;
    let notified = 0;

    for (const bot of bots) {
      const tracked = await getAllTracked(bot.id);
      const pausedChats = await getPausedChats(bot.id);
      const active = tracked.filter((t) => !pausedChats.has(String(t.chatId)));
      checked += active.length;

      for (const t of active) {
        const listings = await getListingsInRange(t.giftId, t.min, t.max, t.model);
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
          notified++;
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

    res.status(200).json({ checked, notified, bots: bots.map((b) => b.id) });
  } catch (err) {
    console.error("check-gifts xatosi:", err);
    res.status(500).json({ error: "internal_error" });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
