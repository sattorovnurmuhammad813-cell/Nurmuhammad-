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
  { command: "giftlar", description: "🎁 Sovg'alar ro'yxati" },
  { command: "list", description: "📋 Mening kuzatuvlarim" },
  { command: "pause", description: "⏸ To'xtatish" },
  { command: "resume", description: "▶️ Yoqish" },
  { command: "status", description: "📊 Bot holati" },
  { command: "help", description: "❓ Yordam" },
];

async function main() {
  const bots = getConfiguredBots();
  if (bots.length === 0) {
    console.error("Hech qanday bot sozlanmagan (BOT_TOKEN yoki BOT_TOKEN_2 env var yo'q). To'xtatilmoqda.");
    process.exit(1);
  }

  const client = await getUserClient();

  // Har bir bot uchun buyruqlarni tinglash (parallel, bir-biriga xalaqit bermaydi)
  for (const bot of bots) {
    setMyCommands(bot.token, MENU_COMMANDS).catch((err) => {
      console.error(`[index] Bot "${bot.id}" uchun setMyCommands xatosi:`, err);
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
