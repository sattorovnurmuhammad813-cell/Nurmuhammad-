import "dotenv/config";
import { getUserClient } from "./telegramClient";
import { startPollLoop } from "./poll";
import { startCommandLoop } from "./commands";
import { getConfiguredBots } from "../lib/bots";
import { setMyCommands } from "../lib/botApi";

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
 * Menu tugmasini o'rnatadi - muvaffaqiyatsiz bo'lsa bir necha marta qayta
 * urinadi (o'sib boruvchi kutish bilan), chunki avvalgi "otib yuborib unutish"
 * (fire-and-forget) usuli xatoni faqat log qilardi va hech qachon qayta
 * urinmasdi - worker qayta ishga tushganda tarmoq vaqtincha beqaror bo'lsa,
 * Menu tugmasi butunlay o'rnatilmasdan qolib ketishi mumkin edi.
 */
async function ensureMenuCommands(token: string, botId: string): Promise<void> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ok = await setMyCommands(token, MENU_COMMANDS);
    if (ok) {
      console.log(`[index] Bot "${botId}": Menu tugmasi o'rnatildi (${MENU_COMMANDS.length} buyruq).`);
      return;
    }
    if (attempt < MAX_ATTEMPTS) {
      const waitMs = 2000 * attempt;
      console.error(`[index] Bot "${botId}": setMyCommands urinish ${attempt}/${MAX_ATTEMPTS} muvaffaqiyatsiz, ${waitMs}ms dan keyin qayta urinamiz.`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  console.error(`[index] Bot "${botId}": Menu tugmasini ${MAX_ATTEMPTS} urinishdan keyin ham o'rnatib bo'lmadi!`);
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
    ensureMenuCommands(bot.token, bot.id).catch((err) => {
      console.error(`[index] Bot "${bot.id}" uchun ensureMenuCommands kutilmagan xatosi:`, err);
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
