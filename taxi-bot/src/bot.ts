import { TelegramApi, type InlineKeyboard, type TgCallbackQuery, type TgMessage, type TgUpdate } from "./telegram";
import { Store, type Trip, type User } from "./store";

export const CITIES = [
  "Toshkent",
  "Samarqand",
  "Buxoro",
  "Andijon",
  "Farg'ona",
  "Namangan",
  "Qo'qon",
  "Qarshi",
  "Termiz",
  "Navoiy",
  "Jizzax",
  "Guliston",
  "Urganch",
  "Nukus",
];

/** Haydovchi qatnovni necha kun oldin e'lon qila oladi */
const DRIVER_DAYS_AHEAD = 7;
/** Yo'lovchi necha kun oldinga qidira oladi */
const PASSENGER_DAYS_AHEAD = 3;
const MAX_SEATS = 8;
const MAX_SEATS_PER_BOOKING = 4;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Toshkent (UTC+5) bo'yicha bugundan `offsetDays` kun keyingi sana, YYYY-MM-DD. */
export function tashkentDate(offsetDays: number, now = Date.now()): string {
  return new Date(now + 5 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}

function dateLabel(offset: number): string {
  const [, m, d] = tashkentDate(offset).split("-");
  const prefix = offset === 0 ? "Bugun" : offset === 1 ? "Ertaga" : offset === 2 ? "Indinga" : "";
  return `${prefix} ${d}.${m}`.trim();
}

function formatDate(date: string): string {
  const [, m, d] = date.split("-");
  return `${d}.${m}`;
}

function formatSum(n: number): string {
  return `${n.toLocaleString("ru-RU").replace(/ /g, " ")} so'm`;
}

function ratingText(u: User): string {
  if (u.ratingCount === 0) return "🆕 yangi haydovchi";
  return `⭐ ${(u.ratingSum / u.ratingCount).toFixed(1)} (${u.ratingCount} ta baho)`;
}

function cityKeyboard(prefix: string, exclude?: string): InlineKeyboard {
  const buttons = CITIES.map((c, i) => ({ text: c, callback_data: `${prefix}:${i}` })).filter(
    (b) => b.text !== exclude,
  );
  const rows: InlineKeyboard = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: "⬅️ Menyu", callback_data: "menu" }]);
  return rows;
}

function dateKeyboard(prefix: string, days: number): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (let i = 0; i < days; i++) rows.push([{ text: dateLabel(i), callback_data: `${prefix}:${i}` }]);
  rows.push([{ text: "⬅️ Menyu", callback_data: "menu" }]);
  return rows;
}

export class TaxiBot {
  constructor(
    private readonly api: TelegramApi,
    private readonly store: Store,
    /** Bo'sh bo'lsa, haydovchilar avtomatik tasdiqlanadi (faqat sinov uchun). */
    private readonly adminChatId?: number,
  ) {}

