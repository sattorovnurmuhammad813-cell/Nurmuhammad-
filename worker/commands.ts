import { TelegramClient } from "teleproto";
import {
  sendMessage,
  sendKeyboardMessage,
  editMessage,
  answerCallbackQuery,
  sendStickerFile,
  sendDocumentFile,
  type InlineButton,
} from "../lib/botApi";
import {
  getGiftCatalog,
  downloadGiftSticker,
  getGiftAttributeOptions,
  type CatalogGift,
  type GiftAttributeOption,
} from "../lib/gifts";
import {
  addTracked,
  removeTracked,
  listTrackedForChat,
  setPaused,
  getPausedChats,
  setPendingCustomPrice,
  getPendingCustomPrice,
  clearPendingCustomPrice,
  type TrackedGift,
} from "../lib/store";
import type { BotConfig } from "../lib/bots";

const HELP_TEXT =
  "Salom! Men Telegram kolleksion sovg'alar (gift) bozoridagi narx tushishini kuzataman.\n\n" +
  "Buyruqlar:\n" +
  "/giftlar — sovg'ani, ixtiyoriy Model/Backdrop'ni va narx oralig'ini tugmalar orqali tanlab, tezkor kuzatuvga qo'shish\n" +
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
const ATTR_PAGE_SIZE = 10;
const QUICK_PRICES = [300, 400, 600, 700];
/** /giftlar orqali qo'shilganda min narx doim shu bilan belgilanadi (foydalanuvchi so'roviga ko'ra) */
const DEFAULT_MIN_STARS = 125;
/** callback_data'da "hech narsa tanlanmagan" holatini bildiruvchi qisqa belgi */
const NONE = "n";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function encodeIdx(idx: number | null): string {
  return idx === null ? NONE : String(idx);
}

function decodeIdx(s: string | undefined): number | null {
  return !s || s === NONE ? null : Number(s);
}

/**
 * /giftlar'dagi bosqichma-bosqich tanlov holati - callback_data ichida qisqa
 * indekslar sifatida tashiladi (Model/Backdrop nomlari o'zi emas, chunki ular
 * uzun bo'lishi va Telegram'ning 64 baytlik callback_data chegarasidan
 * chiqib ketishi mumkin - indekslar esa har doim ixcham).
 */
interface GiftState {
  giftId: string;
  modelIdx: number | null;
  backdropIdx: number | null;
  /** Asosiy /giftlar ro'yxatining qaysi sahifasidan kirilgani - "Orqaga" uchun */
  listPage: number;
}

function stateToStr(s: GiftState): string {
  return `${s.giftId}:${encodeIdx(s.modelIdx)}:${encodeIdx(s.backdropIdx)}:${s.listPage}`;
}

/** `parts` - callback_data'ni ":" bo'yicha bo'lgandan keyin prefiksdan keyingi 4 ta bo'lak */
function parseGiftState(parts: string[]): GiftState {
  const [giftId, modelIdxStr, backdropIdxStr, listPageStr] = parts;
  return {
    giftId,
    modelIdx: decodeIdx(modelIdxStr),
    backdropIdx: decodeIdx(backdropIdxStr),
    listPage: Number(listPageStr) || 0,
  };
}

/**
 * chatning barcha kuzatuvlarini gift_id bo'yicha xaritaga aylantiradi (/giftlar
 * ro'yxatida qaysi gift allaqachon kuzatuvda ekanini ko'rsatish uchun). Bitta
 * gift bir necha xil Model/Backdrop bilan kuzatilayotgan bo'lsa - eng "umumiy"
 * (Model/Backdrop'siz) yozuv ustunlik qiladi, chunki ro'yxatda bitta chegara
 * ko'rsatiladi.
 */
function attrSpecificity(t: TrackedGift): number {
  return (t.model ? 1 : 0) + (t.backdrop ? 1 : 0);
}

function buildTrackedMap(items: TrackedGift[]): Map<string, TrackedGift> {
  const map = new Map<string, TrackedGift>();
  for (const t of items) {
    const existing = map.get(t.giftId);
    if (!existing || attrSpecificity(t) < attrSpecificity(existing)) {
      map.set(t.giftId, t);
    }
  }
  return map;
}

