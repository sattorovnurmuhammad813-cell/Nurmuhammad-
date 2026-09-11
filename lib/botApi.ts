export interface UrlButton {
  text: string;
  url: string;
}

export interface SendMessageOptions {
  buttons?: UrlButton[];
  /** true bo'lsa, matndagi t.me/nft/... havolasi uchun Telegram'ning katta rasm-karta
   *  ko'rinishi (native preview) yoqiladi. Standart holatda o'chirilgan. */
  showLinkPreview?: boolean;
}

/** Interaktiv menyular (masalan /giftlar) uchun - url yoki callback_data'dan biri bo'lishi kerak */
export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export type InlineKeyboard = InlineButton[][];

export async function sendMessage(
  token: string,
  chatId: number | string,
  text: string,
  options: SendMessageOptions = {}
): Promise<void> {
  const { buttons, showLinkPreview } = options;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: !showLinkPreview,
      ...(buttons?.length
        ? { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, url: b.url }))] } }
        : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`sendMessage muvaffaqiyatsiz (chat ${chatId}): ${res.status} ${body}`);
  }
}

/** Inline (callback_data) tugmalar bilan xabar yuboradi, keyin tahrirlash uchun message_id qaytaradi */
export async function sendKeyboardMessage(
  token: string,
  chatId: number | string,
  text: string,
  keyboard: InlineKeyboard = []
): Promise<number | null> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`sendKeyboardMessage muvaffaqiyatsiz (chat ${chatId}): ${res.status} ${body}`);
    return null;
  }
  const data = (await res.json()) as { ok: boolean; result?: { message_id: number } };
  return data.result?.message_id ?? null;
}

/** Mavjud xabarning matni va tugmalarini yangilaydi (masalan sahifalash yoki menyu bosqichlari uchun) */
export async function editMessage(
  token: string,
  chatId: number | string,
  messageId: number,
  text: string,
  keyboard: InlineKeyboard = []
): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // "message is not modified" kabi zararsiz xatolarni ham shu yerda log qilamiz, lekin urinishni to'xtatmaymiz
    console.error(`editMessage muvaffaqiyatsiz (chat ${chatId}, msg ${messageId}): ${res.status} ${body}`);
    return false;
  }
  return true;
}

/** Tugma bosilganini Telegram'ga tasdiqlaydi (tugmadagi "yuklanmoqda" aylanuvchini to'xtatadi) */
export async function answerCallbackQuery(token: string, callbackQueryId: string, text?: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`answerCallbackQuery muvaffaqiyatsiz: ${res.status} ${body}`);
  }
}

/**
 * gift_id -> sticker file_id xaritasini Bot API'ning getAvailableGifts orqali oladi
 * (bu /giftlar menyusida gift tanlanganda uning rasmini ko'rsatish uchun ishlatiladi).
 *
 * DIQQAT: gift ID'lar 19-20 xonali son bo'lgani uchun oddiy JSON.parse ularni
 * JS Number sifatida noto'g'ri (aniqlikni yo'qotib) o'qiydi - shu sabab avval
 * "id" maydonlarini qatorga (string) aylantirib olamiz.
 */
let giftStickerCache: { data: Map<string, string>; ts: number } | null = null;
const GIFT_STICKER_CACHE_MS = 5 * 60_000;

export async function getGiftStickerMap(token: string): Promise<Map<string, string>> {
  if (giftStickerCache && Date.now() - giftStickerCache.ts < GIFT_STICKER_CACHE_MS) {
    return giftStickerCache.data;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getAvailableGifts`);
    if (!res.ok) {
      console.error(`getAvailableGifts muvaffaqiyatsiz: ${res.status}`);
      return giftStickerCache?.data ?? new Map();
    }
    const rawText = await res.text();
    const safeJson = rawText.replace(/"id":(\d{16,})/g, '"id":"$1"');
    const data = JSON.parse(safeJson) as {
      ok: boolean;
      result?: { gifts?: Array<{ id: string; sticker?: { file_id?: string } }> };
    };

    const map = new Map<string, string>();
    for (const g of data.result?.gifts ?? []) {
      if (g.sticker?.file_id) map.set(String(g.id), g.sticker.file_id);
    }
    giftStickerCache = { data: map, ts: Date.now() };
    return map;
  } catch (err) {
    console.error("getGiftStickerMap xatosi:", err);
    return giftStickerCache?.data ?? new Map();
  }
}

/** Gift stikerini (rasm/animatsiya) alohida xabar sifatida yuboradi */
export async function sendSticker(token: string, chatId: number | string, stickerFileId: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendSticker`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, sticker: stickerFileId }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`sendSticker muvaffaqiyatsiz (chat ${chatId}): ${res.status} ${body}`);
  }
}