  async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.callback_query) return this.onCallback(update.callback_query);
    if (update.message) return this.onMessage(update.message);
  }

  // ================= Xabarlar =================

  private async onMessage(msg: TgMessage): Promise<void> {
    if (msg.chat.type !== "private" || !msg.from) return;
    const chatId = msg.chat.id;

    if (msg.contact) return this.onContact(msg);

    const text = (msg.text ?? "").trim();
    if (text === "/start" || text === "/menu") {
      this.store.clearSession(chatId);
      return this.start(chatId, msg.from.first_name);
    }
    if (text === "/yordam" || text === "/help") return this.help(chatId);

    const session = this.store.getSession(chatId);
    if (session) return this.onSessionText(chatId, text);

    await this.api.sendMessage(chatId, "Buyruqni tushunmadim. Menyu uchun /start ni bosing.");
  }

  private async start(chatId: number, firstName: string): Promise<void> {
    const user = this.store.getUser(chatId);
    if (!user?.phone) {
      this.store.setSession(chatId, { step: "phone", data: {} });
      await this.api.requestContact(
        chatId,
        `Assalomu alaykum, ${escapeHtml(firstName)}! 🚕\n\n` +
          "Bu bot orqali shaharlararo qatnov topish yoki e'lon qilish mumkin.\n\n" +
          "Davom etish uchun telefon raqamingizni yuboring - u faqat siz bron qilgan " +
          "haydovchiga (yoki sizga yo'lovchiga) ko'rsatiladi.",
      );
      return;
    }
    if (!user.role) return this.askRole(chatId);
    return this.showMenu(chatId);
  }

  private async help(chatId: number): Promise<void> {
    await this.api.sendMessage(
      chatId,
      "<b>Qanday ishlaydi</b>\n\n" +
        "🧍 <b>Yo'lovchi</b>: qayerdan, qayerga va qaysi kun ketishingizni tanlaysiz, " +
        "mos qatnovlardan birida joy band qilasiz va haydovchining raqamini olasiz.\n\n" +
        "🚗 <b>Haydovchi</b>: mashinangiz ma'lumotlarini kiritasiz, admin tasdiqlagach " +
        "qatnov e'lon qilasiz. Har bir yangi bron haqida darhol xabar keladi.\n\n" +
        "Safardan keyin yo'lovchilar haydovchiga 1-5 yulduz baho beradi.\n\n" +
        "/start - menyu",
    );
  }

  private async onContact(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const contact = msg.contact!;
    // Boshqa odamning kontaktini yuborib bo'lmasin
    if (contact.user_id !== msg.from!.id) {
      await this.api.requestContact(chatId, "Iltimos, pastdagi tugma orqali <b>o'zingizning</b> raqamingizni yuboring.");
      return;
    }
    const name = [msg.from!.first_name, msg.from!.last_name].filter(Boolean).join(" ");
    const phone = contact.phone_number.startsWith("+") ? contact.phone_number : `+${contact.phone_number}`;
    const user = this.store.upsertUser(chatId, { name, phone });
    this.store.clearSession(chatId);
    await this.api.sendAndRemoveKeyboard(chatId, "✅ Raqam saqlandi.");
    if (!user.role) return this.askRole(chatId);
    return this.showMenu(chatId);
  }

  private async askRole(chatId: number, editMessageId?: number): Promise<void> {
    const text = "Siz kimsiz?";
    const kb: InlineKeyboard = [
      [{ text: "🧍 Yo'lovchi", callback_data: "role:p" }],
      [{ text: "🚗 Haydovchi", callback_data: "role:d" }],
    ];
    if (editMessageId) return this.api.editMessage(chatId, editMessageId, text, kb);
    await this.api.sendMessage(chatId, text, kb);
  }

  private menuContent(user: User): { text: string; kb: InlineKeyboard } {
    if (user.role === "driver") {
      if (user.driverStatus !== "approved") {
        const status =
          user.driverStatus === "rejected"
            ? "❌ Haydovchi sifatida arizangiz rad etildi."
            : "⏳ Arizangiz admin tomonidan ko'rib chiqilmoqda. Tasdiqlangach xabar keladi.";
        return { text: status, kb: [[{ text: "🔄 Rolni almashtirish", callback_data: "role" }]] };
      }
      return {
        text: `🚗 <b>Haydovchi menyusi</b>\n${escapeHtml(user.car ?? "")}, ${escapeHtml(user.plate ?? "")}\n${ratingText(user)}`,
        kb: [
          [{ text: "➕ Qatnov e'lon qilish", callback_data: "t:new" }],
          [{ text: "📋 Qatnovlarim", callback_data: "mytr" }],
          [{ text: "🔄 Rolni almashtirish", callback_data: "role" }],
        ],
      };
    }
    return {
      text: "🧍 <b>Yo'lovchi menyusi</b>",
      kb: [
        [{ text: "🔍 Qatnov qidirish", callback_data: "s:new" }],
        [{ text: "🎫 Bronlarim", callback_data: "mybk" }],
        [{ text: "🔄 Rolni almashtirish", callback_data: "role" }],
      ],
    };
  }

  private async showMenu(chatId: number, editMessageId?: number): Promise<void> {
    const user = this.store.getUser(chatId);
    if (!user) return this.start(chatId, "");
    const { text, kb } = this.menuContent(user);
    if (editMessageId) return this.api.editMessage(chatId, editMessageId, text, kb);
    await this.api.sendMessage(chatId, text, kb);
  }

  // ================= Matn bilan kiritiladigan bosqichlar =================

  private async onSessionText(chatId: number, text: string): Promise<void> {
    const session = this.store.getSession(chatId)!;
    const data = session.data;

    switch (session.step) {
      case "phone":
        await this.api.requestContact(chatId, "Pastdagi <b>📱 Raqamni yuborish</b> tugmasini bosing.");
        return;

      case "d_car":
        if (text.length < 2 || text.length > 40) {
          await this.api.sendMessage(chatId, "Mashina markasi va rangini yozing, masalan: <i>Cobalt, oq</i>");
          return;
        }
        this.store.setSession(chatId, { step: "d_plate", data: { car: text } });
        await this.api.sendMessage(chatId, "Davlat raqami (masalan: <i>01 A 123 BC</i>):");
        return;

      case "d_plate": {
        if (text.length < 5 || text.length > 15) {
          await this.api.sendMessage(chatId, "Davlat raqamini to'g'ri kiriting, masalan: <i>01 A 123 BC</i>");
          return;
        }
        this.store.clearSession(chatId);
        const autoApprove = this.adminChatId === undefined;
        const user = this.store.updateUser(chatId, {
          car: String(data.car),
          plate: text.toUpperCase(),
          driverStatus: autoApprove ? "approved" : "pending",
        })!;
        if (!autoApprove) await this.notifyAdminAboutDriver(user);
        return this.showMenu(chatId);
      }

      case "t_time": {
        const m = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(text);
        if (!m) {
          await this.api.sendMessage(chatId, "Vaqtni SS:DD ko'rinishida yozing, masalan: <i>07:30</i>");
          return;
        }
        const time = `${m[1].padStart(2, "0")}:${m[2]}`;
        this.store.setSession(chatId, { step: "t_seats", data: { ...data, time } });
        await this.api.sendMessage(chatId, `Nechta bo'sh joy bor? (1-${MAX_SEATS})`);
        return;
      }

      case "t_seats": {
        const seats = Number(text);
        if (!Number.isInteger(seats) || seats < 1 || seats > MAX_SEATS) {
          await this.api.sendMessage(chatId, `1 dan ${MAX_SEATS} gacha son kiriting.`);
          return;
        }
        this.store.setSession(chatId, { step: "t_price", data: { ...data, seats } });
        await this.api.sendMessage(chatId, "Bir joy narxi qancha (so'mda)? Masalan: <i>150000</i>");
        return;
      }

      case "t_price": {
        const price = Number(text.replace(/[\s,.']/g, ""));
        if (!Number.isInteger(price) || price < 1000 || price > 10_000_000) {
          await this.api.sendMessage(chatId, "Narxni faqat raqamda yozing, masalan: <i>150000</i>");
          return;
        }
        const next: Record<string, string | number> = { ...data, price };
        this.store.setSession(chatId, { step: "t_confirm", data: next });
        await this.api.sendMessage(
          chatId,
          "<b>Qatnovni tekshiring:</b>\n\n" +
            `📍 ${escapeHtml(String(next.from))} → ${escapeHtml(String(next.to))}\n` +
            `📅 ${formatDate(String(next.date))}, 🕒 ${next.time}\n` +
            `💺 ${next.seats} joy, 💰 ${formatSum(price)} / joy`,
          [
            [{ text: "✅ E'lon qilish", callback_data: "t:ok" }],
            [{ text: "❌ Bekor qilish", callback_data: "menu" }],
          ],
        );
        return;
      }

      default:
        await this.api.sendMessage(chatId, "Pastdagi tugmalardan birini tanlang yoki /start ni bosing.");
    }
  }

  // ================= Tugmalar =================

  private async onCallback(q: TgCallbackQuery): Promise<void> {
    const chatId = q.from.id;
    const msgId = q.message?.message_id;
    const data = q.data ?? "";
    const parts = data.split(":");
    const user = this.store.getUser(chatId);

    // Admin tugmalari foydalanuvchi ro'yxatdan o'tmagan bo'lsa ham ishlashi kerak
    if (parts[0] === "adm") {
      await this.api.answerCallback(q.id);
      return this.onAdminDecision(chatId, msgId, parts[1], Number(parts[2]));
    }

    if (!user?.phone) {
      await this.api.answerCallback(q.id);
      return this.start(chatId, q.from.first_name);
    }

    await this.api.answerCallback(q.id);

    switch (parts[0]) {
      case "menu":
        this.store.clearSession(chatId);
        return this.showMenu(chatId, msgId);

      case "role":
        if (parts[1] === "p") {
          this.store.updateUser(chatId, { role: "passenger" });
          return this.showMenu(chatId, msgId);
        }
        if (parts[1] === "d") {
          this.store.updateUser(chatId, { role: "driver" });
          if (user.driverStatus) return this.showMenu(chatId, msgId);
          this.store.setSession(chatId, { step: "d_car", data: {} });
          await this.api.editMessage(
            chatId,
            msgId!,
            "🚗 Haydovchi sifatida ro'yxatdan o'tish.\n\nMashina markasi va rangi (masalan: <i>Cobalt, oq</i>):",
          );
          return;
        }
        return this.askRole(chatId, msgId);

      case "s":
        return this.onSearchStep(chatId, msgId!, parts);
      case "book":
        return this.onBookStart(chatId, msgId!, Number(parts[1]));
      case "bs":
        return this.onBookSeats(chatId, msgId!, Number(parts[1]), Number(parts[2]));
      case "mybk":
        return this.showMyBookings(chatId, msgId!);
      case "cbk":
        return this.onCancelBooking(chatId, msgId!, Number(parts[1]));

      case "t":
        return this.onTripStep(chatId, msgId!, user, parts);
      case "mytr":
        return this.showMyTrips(chatId, msgId!);
      case "trp":
        return this.showTripDetails(chatId, msgId!, Number(parts[1]));
      case "ctr":
      case "dtr":
        return this.onCloseTrip(chatId, msgId!, Number(parts[1]), parts[0] === "dtr" ? "done" : "cancelled");

      case "rate":
        return this.onRate(chatId, msgId!, Number(parts[1]), Number(parts[2]));
    }
  }

  // ---------- Yo'lovchi: qidirish va bron ----------

  private async onSearchStep(chatId: number, msgId: number, parts: string[]): Promise<void> {
    // s:new  ->  s:f:<from>  ->  s:t:<from>:<to>  ->  s:d:<from>:<to>:<offset>
    const [, step, a, b, c] = parts;
    if (step === "new") {
      return this.api.editMessage(chatId, msgId, "📍 Qayerdan ketasiz?", cityKeyboard("s:f"));
    }
    if (step === "f") {
      return this.api.editMessage(
        chatId,
        msgId,
        `📍 ${CITIES[Number(a)]} → qayerga?`,
        cityKeyboard(`s:t:${a}`, CITIES[Number(a)]),
      );
    }
    if (step === "t") {
      return this.api.editMessage(
        chatId,
        msgId,
        `📍 ${CITIES[Number(a)]} → ${CITIES[Number(b)]}\n📅 Qaysi kun?`,
        dateKeyboard(`s:d:${a}:${b}`, PASSENGER_DAYS_AHEAD),
      );
    }
    if (step === "d") {
      const from = CITIES[Number(a)];
      const to = CITIES[Number(b)];
      const date = tashkentDate(Number(c));
      const trips = this.store.searchTrips(from, to, date, chatId).slice(0, 10);
      if (trips.length === 0) {
        return this.api.editMessage(
          chatId,
          msgId,
          `📍 ${from} → ${to}, 📅 ${formatDate(date)}\n\nHozircha qatnov topilmadi. Boshqa kunni tekshirib ko'ring.`,
          [
            [{ text: "📅 Boshqa kun", callback_data: `s:t:${a}:${b}` }],
            [{ text: "⬅️ Menyu", callback_data: "menu" }],
          ],
        );
      }
      const lines = trips.map((t) => {
        const driver = this.store.getUser(t.driverId);
        return (
          `<b>#${t.id}</b> 🕒 ${t.time} · 💰 ${formatSum(t.price)} · 💺 ${t.seatsFree} joy\n` +
          `   🚗 ${escapeHtml(driver?.car ?? "")} · ${driver ? ratingText(driver) : ""}`
        );
      });
      const kb: InlineKeyboard = trips.map((t) => [
        { text: `🎫 #${t.id} - ${t.time}, ${formatSum(t.price)}`, callback_data: `book:${t.id}` },
      ]);
      kb.push([{ text: "📅 Boshqa kun", callback_data: `s:t:${a}:${b}` }]);
      kb.push([{ text: "⬅️ Menyu", callback_data: "menu" }]);
      return this.api.editMessage(
        chatId,
        msgId,
        `📍 ${from} → ${to}, 📅 ${formatDate(date)}\n\n${lines.join("\n\n")}`,
        kb,
      );
    }
  }

  private async onBookStart(chatId: number, msgId: number, tripId: number): Promise<void> {
    const trip = this.store.getTrip(tripId);
    if (!trip || trip.status !== "active" || trip.seatsFree === 0) {
      return this.api.editMessage(chatId, msgId, "Afsus, bu qatnovda joy qolmadi.", [
        [{ text: "⬅️ Menyu", callback_data: "menu" }],
      ]);
    }
    if (this.store.findActiveBooking(tripId, chatId)) {
      return this.api.editMessage(chatId, msgId, "Siz bu qatnovda allaqachon joy band qilgansiz.", [
        [{ text: "🎫 Bronlarim", callback_data: "mybk" }],
      ]);
    }
    const max = Math.min(trip.seatsFree, MAX_SEATS_PER_BOOKING);
    const row = Array.from({ length: max }, (_, i) => ({ text: String(i + 1), callback_data: `bs:${tripId}:${i + 1}` }));
    return this.api.editMessage(chatId, msgId, "Nechta joy band qilasiz?", [row, [{ text: "⬅️ Menyu", callback_data: "menu" }]]);
  }

  private async onBookSeats(chatId: number, msgId: number, tripId: number, seats: number): Promise<void> {
    if (!Number.isInteger(seats) || seats < 1 || seats > MAX_SEATS_PER_BOOKING) return;
    const booking = this.store.book(tripId, chatId, seats);
    if (!booking) {
      return this.api.editMessage(chatId, msgId, "Afsus, joy band qilib bo'lmadi: joylar tugagan yoki siz bu qatnovda allaqachon joy band qilgansiz.", [
        [{ text: "⬅️ Menyu", callback_data: "menu" }],
      ]);
    }
    const trip = this.store.getTrip(tripId)!;
    const driver = this.store.getUser(trip.driverId)!;
    const passenger = this.store.getUser(chatId)!;

    await this.api.editMessage(
      chatId,
      msgId,
      `✅ <b>Joy band qilindi!</b>\n\n${this.tripSummary(trip)}\n💺 ${seats} joy · jami ${formatSum(trip.price * seats)}\n\n` +
        `👤 Haydovchi: ${escapeHtml(driver.name)}\n📞 ${escapeHtml(driver.phone ?? "")}\n` +
        `🚗 ${escapeHtml(driver.car ?? "")}, ${escapeHtml(driver.plate ?? "")}\n\n` +
        "Uchrashuv joyini haydovchi bilan telefon orqali kelishib oling.",
      [[{ text: "🎫 Bronlarim", callback_data: "mybk" }], [{ text: "⬅️ Menyu", callback_data: "menu" }]],
    );
    await this.safeSend(
      driver.id,
      `🆕 <b>Yangi bron</b> (qatnov #${trip.id})\n\n${this.tripSummary(trip)}\n\n` +
        `👤 ${escapeHtml(passenger.name)}\n📞 ${escapeHtml(passenger.phone ?? "")}\n💺 ${seats} joy\n\n` +
        `Qolgan bo'sh joy: ${trip.seatsFree}`,
    );
  }

  private async showMyBookings(chatId: number, msgId: number): Promise<void> {
    const bookings = this.store.passengerBookings(chatId);
    if (bookings.length === 0) {
      return this.api.editMessage(chatId, msgId, "Sizda faol bron yo'q.", [
        [{ text: "🔍 Qatnov qidirish", callback_data: "s:new" }],
        [{ text: "⬅️ Menyu", callback_data: "menu" }],
      ]);
    }
    const lines: string[] = [];
    const kb: InlineKeyboard = [];
    for (const b of bookings) {
      const trip = this.store.getTrip(b.tripId)!;
      const driver = this.store.getUser(trip.driverId);
      lines.push(
        `<b>Bron #${b.id}</b>\n${this.tripSummary(trip)}\n💺 ${b.seats} joy\n` +
          `👤 ${escapeHtml(driver?.name ?? "")} · 📞 ${escapeHtml(driver?.phone ?? "")}`,
      );
      kb.push([{ text: `❌ Bron #${b.id} ni bekor qilish`, callback_data: `cbk:${b.id}` }]);
    }
    kb.push([{ text: "⬅️ Menyu", callback_data: "menu" }]);
    return this.api.editMessage(chatId, msgId, lines.join("\n\n"), kb);
  }

  private async onCancelBooking(chatId: number, msgId: number, bookingId: number): Promise<void> {
    const existing = this.store.getBooking(bookingId);
    if (!existing || existing.passengerId !== chatId) return;
    const booking = this.store.cancelBooking(bookingId);
    if (booking) {
      const trip = this.store.getTrip(booking.tripId)!;
      const passenger = this.store.getUser(chatId)!;
      await this.safeSend(
        trip.driverId,
        `⚠️ ${escapeHtml(passenger.name)} qatnov #${trip.id} dagi bronini bekor qildi (${booking.seats} joy bo'shadi).\n` +
          `Hozir bo'sh joy: ${trip.seatsFree}`,
      );
    }
    return this.showMyBookings(chatId, msgId);
  }

  // ---------- Haydovchi: qatnov e'lon qilish ----------

  private async onTripStep(chatId: number, msgId: number, user: User, parts: string[]): Promise<void> {
    if (user.role !== "driver" || user.driverStatus !== "approved") return this.showMenu(chatId, msgId);
    // t:new -> t:f:<from> -> t:t:<from>:<to> -> t:d:<from>:<to>:<offset> -> (matn) -> t:ok
    const [, step, a, b, c] = parts;
    if (step === "new") {
      return this.api.editMessage(chatId, msgId, "📍 Qayerdan jo'naysiz?", cityKeyboard("t:f"));
    }
    if (step === "f") {
      return this.api.editMessage(
        chatId,
        msgId,
        `📍 ${CITIES[Number(a)]} → qayerga?`,
        cityKeyboard(`t:t:${a}`, CITIES[Number(a)]),
      );
    }
    if (step === "t") {
      return this.api.editMessage(
        chatId,
        msgId,
        `📍 ${CITIES[Number(a)]} → ${CITIES[Number(b)]}\n📅 Qaysi kun?`,
        dateKeyboard(`t:d:${a}:${b}`, DRIVER_DAYS_AHEAD),
      );
    }
    if (step === "d") {
      this.store.setSession(chatId, {
        step: "t_time",
        data: { from: CITIES[Number(a)], to: CITIES[Number(b)], date: tashkentDate(Number(c)) },
      });
      return this.api.editMessage(
        chatId,
        msgId,
        `📍 ${CITIES[Number(a)]} → ${CITIES[Number(b)]}, 📅 ${dateLabel(Number(c))}\n\n🕒 Jo'nash vaqtini yozing (masalan: <i>07:30</i>):`,
      );
    }
    if (step === "ok") {
      const session = this.store.getSession(chatId);
      if (!session || session.step !== "t_confirm") return this.showMenu(chatId, msgId);
      const d = session.data;
      const trip = this.store.addTrip({
        driverId: chatId,
        from: String(d.from),
        to: String(d.to),
        date: String(d.date),
        time: String(d.time),
        seatsTotal: Number(d.seats),
        price: Number(d.price),
      });
      this.store.clearSession(chatId);
      return this.api.editMessage(
        chatId,
        msgId,
        `✅ Qatnov #${trip.id} e'lon qilindi!\n\n${this.tripSummary(trip)}\n\nYangi bron bo'lsa darhol xabar beraman.`,
        [[{ text: "📋 Qatnovlarim", callback_data: "mytr" }], [{ text: "⬅️ Menyu", callback_data: "menu" }]],
      );
    }
  }

  private async showMyTrips(chatId: number, msgId: number): Promise<void> {
    const trips = this.store.driverTrips(chatId);
    if (trips.length === 0) {
      return this.api.editMessage(chatId, msgId, "Sizda faol qatnov yo'q.", [
        [{ text: "➕ Qatnov e'lon qilish", callback_data: "t:new" }],
        [{ text: "⬅️ Menyu", callback_data: "menu" }],
      ]);
    }
    const kb: InlineKeyboard = trips.map((t) => [
      {
        text: `#${t.id} ${t.from}→${t.to} ${formatDate(t.date)} ${t.time} (${t.seatsTotal - t.seatsFree}/${t.seatsTotal})`,
        callback_data: `trp:${t.id}`,
      },
    ]);
    kb.push([{ text: "⬅️ Menyu", callback_data: "menu" }]);
    return this.api.editMessage(chatId, msgId, "📋 <b>Faol qatnovlaringiz</b> (band/jami joy):", kb);
  }

  private async showTripDetails(chatId: number, msgId: number, tripId: number): Promise<void> {
    const trip = this.store.getTrip(tripId);
    if (!trip || trip.driverId !== chatId) return this.showMyTrips(chatId, msgId);
    const passengers = this.store.tripBookings(tripId).map((b) => {
      const p = this.store.getUser(b.passengerId);
      return `👤 ${escapeHtml(p?.name ?? "")} · 📞 ${escapeHtml(p?.phone ?? "")} · 💺 ${b.seats}`;
    });
    const text =
      `<b>Qatnov #${trip.id}</b>\n${this.tripSummary(trip)}\n💺 Bo'sh: ${trip.seatsFree}/${trip.seatsTotal}\n\n` +
      (passengers.length ? `<b>Yo'lovchilar:</b>\n${passengers.join("\n")}` : "Hozircha bron yo'q.");
    return this.api.editMessage(chatId, msgId, text, [
      [{ text: "🏁 Safar yakunlandi", callback_data: `dtr:${trip.id}` }],
      [{ text: "❌ Qatnovni bekor qilish", callback_data: `ctr:${trip.id}` }],
      [{ text: "⬅️ Qatnovlarim", callback_data: "mytr" }],
    ]);
  }

  private async onCloseTrip(
    chatId: number,
    msgId: number,
    tripId: number,
    status: "cancelled" | "done",
  ): Promise<void> {
    const trip = this.store.getTrip(tripId);
    if (!trip || trip.driverId !== chatId) return;
    const bookings = this.store.closeTrip(tripId, status);
    for (const b of bookings) {
      if (status === "cancelled") {
        await this.safeSend(
          b.passengerId,
          `❌ Haydovchi qatnov #${trip.id} ni bekor qildi:\n${this.tripSummary(trip)}\n\nBoshqa qatnov qidirish uchun /start`,
        );
      } else {
        await this.safeSend(
          b.passengerId,
          `🏁 Safar yakunlandi: ${escapeHtml(trip.from)} → ${escapeHtml(trip.to)}\n\nHaydovchiga baho bering:`,
          [[1, 2, 3, 4, 5].map((n) => ({ text: `${n}⭐`, callback_data: `rate:${b.id}:${n}` }))],
        );
      }
    }
    const done = status === "done" ? "🏁 Safar yakunlandi. Yo'lovchilardan baho so'raldi." : "❌ Qatnov bekor qilindi, yo'lovchilarga xabar berildi.";
    return this.api.editMessage(chatId, msgId, done, [[{ text: "⬅️ Menyu", callback_data: "menu" }]]);
  }

  private async onRate(chatId: number, msgId: number, bookingId: number, stars: number): Promise<void> {
    const booking = this.store.getBooking(bookingId);
    if (!booking || booking.passengerId !== chatId || !(stars >= 1 && stars <= 5)) return;
    const ok = this.store.rate(bookingId, stars);
    await this.api.editMessage(chatId, msgId, ok ? `Rahmat! Siz ${stars}⭐ baho berdingiz.` : "Bu safar uchun baho allaqachon berilgan.");
  }

  // ---------- Admin ----------

  private async notifyAdminAboutDriver(user: User): Promise<void> {
    if (this.adminChatId === undefined) return;
    await this.safeSend(
      this.adminChatId,
      `🆕 <b>Yangi haydovchi arizasi</b>\n\n👤 ${escapeHtml(user.name)}\n📞 ${escapeHtml(user.phone ?? "")}\n` +
        `🚗 ${escapeHtml(user.car ?? "")}, ${escapeHtml(user.plate ?? "")}`,
      [
        [
          { text: "✅ Tasdiqlash", callback_data: `adm:ok:${user.id}` },
          { text: "❌ Rad etish", callback_data: `adm:no:${user.id}` },
        ],
      ],
    );
  }

  private async onAdminDecision(chatId: number, msgId: number | undefined, decision: string, userId: number): Promise<void> {
    if (chatId !== this.adminChatId) return;
    const approved = decision === "ok";
    const user = this.store.updateUser(userId, { driverStatus: approved ? "approved" : "rejected" });
    if (!user) return;
    if (msgId) {
      await this.api.editMessage(
        chatId,
        msgId,
        `${approved ? "✅ Tasdiqlandi" : "❌ Rad etildi"}: ${escapeHtml(user.name)}, ${escapeHtml(user.plate ?? "")}`,
      );
    }
    await this.safeSend(
      userId,
      approved
        ? "✅ Siz haydovchi sifatida tasdiqlandingiz! Endi qatnov e'lon qilishingiz mumkin: /start"
        : "❌ Afsus, haydovchi sifatidagi arizangiz rad etildi.",
    );
  }

  // ---------- Yordamchi ----------

  private tripSummary(t: Trip): string {
    return `📍 ${escapeHtml(t.from)} → ${escapeHtml(t.to)}\n📅 ${formatDate(t.date)}, 🕒 ${t.time} · 💰 ${formatSum(t.price)} / joy`;
  }

  /** Boshqa foydalanuvchiga xabar: u botni bloklagan bo'lsa ham asosiy jarayon to'xtamasin. */
  private async safeSend(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    try {
      await this.api.sendMessage(chatId, text, keyboard);
    } catch (err) {
      console.error(`Xabar yuborilmadi (${chatId}):`, err);
    }
  }
}
