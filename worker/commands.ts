import { TelegramClient } from "teleproto";
import { sendMessage } from "../lib/botApi";
import { getGiftCatalog } from "../lib/gifts";
import { addTracked, removeTracked, listTrackedForChat, setPaused, getPausedChats } from "../lib/store";
import type { BotConfig } from "../lib/bots";

const HELP_TEXT =
  "Salom! Men Telegram kolleksion sovg'alar (gift) bozoridagi narx tushishini kuzataman.\n\n" +
  "Buyruqlar:\n" +
  "/listgifts — kuzatish mumkin bo'lgan sovg'alar ro'yxati (ID va hozirgi eng arzon narxi bilan)\n" +
  "/track &lt;gift_id&gt; &lt;min&gt; &lt;max&gt; [model nomi] — shu narx oralig'iga tushganda xabar berish. " +
  "Model nomi ixtiyoriy — berilsa, faqat aynan shu Model atributiga ega nusxalar haqida xabar keladi\n" +
  "/list — siz kuzatayotgan sovg'alar\n" +
  "/untrack &lt;gift_id&gt; [model nomi] — kuzatuvdan olib tashlash\n" +
  "/pause — barcha kuzatuvni vaqtincha to'xtatish (xabar yuborilmaydi)\n" +
  "/resume — kuzatuvni qayta yoqish\n" +
  "/status — bot holati (faol/to'xtatilgan)\n\n" +
  "Masalan: /track 123456789 125 420\n" +
  "Yoki aniq model bilan: /track 123456789 500 1500 Stargazer";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function handleListGifts(bot: BotConfig, chatId: number, client: TelegramClient): Promise<void> {
  const catalog = await getGiftCatalog(false, client);
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

async function handleTrack(bot: BotConfig, chatId: number, text: string, client: TelegramClient): Promise<void> {
  const parts = text.split(/\s+/);
  const giftId = parts[1];
  const min = Number(parts[2]);
  const max = Number(parts[3]);
  const model = parts.slice(4).join(" ") || undefined;

  if (!giftId || !Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    await sendMessage(
      bot.token,
      chatId,
      "Foydalanish: /track <gift_id> <min> <max> [model nomi]\nMasalan: /track 123456789 125 420"
    );
    return;
  }

  const catalog = await getGiftCatalog(false, client);
  const gift = catalog.find((g) => g.id === giftId);

  if (!gift) {
    await sendMessage(
      bot.token,
      chatId,
      "Bunday gift_id topilmadi. To'g'ri ID uchun /listgifts buyrug'idan foydalaning."
    );
    return;
  }

  await addTracked(bot.id, chatId, giftId, gift.title, min, max, model);

  await sendMessage(
    bot.token,
    chatId,
    `✅ Kuzatuvga qo'shildi: <b>${escapeHtml(gift.title)}</b>${model ? ` — Model: <b>${escapeHtml(model)}</b>` : ""} (${min}-${max} ⭐)\n` +
      `Hozirgi floor narx: ${gift.resellMinStars != null ? `${gift.resellMinStars} ⭐` : "resale yo'q"}\n\n` +
      `Shu oralig'dagi barcha nusxalar haqida bir necha soniya ichida alohida-alohida xabar keladi.`
  );
}

async function handleList(bot: BotConfig, chatId: number): Promise<void> {
  const items = await listTrackedForChat(bot.id, chatId);
  if (items.length === 0) {
    await sendMessage(bot.token, chatId, "Hozircha hech narsa kuzatilmayapti. /listgifts va /track dan foydalaning.");
    return;
  }

  const lines = items.map(
    (t) =>
      `<code>${t.giftId}</code> — ${escapeHtml(t.title)}${t.model ? ` — Model: <b>${escapeHtml(t.model)}</b>` : ""} (${t.min}-${t.max} ⭐)`
  );
  await sendMessage(bot.token, chatId, `Sizning kuzatuvlaringiz:\n\n${lines.join("\n")}`);
}

async function handleStatus(bot: BotConfig, chatId: number): Promise<void> {
  const items = await listTrackedForChat(bot.id, chatId);
  const pausedChats = await getPausedChats(bot.id);
  const isPaused = pausedChats.has(String(chatId));

  await sendMessage(
    bot.token,
    chatId,
    `Bot holati: ${isPaused ? "⏸ To'xtatilgan" : "▶️ Faol"}\n` +
      `Kuzatilayotgan sovg'alar: ${items.length} ta\n\n` +
      (isPaused ? "Yoqish uchun /resume yuboring." : "To'xtatish uchun /pause yuboring.")
  );
}

async function handleUntrack(bot: BotConfig, chatId: number, text: string): Promise<void> {
  const parts = text.split(/\s+/);
  const giftId = parts[1];
  const model = parts.slice(2).join(" ") || undefined;

  if (!giftId) {
    await sendMessage(bot.token, chatId, "Foydalanish: /untrack <gift_id> [model nomi]");
    return;
  }

  const removed = await removeTracked(bot.id, chatId, giftId, model);
  await sendMessage(bot.token, chatId, removed ? "✅ Kuzatuvdan olib tashlandi." : "Bu ID kuzatuvda topilmadi.");
}

async function handleMessage(bot: BotConfig, chatId: number, text: string, client: TelegramClient): Promise<void> {
  try {
    if (text === "/start" || text === "/help") {
      await sendMessage(bot.token, chatId, HELP_TEXT);
    } else if (text === "/listgifts") {
      await handleListGifts(bot, chatId, client);
    } else if (text.startsWith("/track")) {
      await handleTrack(bot, chatId, text, client);
    } else if (text === "/list") {
      await handleList(bot, chatId);
    } else if (text.startsWith("/untrack")) {
      await handleUntrack(bot, chatId, text);
    } else if (text === "/pause") {
      await setPaused(bot.id, chatId, true);
      await sendMessage(bot.token, chatId, "⏸ Kuzatuv to'xtatildi. Qayta yoqish uchun /resume yuboring.");
    } else if (text === "/resume") {
      await setPaused(bot.id, chatId, false);
      await sendMessage(bot.token, chatId, "▶️ Kuzatuv qayta yoqildi.");
    } else if (text === "/status") {
      await handleStatus(bot, chatId);
    } else {
      await sendMessage(bot.token, chatId, "Buyruqni tushunmadim. /help ni yuboring.");
    }
  } catch (err) {
    console.error(`[commands] xatosi (bot ${bot.id}):`, err);
    await sendMessage(bot.token, chatId, "⚠️ Ichki xatolik yuz berdi, keyinroq urinib ko'ring.").catch(() => {});
  }
}

interface TgUpdate {
  update_id: number;
  message?: { text?: string; chat?: { id: number } };
}

async function getUpdates(token: string, offset: number): Promise<TgUpdate[]> {
  const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30&allowed_updates=%5B%22message%22%5D`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`getUpdates muvaffaqiyatsiz: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as { ok: boolean; result: TgUpdate[] };
  return data.result ?? [];
}

/**
 * Bitta bot uchun cheksiz long-polling sikli. Webhook o'rniga shu ishlatiladi -
 * shunda VPS'ga alohida ochiq port/domen kerak bo'lmaydi.
 *
 * MUHIM: shu botni long-polling bilan ishlatishdan oldin uning Vercel'dagi
 * webhook'ini o'chirish kerak (deleteWebhook), aks holda Telegram getUpdates'ni
 * rad etadi ("can't use getUpdates method while webhook is active").
 */
export async function startCommandLoop(bot: BotConfig, client: TelegramClient): Promise<void> {
  console.log(`[commands] Bot "${bot.id}" uchun long-polling boshlandi.`);
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const updates = await getUpdates(bot.token, offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text || !msg?.chat?.id) continue;
        await handleMessage(bot, msg.chat.id, String(msg.text).trim(), client);
      }
    } catch (err) {
      console.error(`[commands] Bot "${bot.id}" long-polling xatosi:`, err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
