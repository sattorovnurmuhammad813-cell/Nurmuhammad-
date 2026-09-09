const BOT_TOKEN = process.env.BOT_TOKEN;

function apiBase(): string {
  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN environment variable sozlanmagan");
  }
  return `https://api.telegram.org/bot${BOT_TOKEN}`;
}

export async function sendMessage(chatId: number | string, text: string): Promise<void> {
  const res = await fetch(`${apiBase()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`sendMessage muvaffaqiyatsiz (chat ${chatId}): ${res.status} ${body}`);
  }
}
