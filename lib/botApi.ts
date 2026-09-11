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

export interface BotCommand {
  command: string;
  description: string;
}

/** Botning "Menu" tugmasidagi buyruqlar ro'yxatini sozlaydi (BotFather'dagi bilan bir xil natija) */
export async function setMyCommands(token: string, commands: BotCommand[]): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`setMyCommands muvaffaqiyatsiz: ${res.status} ${body}`);
  }
}

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
 * Xotiradagi fayl baytlarini (masalan MTProto orqali yuklab olingan gift stikeri)
 * to'g'ridan-to'g'ri Bot API'ga multipart sifatida yuklab, stiker sifatida yuboradi.
 * Bot API stiker formatini qabul qilmasa (masalan noma'lum format), `false` qaytaradi -
 * shunda chaqiruvchi tomon sendDocumentFile'ga tushishi mumkin.
 */
export async function sendStickerFile(
  token: string,
  chatId: number | string,
  buffer: Buffer,
  filename: string
): Promise<boolean> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("sticker", new Blob([buffer]), filename);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendSticker`, { method: "POST", body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`sendStickerFile muvaffaqiyatsiz (chat ${chatId}): ${res.status} ${body}`);
    return false;
  }
  return true;
}

/** sendStickerFile format sababli rad etsa, umumiy fayl sifatida yuboradigan zaxira yo'l */
export async function sendDocumentFile(
  token: string,
  chatId: number | string,
  buffer: Buffer,
  filename: string
): Promise<boolean> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([buffer]), filename);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`sendDocumentFile muvaffaqiyatsiz (chat ${chatId}): ${res.status} ${body}`);
    return false;
  }
  return true;
}