function buildGiftListKeyboard(
  limited: CatalogGift[],
  page: number,
  trackedMap: Map<string, TrackedGift>
): { text: string; rows: InlineButton[][] } {
  const totalPages = Math.max(1, Math.ceil(limited.length / PAGE_SIZE));
  const clampedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageItems = limited.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

  const rows: InlineButton[][] = pageItems.map((g) => {
    const floor = g.resellMinStars != null ? `${g.resellMinStars}⭐` : "—";
    const tracked = trackedMap.get(g.id);
    const label = tracked
      ? `${truncate(g.title, 22)} ${floor} / ${tracked.max}⭐✅`
      : `${truncate(g.title, 32)} ${floor}`;
    return [{ text: label, callback_data: `gift:${clampedPage}:${g.id}` }];
  });

  const navRow: InlineButton[] = [];
  if (clampedPage > 0) navRow.push({ text: "◀️ Oldingi", callback_data: `pg:${clampedPage - 1}` });
  navRow.push({ text: `${clampedPage + 1}/${totalPages}`, callback_data: `pg:${clampedPage}` });
  if (clampedPage < totalPages - 1) navRow.push({ text: "Keyingi ▶️", callback_data: `pg:${clampedPage + 1}` });
  rows.push(navRow);

  return { text: "🎁 Kuzatish uchun sovg'ani tanlang:\n(narx / sizning chegarangiz ✅)", rows };
}

/** Gift-detail ekranini (Model/Backdrop holati + narx tugmalari) quradi */
async function renderGiftDetail(
  client: TelegramClient,
  state: GiftState
): Promise<{ text: string; rows: InlineButton[][] } | null> {
  const catalog = await getGiftCatalog(false, client);
  const gift = catalog.find((g) => g.id === state.giftId);
  if (!gift) return null;

  const { models, backdrops } = await getGiftAttributeOptions(state.giftId, client);
  const selectedModel = state.modelIdx != null ? models[state.modelIdx] : undefined;
  const selectedBackdrop = state.backdropIdx != null ? backdrops[state.backdropIdx] : undefined;

  const floor = gift.resellMinStars != null ? `${gift.resellMinStars} ⭐` : "resale yo'q";
  const stateStr = stateToStr(state);

  const text =
    `🎁 <b>${escapeHtml(gift.title)}</b>\nHozirgi floor narx: ${floor}\n\n` +
    `Model: ${selectedModel ? `<b>${escapeHtml(selectedModel.name)}</b>` : "tanlanmagan"}\n` +
    `Backdrop: ${selectedBackdrop ? `<b>${escapeHtml(selectedBackdrop.name)}</b>` : "tanlanmagan"}\n\n` +
    `Maksimal narxni tanlang (min ${DEFAULT_MIN_STARS} ⭐ dan boshlab):`;

  const rows: InlineButton[][] = [
    [
      { text: `🧬 Model${selectedModel ? " ✓" : ""}`, callback_data: `dm:${stateStr}:0` },
      { text: `🎨 Backdrop${selectedBackdrop ? " ✓" : ""}`, callback_data: `db:${stateStr}:0` },
    ],
    QUICK_PRICES.map((p) => ({ text: `${p} ⭐`, callback_data: `pp:${stateStr}:${p}` })),
    [{ text: "✏️ Boshqa narx kiritish", callback_data: `pc:${stateStr}` }],
    [{ text: "◀️ Orqaga", callback_data: `pg:${state.listPage}` }],
  ];

  return { text, rows };
}

/** Model yoki Backdrop tanlash ro'yxati ekranini quradi (sahifalangan) */
function buildAttrListKeyboard(
  options: GiftAttributeOption[],
  attrPage: number,
  kind: "model" | "backdrop",
  state: GiftState
): { text: string; rows: InlineButton[][] } {
  const totalPages = Math.max(1, Math.ceil(options.length / ATTR_PAGE_SIZE));
  const clampedPage = Math.min(Math.max(attrPage, 0), totalPages - 1);
  const pageItems = options.slice(clampedPage * ATTR_PAGE_SIZE, clampedPage * ATTR_PAGE_SIZE + ATTR_PAGE_SIZE);

  const stateStr = stateToStr(state);
  const pickPrefix = kind === "model" ? "pm" : "pb";
  const navPrefix = kind === "model" ? "dm" : "db";

  const rows: InlineButton[][] = pageItems.map((opt, i) => {
    const globalIdx = clampedPage * ATTR_PAGE_SIZE + i;
    return [{ text: `${opt.name} (${opt.count})`, callback_data: `${pickPrefix}:${stateStr}:${globalIdx}` }];
  });

  if (options.length === 0) {
    rows.push([{ text: "Variantlar topilmadi", callback_data: `d:${stateStr}` }]);
  } else {
    rows.push([{ text: "❌ Tanlovni bekor qilish", callback_data: `${pickPrefix}:${stateStr}:${NONE}` }]);
  }

  const navRow: InlineButton[] = [];
  if (clampedPage > 0) navRow.push({ text: "◀️", callback_data: `${navPrefix}:${stateStr}:${clampedPage - 1}` });
  if (totalPages > 1) navRow.push({ text: `${clampedPage + 1}/${totalPages}`, callback_data: `${navPrefix}:${stateStr}:${clampedPage}` });
  if (clampedPage < totalPages - 1) navRow.push({ text: "▶️", callback_data: `${navPrefix}:${stateStr}:${clampedPage + 1}` });
  if (navRow.length) rows.push(navRow);

  rows.push([{ text: "◀️ Orqaga", callback_data: `d:${stateStr}` }]);

  return { text: kind === "model" ? "🧬 Model tanlang:" : "🎨 Backdrop tanlang:", rows };
}

