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
