/** Bot API'ning shu bot ishlatadigan qismi uchun minimal tiplar va o'rovchi. */

export interface TgUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgContact {
  phone_number: string;
  first_name: string;
  user_id?: number;
}

export interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
  contact?: TgContact;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export type InlineKeyboard = InlineButton[][];

export class TelegramApi {
  constructor(private readonly token: string) {}

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok: true; result: T }
      | { ok: false; description?: string }
      | null;
    if (!body || !body.ok) {
      const desc = body && !body.ok ? body.description : `HTTP ${res.status}`;
      throw new Error(`${method} muvaffaqiyatsiz: ${desc}`);
    }
    return body.result;
  }

  sendMessage(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<TgMessage> {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  /** Telefon raqamini so'rash: request_contact faqat oddiy (reply) klaviaturada ishlaydi. */
  requestContact(chatId: number, text: string): Promise<TgMessage> {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: {
        keyboard: [[{ text: "📱 Raqamni yuborish", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  }

  /** Reply klaviaturani yopib, matn yuboradi. */
  sendAndRemoveKeyboard(chatId: number, text: string): Promise<TgMessage> {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: { remove_keyboard: true },
    });
  }

  async editMessage(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard ?? [] },
      });
    } catch (err) {
      // Matn o'zgarmagan bo'lsa Telegram xato qaytaradi - bu zararsiz.
      if (!String(err).includes("message is not modified")) throw err;
    }
  }

  async answerCallback(id: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  }

  getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>("getUpdates", {
      offset,
      timeout: timeoutSec,
      allowed_updates: ["message", "callback_query"],
    });
  }
}
