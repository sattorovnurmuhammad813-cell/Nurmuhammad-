import { TelegramClient } from "teleproto";
import { sendMessage, sendKeyboardMessage, editMessage, answerCallbackQuery, type InlineButton } from "../lib/botApi";
import { getGiftCatalog, type CatalogGift } from "../lib/gifts";
import {
  addTracked,
  removeTracked,
  listTrackedForChat,
  setPaused,
  getPausedChats,
  setPendingCustomPrice,
  getPendingCustomPrice,
  clearPendingCustomPrice,
} from "../lib/store";
import type { BotConfig } from "../lib/bots";

const HELP_TEXT =
  "Salom! Men Telegram kolleksion sovg'alar (gift) bozoridagi narx tushishini kuzataman.\n\n" +
  "Buyruqlar:\n" +
  "/giftlar — sovg'alarni tugmalar orqali tanlab, tezkor kuzatuvga qo'shish\n" +
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

// /giftlar menyusi sozlamalari
const PAGE_SIZE = 10;
const QUICK_PRICES = [300, 400, 600, 700];
/** /giftlar orqali qo'shilganda min narx doim shu bilan belgilanadi (foydalanuvchi so'roviga ko'ra) */
const DEFAULT_MIN_STARS = 125;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function buildGiftListKeyboard(limited: CatalogGift[], page: number): { text: string; rows: InlineButton[][] } {
  const totalPages = Math.max(1, Math.ceil(limited.length / PAGE_SIZE));
  const clampedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageItems = limited.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

  const rows: InlineButton[][] = pageItems.map((g) => [
    {
      text: truncate(g.title, 40) + (g.resellMinStars != null ? ` (${g.resellMinStars}⭐)` : ""),
      callback_data: `gift:${clampedPage}:${g.id}`,
    },
  ]);

  const navRow: InlineButton[] = [];
  if (clampedPage > 0) navRow.push({ text: "◀️ Oldingi", callback_data: `pg:${clampedPage - 1}` });
  navRow.push({ text: `${clampedPage + 1}/${totalPages}`, callback_data: `pg:${clampedPage}` });
  if (clampedPage < totalPages - 1) navRow.push({ text: "Keyingi ▶️", callback_data: `pg:${clampedPage + 1}` });
  rows.push(navRow);

  return { text: "🎁 Kuzatish uchun sovg'ani tanlang:", rows };
}

