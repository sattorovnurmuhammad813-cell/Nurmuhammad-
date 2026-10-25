import { TelegramApi } from "./telegram";
import { Store } from "./store";
import { TaxiBot } from "./bot";

async function main(): Promise<void> {
  const token = process.env.TAXI_BOT_TOKEN;
  if (!token) {
    console.error("TAXI_BOT_TOKEN o'rnatilmagan. .env.example faylini qarang.");
    process.exit(1);
  }
  const adminRaw = process.env.ADMIN_CHAT_ID?.trim();
  const adminChatId = adminRaw ? Number(adminRaw) : undefined;
  if (adminChatId === undefined) {
    console.warn("ADMIN_CHAT_ID yo'q: haydovchilar AVTOMATIK tasdiqlanadi. Faqat sinov uchun!");
  }

  const api = new TelegramApi(token);
  const store = new Store(process.env.DATA_FILE ?? "./data.json");
  const bot = new TaxiBot(api, store, adminChatId);

  // Webhook o'rnatilgan bo'lsa getUpdates ishlamaydi
  await api.call("deleteWebhook");
  await api.call("setMyCommands", {
    commands: [
      { command: "start", description: "Menyu" },
      { command: "yordam", description: "Bot qanday ishlaydi" },
    ],
  });
  console.log("Taksi bot ishga tushdi.");

  let offset = 0;
  for (;;) {
    try {
      const updates = await api.getUpdates(offset, 30);
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await bot.handleUpdate(update);
        } catch (err) {
          console.error(`Update ${update.update_id} xatosi:`, err);
        }
      }
    } catch (err) {
      console.error("getUpdates xatosi, 5 soniyadan keyin qayta urinaman:", err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
