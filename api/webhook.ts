import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sendMessage } from "../lib/botApi";
import { getGiftCatalog } from "../lib/gifts";
import { addTracked, removeTracked, listTrackedForChat } from "../lib/store";

const HELP_TEXT =
  "Salom! Men Telegram kolleksion sovg'alar (gift) bozoridagi narx tushishini kuzataman.\n\n" +
  "Buyruqlar:\n" +
  "/listgifts — kuzatish mumkin bo'lgan sovg'alar ro'yxati (ID va hozirgi eng arzon narxi bilan)\n" +
  "/track &lt;gift_id&gt; &lt;min&gt; &lt;max&gt; — shu narx oralig'iga tushganda xabar berish\n" +
  "/list — siz kuzatayotgan sovg'alar\n" +
  "/untrack &lt;gift_id&gt; — kuzatuvdan olib tashlash\n\n" +
  "Masalan: /track 123456789 125 420";

function isAuthorized(req: VercelRequest): boolean {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return true; // sozlanmagan bo'lsa cheklovsiz (faqat dev uchun)
  return req.headers["x-telegram-bot-api-secret-token"] === secret;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(200).send("ok");
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).end();
    return;
  }

  const update = req.body as any;
  const msg = update?.message;

  // Eslatma: bu Vercel serverless funksiya, javob yuborilgach konteyner
  // to'xtatilishi mumkin - shuning uchun avval barcha ishni tugatamiz,
  // res.json()ni esa oxirida chaqiramiz (res.status(200).json({ok:true})ni
  // ishlov tugamasdan oldin yuborish xabar yuborilmay qolishiga olib kelishi mumkin).
  if (!msg?.text || !msg?.chat?.id) {
    res.status(200).json({ ok: true });
    return;
  }

  const chatId: number = msg.chat.id;
  const text: string = String(msg.text).trim();

  try {
    if (text === "/start" || text === "/help") {
      await sendMessage(chatId, HELP_TEXT);
    } else if (text === "/listgifts") {
      await handleListGifts(chatId);
    } else if (text.startsWith("/track")) {
      await handleTrack(chatId, text);
    } else if (text === "/list") {
      await handleList(chatId);
    } else if (text.startsWith("/untrack")) {
      await handleUntrack(chatId, text);
    } else {
      await sendMessage(chatId, "Buyruqni tushunmadim. /help ni yuboring.");
    }
  } catch (err) {
    console.error("webhook xatosi:", err);
    await sendMessage(chatId, "⚠️ Ichki xatolik yuz berdi, keyinroq urinib ko'ring.").catch(() => {});
  }

  res.status(200).json({ ok: true });
}

async function handleListGifts(chatId: number): Promise<void> {
  const catalog = await getGiftCatalog();
  const limited = catalog.filter((g) => g.limited);

  if (limited.length === 0) {
    await sendMessage(chatId, "Hozircha kolleksion sovg'alar topilmadi.");
    return;
  }

  const lines = limited
    .slice(0, 60)
    .map((g) => {
      const floor = g.resellMinStars != null ? `${g.resellMinStars} ⭐` : "resale yo'q";
      return `<code>${g.id}</code> — ${escapeHtml(g.title)} (floor: ${floor})`;
    });

  await sendMessage(
    chatId,
    `Kolleksion sovg'alar (ID — nomi — hozirgi eng arzon narxi):\n\n${lines.join("\n")}\n\n` +
      `Kuzatish uchun: /track &lt;gift_id&gt; &lt;min&gt; &lt;max&gt;`
  );
}

async function handleTrack(chatId: number, text: string): Promise<void> {
  const parts = text.split(/\s+/);
  const giftId = parts[1];
  const min = Number(parts[2]);
  const max = Number(parts[3]);

  if (!giftId || !Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    await sendMessage(chatId, "Foydalanish: /track <gift_id> <min> <max>\nMasalan: /track 123456789 125 420");
    return;
  }

  const catalog = await getGiftCatalog();
  const gift = catalog.find((g) => g.id === giftId);

  if (!gift) {
    await sendMessage(
      chatId,
      "Bunday gift_id topilmadi. To'g'ri ID uchun /listgifts buyrug'idan foydalaning."
    );
    return;
  }

  await addTracked(chatId, giftId, gift.title, min, max);
  await sendMessage(
    chatId,
    `✅ Kuzatuvga qo'shildi: <b>${escapeHtml(gift.title)}</b> (${min}-${max} ⭐)\n` +
      `Hozirgi floor narx: ${gift.resellMinStars != null ? `${gift.resellMinStars} ⭐` : "resale yo'q"}`
  );
}

async function handleList(chatId: number): Promise<void> {
  const items = await listTrackedForChat(chatId);
  if (items.length === 0) {
    await sendMessage(chatId, "Hozircha hech narsa kuzatilmayapti. /listgifts va /track dan foydalaning.");
    return;
  }

  const lines = items.map((t) => `<code>${t.giftId}</code> — ${escapeHtml(t.title)} (${t.min}-${t.max} ⭐)`);
  await sendMessage(chatId, `Sizning kuzatuvlaringiz:\n\n${lines.join("\n")}`);
}

async function handleUntrack(chatId: number, text: string): Promise<void> {
  const parts = text.split(/\s+/);
  const giftId = parts[1];

  if (!giftId) {
    await sendMessage(chatId, "Foydalanish: /untrack <gift_id>");
    return;
  }

  const removed = await removeTracked(chatId, giftId);
  await sendMessage(chatId, removed ? "✅ Kuzatuvdan olib tashlandi." : "Bu ID kuzatuvda topilmadi.");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