async function handleGiftlar(bot: BotConfig, chatId: number, client: TelegramClient): Promise<void> {
  const catalog = await getGiftCatalog(false, client);
  const limited = catalog.filter((g) => g.limited);

  if (limited.length === 0) {
    await sendMessage(bot.token, chatId, "Hozircha kolleksion sovg'alar topilmadi.");
    return;
  }

  const { text, rows } = buildGiftListKeyboard(limited, 0);
  await sendKeyboardMessage(bot.token, chatId, text, rows);
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
      `Kuzatish uchun: /track &lt;gift_id&gt; &lt;min&gt; &lt;max&gt; (yoki /giftlar orqali tugmalar bilan)`
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
    await sendMessage(bot.token, chatId, "Hozircha hech narsa kuzatilmayapti. /giftlar yoki /listgifts dan foydalaning.");
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

/**
 * /giftlar menyusidagi tugmalar bosilganda keladigan callback_query'larni boshqaradi.
 * callback_data formatlari:
 *   pg:<page>            — ro'yxat sahifasiga o'tish
 *   gift:<page>:<giftId>  — sovg'ani tanlash (narx submenyusini ko'rsatadi, orqaga qaytish uchun page saqlanadi)
 *   price:<giftId>:<max>  — tezkor narx bilan kuzatuvga qo'shish (min doim DEFAULT_MIN_STARS)
 *   custom:<giftId>       — "boshqa narx" - keyingi xabarni max narx sifatida kutadi
 */
async function handleCallbackQuery(
  bot: BotConfig,
  cq: { id: string; data?: string; message?: { message_id?: number; chat?: { id?: number } } },
  client: TelegramClient
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const data = cq.data;

  if (!chatId || !messageId || !data) {
    await answerCallbackQuery(bot.token, cq.id).catch(() => {});
    return;
  }

  try {
    if (data.startsWith("pg:")) {
      const page = Number(data.slice(3));
      const catalog = await getGiftCatalog(false, client);
      const limited = catalog.filter((g) => g.limited);
      const { text, rows } = buildGiftListKeyboard(limited, page);
      await editMessage(bot.token, chatId, messageId, text, rows);
      await answerCallbackQuery(bot.token, cq.id);
      return;
    }

    if (data.startsWith("gift:")) {
      const [, pageStr, giftId] = data.split(":");
      const catalog = await getGiftCatalog(false, client);
      const gift = catalog.find((g) => g.id === giftId);
      if (!gift) {
        await answerCallbackQuery(bot.token, cq.id, "Bu sovg'a topilmadi.");
        return;
      }

      const priceRow: InlineButton[] = QUICK_PRICES.map((p) => ({
        text: `${p} ⭐`,
        callback_data: `price:${giftId}:${p}`,
      }));
      const rows: InlineButton[][] = [
        priceRow,
        [{ text: "✏️ Boshqa narx kiritish", callback_data: `custom:${giftId}` }],
        [{ text: "◀️ Orqaga", callback_data: `pg:${pageStr}` }],
      ];
      const floor = gift.resellMinStars != null ? `${gift.resellMinStars} ⭐` : "resale yo'q";

      await editMessage(
        bot.token,
        chatId,
        messageId,
        `🎁 <b>${escapeHtml(gift.title)}</b>\nHozirgi floor narx: ${floor}\n\n` +
          `Maksimal narxni tanlang (min ${DEFAULT_MIN_STARS} ⭐ dan boshlab):`,
        rows
      );
      await answerCallbackQuery(bot.token, cq.id);
      return;
    }

    if (data.startsWith("price:")) {
      const [, giftId, maxStr] = data.split(":");
      const max = Number(maxStr);
      const catalog = await getGiftCatalog(false, client);
      const gift = catalog.find((g) => g.id === giftId);
      if (!gift) {
        await answerCallbackQuery(bot.token, cq.id, "Bu sovg'a topilmadi.");
        return;
      }

      await addTracked(bot.id, chatId, giftId, gift.title, DEFAULT_MIN_STARS, max);
      await editMessage(
        bot.token,
        chatId,
        messageId,
        `✅ Kuzatuvga qo'shildi: <b>${escapeHtml(gift.title)}</b> (${DEFAULT_MIN_STARS}-${max} ⭐)\n\n` +
          `Shu oralig'dagi barcha nusxalar haqida xabar keladi.`,
        []
      );
      await answerCallbackQuery(bot.token, cq.id, "Qo'shildi ✅");
      return;
    }

    if (data.startsWith("custom:")) {
      const giftId = data.slice("custom:".length);
      const catalog = await getGiftCatalog(false, client);
      const gift = catalog.find((g) => g.id === giftId);
      if (!gift) {
        await answerCallbackQuery(bot.token, cq.id, "Bu sovg'a topilmadi.");
        return;
      }

      await setPendingCustomPrice(bot.id, chatId, giftId, gift.title);
      await editMessage(
        bot.token,
        chatId,
        messageId,
        `✏️ <b>${escapeHtml(gift.title)}</b> uchun maksimal narxni (⭐) raqam bilan yozib yuboring (masalan: 451).\n` +
          `Min narx ${DEFAULT_MIN_STARS} ⭐ bilan belgilanadi.`,
        []
      );
      await answerCallbackQuery(bot.token, cq.id);
      return;
    }

    await answerCallbackQuery(bot.token, cq.id);
  } catch (err) {
    console.error(`[commands] callback_query xatosi (bot ${bot.id}):`, err);
    await answerCallbackQuery(bot.token, cq.id, "Xatolik yuz berdi.").catch(() => {});
  }
}

async function handleMessage(bot: BotConfig, chatId: number, text: string, client: TelegramClient): Promise<void> {
  try {
    if (!text.startsWith("/")) {
      // /giftlar'dagi "Boshqa narx kiritish" bosilgandan keyin kutilayotgan javobmi?
      const pending = await getPendingCustomPrice(bot.id, chatId);
      if (pending) {
        const max = Number(text.trim());
        if (!Number.isFinite(max) || max <= DEFAULT_MIN_STARS) {
          await sendMessage(
            bot.token,
            chatId,
            `Iltimos, ${DEFAULT_MIN_STARS} dan katta butun raqam yuboring (masalan: 451).`
          );
          return;
        }
        await clearPendingCustomPrice(bot.id, chatId);
        await addTracked(bot.id, chatId, pending.giftId, pending.title, DEFAULT_MIN_STARS, max);
        await sendMessage(
          bot.token,
          chatId,
          `✅ Kuzatuvga qo'shildi: <b>${escapeHtml(pending.title)}</b> (${DEFAULT_MIN_STARS}-${max} ⭐)\n\n` +
            `Shu oralig'dagi barcha nusxalar haqida xabar keladi.`
        );
        return;
      }
    } else {
      // Yangi buyruq kelsa, eski "kutilayotgan narx" holatini bekor qilamiz
      await clearPendingCustomPrice(bot.id, chatId);
    }

    if (text === "/start" || text === "/help") {
      await sendMessage(bot.token, chatId, HELP_TEXT);
    } else if (text === "/giftlar") {
      await handleGiftlar(bot, chatId, client);
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
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id?: number; chat?: { id?: number } };
  };
}

async function getUpdates(token: string, offset: number): Promise<TgUpdate[]> {
  const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D`;
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

        if (update.callback_query) {
          await handleCallbackQuery(bot, update.callback_query, client);
          continue;
        }

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
