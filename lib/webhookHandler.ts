import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sendMessage } from "./botApi";
import { getGiftCatalog, getCheapestListing } from "./gifts";
import { addTracked, removeTracked, listTrackedForChat } from "./store";
import type { BotConfig } from "./bots";

const HELP_TEXT =
  "Salom! Men Telegram kolleksion sovg'alar (gift) bozoridagi narx tushishini kuzataman.\n\n" +
  "Buyruqlar:\n" +
  "/listgifts — kuzatish mumkin bo'lgan sovg'alar ro'yxati (ID va hozirgi eng arzon narxi bilan)\n" +
  "/track &lt;gift_id&gt; &lt;min&gt; &lt;max&gt; — shu narx oralig'iga tushganda xabar berish\n" +
  "/list — siz kuzatayotgan sovg'alar\n" +
  "/untrack &lt;gift_id&gt; — kuzatuvdan olib tashlash\n\n" +
  "Masalan: /track 123456789 125 420";

function isAuthorized(req: VercelRequest, bot: BotConfig): boolean {
  if (!bot.webhookSecret) return true; // sozlanmagan bo'lsa cheklovsiz (faqat dev uchun)
  return req.headers["x-telegram-bot-api-secret-token"] === bot.webhookSecret;
}

export async function handleWebhook(req: VercelRequest, res: VercelResponse, bot: BotConfig): Promise<void> {
  if (req.method !== "POST") {
    res.status(200).send("ok");
    return;
  }

  if (!isAuthorized(req, bot)) {
    res.status(401).end();
    return;
  }

  const update = req.body as any;
  const msg = update?.message;

  // Eslatma: bu Vercel serverless funksiya, javob yuborilgach konteyner
  // to'xtatilishi mumkin - shuning uchun avval barcha ishni tugatamiz,
  // res.json()ni esa oxirida chaqiramiz.
  if (!msg?.text || !msg?.chat?.id) {
    res.status(200).json({ ok: true });
    return;
  }

  const chatId: number = msg.chat.id;
  const text: string = String(msg.text).trim();

  try {
    if (text === "/start" || text === "/help") {
      await sendMessage(bot.token, chatId, HELP_TEXT);
    } else if (text === "/listgifts") {
      await handleListGifts(bot, chatId);
    } else if (text.startsWith("/track")) {
      await handleTrack(bot, chatId, text);
    } else if (text === "/list") {
      await handleList(bot, chatId);
    } else if (text.startsWith("/untrack")) {
      await handleUntrack(bot, chatId, text);
    } else {
      await sendMessage(bot.token, chatId, "Buyruqni tushunmadim. /help ni yuboring.");
    }
  } catch (err) {
    console.error(`webhook xatosi (bot ${bot.id}):`, err);
    await sendMessage(bot.token, chatId, "⚠️ Ichki xatolik yuz berdi, keyinroq urinib ko'ring.").catch(() => {});
  }

  res.status(200).json({ ok: true });
}

async function handleListGifts(bot: BotConfig, chatId: number): Promise<void> {
  const catalog = await getGiftCatalog();
  const limited = catalog.filter((g) => g.limited);

  if (limited.length === 0) {
    await sendMessage(bot.token, chatId, "Hozircha kolleksion sovg'alar topilmadi.");
    return;
  }

  const lines = limited.slice(0, 60).map((g) => {
    const floor = g.resellMinStars != null ? `${g.resellMinStars} ⭐` : "resale yo'q";
    return `<code>${g.id}</code> — ${escapeHtml(g.title)} (floor: ${floor})`;
  });

  await sendMessage(
    bot.token,
    chatId,
    `Kolleksion sovg'alar (ID — nomi — hozirgi eng arzon narxi):\n\n${lines.join("\n")}\n\n` +
      `Kuzatish uchun: /track &lt;gift_id&gt; &lt;min&gt; &lt;max&gt;`
  );
}

async function handleTrack(bot: BotConfig, chatId: number, text: string): Promise<void> {
  const parts = text.split(/\s+/);
  const giftId = parts[1];
  const min = Number(parts[2]);
  const max = Number(parts[3]);

  if (!giftId || !Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    await sendMessage(
      bot.token,
      chatId,
      "Foydalanish: /track <gift_id> <min> <max>\nMasalan: /track 123456789 125 420"
    );
    return;
  }

  const catalog = await getGiftCatalog();
  const gift = catalog.find((g) => g.id === giftId);

  if (!gift) {
    await sendMessage(
      bot.token,
      chatId,
      "Bunday gift_id topilmadi. To'g'ri ID uchun /listgifts buyrug'idan foydalaning."
    );
    return;
  }

  await addTracked(bot.id, chatId, giftId, gift.title, min, max);

  const listing = gift.resellMinStars != null ? await getCheapestListing(giftId) : null;

  const attrLines = listing
    ? [
        listing.model && `Model: ${escapeHtml(listing.model)}`,
        listing.symbol && `Symbol: ${escapeHtml(listing.symbol)}`,
        listing.backdrop && `Backdrop: ${escapeHtml(listing.backdrop)}`,
      ].filter(Boolean)
    : [];

  const confirmText =
    `✅ Kuzatuvga qo'shildi: <b>${escapeHtml(gift.title)}</b>${listing ? ` #${listing.num}` : ""} (${min}-${max} ⭐)\n` +
    (attrLines.length ? attrLines.join("\n") + "\n" : "") +
    `Hozirgi floor narx: ${gift.resellMinStars != null ? `${gift.resellMinStars} ⭐` : "resale yo'q"}` +
    (listing ? `\n\n${listing.link}` : "");

  await sendMessage(bot.token, chatId, confirmText, {
    buttons: listing ? [{ text: "🎁 View Collectible", url: listing.link }] : undefined,
    showLinkPreview: Boolean(listing),
  });
}

async function handleList(bot: BotConfig, chatId: number): Promise<void> {
  const items = await listTrackedForChat(bot.id, chatId);
  if (items.length === 0) {
    await sendMessage(bot.token, chatId, "Hozircha hech narsa kuzatilmayapti. /listgifts va /track dan foydalaning.");
    return;
  }

  const lines = items.map((t) => `<code>${t.giftId}</code> — ${escapeHtml(t.title)} (${t.min}-${t.max} ⭐)`);
  await sendMessage(bot.token, chatId, `Sizning kuzatuvlaringiz:\n\n${lines.join("\n")}`);
}

async function handleUntrack(bot: BotConfig, chatId: number, text: string): Promise<void> {
  const parts = text.split(/\s+/);
  const giftId = parts[1];

  if (!giftId) {
    await sendMessage(bot.token, chatId, "Foydalanish: /untrack <gift_id>");
    return;
  }

  const removed = await removeTracked(bot.id, chatId, giftId);
  await sendMessage(bot.token, chatId, removed ? "✅ Kuzatuvdan olib tashlandi." : "Bu ID kuzatuvda topilmadi.");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
