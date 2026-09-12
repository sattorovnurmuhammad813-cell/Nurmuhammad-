import "dotenv/config";
import { getUserClient } from "./telegramClient";
import { startPollLoop } from "./poll";
import { startCommandLoop } from "./commands";
import { getConfiguredBots } from "../lib/bots";
import { setMyCommands, setChatMenuButton } from "../lib/botApi";

// Botning "Menu" tugmasidagi ro'yxat - ixcham tutish uchun eng ko'p ishlatiladigan
// buyruqlar bilan cheklangan (/track, /untrack, /listgifts kabi kamroq ishlatiladiganlari
// bu ro'yxatda ko'rinmaydi, lekin yozib yuborilsa baribir ishlayveradi).
const MENU_COMMANDS = [
  { command: "giftlar", description: "🎁 Giftlar ro'yxati" },
  { command: "list", description: "📋 Mening kuzatuvlarim" },
  { command: "status", description: "📊 Bot holati" },
  { command: "pause", description: "⏸ To'xtatish" },
  { command: "resume", description: "▶️ Yoqish" },
  { command: "help", description: "❓ Yordam" },
];

/**
 * Menu tugmasini to'liq o'rnatadi - ikkita ALOHIDA Bot API chaqiruvi kerak:
 *  1. `setMyCommands` - ro'yxat MAZMUNI (qaysi buyruqlar, qanday tavsif bilan)
 *  2. `setChatMenuButton` - tugmaning O'ZI (ikonkasi/turi "commands" qilib
 *     ko'rsatiladi) - shu chaqirilmasa, tugma umuman chiqmasligi mumkin,
 *     hatto buyruqlar ro'yxati BotFather'da to'g'ri ko'rinsa ham (aynan shu
 *     holat sodir bo'lgani aniqlandi - avvalgi kodda faqat #1 chaqirilar,
 *     #2 esa hech qachon chaqirilmagan edi).
 * Ikkalasi ham muvaffaqiyatsiz bo'lsa alohida qayta uriniladi (o'sib
 * boruvchi kutish bilan) - avvalgi "otib yuborib unutish" usuli xatoni
 * faqat log qilardi va hech qachon qayta urinmasdi.
 */
async function ensureMenuButton(token: string, botId: string): Promise<void> {
  const MAX_ATTEMPTS = 5;
  let commandsOk = false;
  let buttonOk = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (!commandsOk) commandsOk = await setMyCommands(token, MENU_COMMANDS);
    if (!buttonOk) buttonOk = await setChatMenuButton(token);

    if (commandsOk && buttonOk) {
      console.log(`[index] Bot "${botId}": Menu tugmasi va buyruqlar ro'yxati o'rnatildi (${MENU_COMMANDS.length} buyruq).`);
      return;
    }
    if (attempt < MAX_ATTEMPTS) {
      const waitMs = 2000 * attempt;
      console.error(
        `[index] Bot "${botId}": urinish ${attempt}/${MAX_ATTEMPTS} to'liq muvaffaqiyatli emas ` +
          `(setMyCommands=${commandsOk}, setChatMenuButton=${buttonOk}), ${waitMs}ms dan keyin qayta urinamiz.`
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  console.error(
    `[index] Bot "${botId}": ${MAX_ATTEMPTS} urinishdan keyin ham to'liq o'rnatilmadi ` +
      `(setMyCommands=${commandsOk}, setChatMenuButton=${buttonOk})!`
  );
}

async function main() {
  const bots = getConfiguredBots();
  if (bots.length === 0) {
    console.error("Hech qanday bot sozlanmagan (BOT_TOKEN yoki BOT_TOKEN_2 env var yo'q). To'xtatilmoqda.");
    process.exit(1);
  }

  const client = await getUserClient();

  // Har bir bot uchun buyruqlarni tinglash (parallel, bir-biriga xalaqit bermaydi)
  for (const bot of bots) {
    // Fonda ishga tushiramiz (await qilmasdan) - ichkarida o'ziga xos qayta
    // urinish bor, shu sabab bot javob berishni kutib turishga hojat yo'q;
    // Menu tugmasi bir necha soniyada fonda o'rnatiladi.
    ensureMenuButton(bot.token, bot.id).catch((err) => {
      console.error(`[index] Bot "${bot.id}" uchun ensureMenuButton kutilmagan xatosi:`, err);
    });
    startCommandLoop(bot, client).catch((err) => {
      console.error(`[index] Bot "${bot.id}" command loop butunlay to'xtadi:`, err);
    });
  }

  // Tez narx tekshiruvi (POLL_INTERVAL_MS millisekundda bir marta, standart 1.5s)
  await startPollLoop(client);
}

main().catch((err) => {
  console.error("[index] Worker to'xtadi:", err);
  process.exit(1);
});