async function handleGiftlar(bot: BotConfig, chatId: number, client: TelegramClient): Promise<void> {
  const catalog = await getGiftCatalog(false, client);
  const limited = catalog.filter((g) => g.limited);

  if (limited.length === 0) {
    await sendMessage(bot.token, chatId, "Hozircha kolleksion sovg'alar topilmadi.");
    return;
  }

  const trackedMap = buildTrackedMap(await listTrackedForChat(bot.id, chatId));
  const { text, rows } = buildGiftListKeyboard(limited, 0, trackedMap);
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

  const lines = items.map((t) => {
    const attrs = [t.model && `Model: <b>${escapeHtml(t.model)}</b>`, t.backdrop && `Backdrop: <b>${escapeHtml(t.backdrop)}</b>`]
      .filter(Boolean)
      .join(", ");
    return `<code>${t.giftId}</code> — ${escapeHtml(t.title)}${attrs ? ` — ${attrs}` : ""} (${t.min}-${t.max} ⭐)`;
  });
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
 * callback_data formatlari (state = "<giftId>:<modelIdx>:<backdropIdx>:<listPage>",
 * idx'lar "n" bo'lsa tanlanmagan degani):
 *   pg:<page>                    — asosiy ro'yxat sahifasi
 *   gift:<page>:<giftId>         — sovg'ani ro'yxatdan tanlash (rasm + detail ekranini yuboradi)
 *   d:<state>                    — detail ekranini qayta chizadi (Model/Backdrop ro'yxatidan "Orqaga")
 *   dm:<state>:<attrPage>        — Model tanlash ro'yxati
 *   db:<state>:<attrPage>        — Backdrop tanlash ro'yxati
 *   pm:<state>:<newModelIdx|n>   — Model tanlandi, detail ekraniga qaytadi
 *   pb:<state>:<newBackdropIdx|n>— Backdrop tanlandi, detail ekraniga qaytadi
 *   pp:<state>:<price>           — tezkor narx bilan kuzatuvga qo'shish
 *   pc:<state>                   — "boshqa narx" - keyingi xabarni max narx sifatida kutadi
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
      const trackedMap = buildTrackedMap(await listTrackedForChat(bot.id, chatId));
      const { text, rows } = buildGiftListKeyboard(limited, page, trackedMap);
      await editMessage(bot.token, chatId, messageId, text, rows);
      await answerCallbackQuery(bot.token, cq.id);
      return;
    }

    if (data.startsWith("gift:")) {
      const [, pageStr, giftId] = data.split(":");
      const state: GiftState = { giftId, modelIdx: null, backdropIdx: null, listPage: Number(pageStr) || 0 };
      const rendered = await renderGiftDetail(client, state);
      if (!rendered) {
        await answerCallbackQuery(bot.token, cq.id, "Bu sovg'a topilmadi.");
        return;
      }

      await answerCallbackQuery(bot.token, cq.id);

      // Gift rasmini (stikerini) MTProto orqali yuklab, Bot API'ga qayta yuklab
      // alohida xabar sifatida yuboramiz - eng yaxshi urinish, topilmasa/muvaffaqiyatsiz
      // bo'lsa ham asosiy oqim (detail ekrani) davom etadi.
      try {
        const sticker = await downloadGiftSticker(giftId, client);
        if (sticker) {
          const filename = `gift.${sticker.ext}`;
          const sentAsSticker = await sendStickerFile(bot.token, chatId, sticker.buffer, filename);
          if (!sentAsSticker) {
            await sendDocumentFile(bot.token, chatId, sticker.buffer, filename);
          }
        }
      } catch (err) {
        console.error(`[commands] gift stiker xatosi (${giftId}):`, err);
      }

      // Rasm tartibda YUQORIDA ko'rinishi uchun (edit emas) yangi xabar yuboramiz -
      // shu xabar keyingi Model/Backdrop/narx/orqaga tugmalari uchun "joriy xabar" bo'lib qoladi.
      await sendKeyboardMessage(bot.token, chatId, rendered.text, rendered.rows);
      return;
    }

    if (data.startsWith("d:")) {
      const parts = data.split(":");
      const state = parseGiftState(parts.slice(1, 5));
      const rendered = await renderGiftDetail(client, state);
      if (!rendered) {
        await answerCallbackQuery(bot.token, cq.id, "Bu sovg'a topilmadi.");
        return;
      }
      await editMessage(bot.token, chatId, messageId, rendered.text, rendered.rows);
      await answerCallbackQuery(bot.token, cq.id);
      return;
    }

    if (data.startsWith("dm:") || data.startsWith("db:")) {
      const kind: "model" | "backdrop" = data.startsWith("dm:") ? "model" : "backdrop";
      const parts = data.split(":");
      const state = parseGiftState(parts.slice(1, 5));
      const attrPage = Number(parts[5]) || 0;

      const { models, backdrops } = await getGiftAttributeOptions(state.giftId, client);
      const options = kind === "model" ? models : backdrops;
      const { text, rows } = buildAttrListKeyboard(options, attrPage, kind, state);
      await editMessage(bot.token, chatId, messageId, text, rows);
      await answerCallbackQuery(bot.token, cq.id);
      return;
    }

    if (data.startsWith("pm:") || data.startsWith("pb:")) {
      const isModel = data.startsWith("pm:");
      const parts = data.split(":");
      const giftId = parts[1];
      const listPage = Number(parts[4]) || 0;
      const newIdx = decodeIdx(parts[5]);

      const state: GiftState = isModel
        ? { giftId, modelIdx: newIdx, backdropIdx: decodeIdx(parts[3]), listPage }
        : { giftId, modelIdx: decodeIdx(parts[2]), backdropIdx: newIdx, listPage };

      const rendered = await renderGiftDetail(client, state);
      if (!rendered) {
        await answerCallbackQuery(bot.token, cq.id, "Bu sovg'a topilmadi.");
        return;
      }
      await editMessage(bot.token, chatId, messageId, rendered.text, rendered.rows);
      await answerCallbackQuery(bot.token, cq.id);
      return;
    }

    if (data.startsWith("pp:")) {
      const parts = data.split(":");
      const state = parseGiftState(parts.slice(1, 5));
      const price = Number(parts[5]);

      const catalog = await getGiftCatalog(false, client);
      const gift = catalog.find((g) => g.id === state.giftId);
      if (!gift) {
        await answerCallbackQuery(bot.token, cq.id, "Bu sovg'a topilmadi.");
        return;
      }

      const { models, backdrops } = await getGiftAttributeOptions(state.giftId, client);
      const modelName = state.modelIdx != null ? models[state.modelIdx]?.name : undefined;
      const backdropName = state.backdropIdx != null ? backdrops[state.backdropIdx]?.name : undefined;

      await addTracked(bot.id, chatId, state.giftId, gift.title, DEFAULT_MIN_STARS, price, modelName, backdropName);

      const attrLine = [modelName && `Model: ${escapeHtml(modelName)}`, backdropName && `Backdrop: ${escapeHtml(backdropName)}`]
        .filter(Boolean)
        .join(", ");
      await editMessage(
        bot.token,
        chatId,
        messageId,
        `✅ Kuzatuvga qo'shildi: <b>${escapeHtml(gift.title)}</b>${attrLine ? ` (${attrLine})` : ""} (${DEFAULT_MIN_STARS}-${price} ⭐)\n\n` +
          `Shu oralig'dagi barcha nusxalar haqida xabar keladi.`,
        []
      );
      await answerCallbackQuery(bot.token, cq.id, "Qo'shildi ✅");
      return;
    }

    if (data.startsWith("pc:")) {
      const parts = data.split(":");
      const state = parseGiftState(parts.slice(1, 5));

      const catalog = await getGiftCatalog(false, client);
      const gift = catalog.find((g) => g.id === state.giftId);
      if (!gift) {
        await answerCallbackQuery(bot.token, cq.id, "Bu sovg'a topilmadi.");
        return;
      }

      const { models, backdrops } = await getGiftAttributeOptions(state.giftId, client);
      const modelName = state.modelIdx != null ? models[state.modelIdx]?.name : undefined;
      const backdropName = state.backdropIdx != null ? backdrops[state.backdropIdx]?.name : undefined;

      await setPendingCustomPrice(bot.id, chatId, state.giftId, gift.title, modelName, backdropName);
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
        await addTracked(bot.id, chatId, pending.giftId, pending.title, DEFAULT_MIN_STARS, max, pending.model, pending.backdrop);

        const attrLine = [
          pending.model && `Model: ${escapeHtml(pending.model)}`,
          pending.backdrop && `Backdrop: ${escapeHtml(pending.backdrop)}`,
        ]
          .filter(Boolean)
          .join(", ");
        await sendMessage(
          bot.token,
          chatId,
          `✅ Kuzatuvga qo'shildi: <b>${escapeHtml(pending.title)}</b>${attrLine ? ` (${attrLine})` : ""} (${DEFAULT_MIN_STARS}-${max} ⭐)\n\n` +
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
