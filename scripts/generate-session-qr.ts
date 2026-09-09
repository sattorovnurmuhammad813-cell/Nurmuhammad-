/**
 * SMS/kod kutmasdan, QR-kod (tg://login link) orqali session yaratish.
 * Telegram'ning "SEND_CODE_UNAVAILABLE" kabi kod yuborish cheklovlariga
 * umuman tegishli emas - chunki bu usulda kod yuborilmaydi.
 *
 * BU SKRIPTNI FAQAT O'ZINGIZNING QURILMANGIZDA ISHGA TUSHIRING.
 *
 * Ishga tushirish: npm run session:qr
 */
import * as readline from "readline";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID || (await ask("API_ID (my.telegram.org): ")));
  const apiHash = process.env.TELEGRAM_API_HASH || (await ask("API_HASH (my.telegram.org): "));

  if (!apiId || !apiHash) {
    console.error("API_ID va API_HASH kerak. https://my.telegram.org dan oling.");
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();

  await client.signInUserWithQrCode(
    { apiId, apiHash },
    {
      qrCode: async (code) => {
        const token = code.token.toString("base64url");
        const url = `tg://login?token=${token}`;
        console.log("\n=============================================");
        console.log("Telegram ilovangizni oching:");
        console.log("Sozlamalar -> Qurilmalar (Devices) -> Qurilma ulash (Link Desktop Device)");
        console.log("va shu havolani ochib bering (nusxalab, brauzer manzil");
        console.log("qatoriga joylashtirib Enter bosing - Telegram avtomatik ochadi):\n");
        console.log(url);
        console.log("\n(Havola ~30 soniyada eskiradi, eskirsa avtomatik yangisi chiqadi)");
        console.log("=============================================\n");
      },
      password: async (hint) => ask(`Ikki bosqichli parol${hint ? ` (eslatma: ${hint})` : ""}: `),
      onError: async (err) => {
        console.error("Xatolik:", err.message || err);
        return false; // davom etishga harakat qilamiz (masalan parol xato bo'lsa qayta so'raladi)
      },
    }
  );

  const sessionString = client.session.save() as unknown as string;

  console.log("\n\n================ SESSION TAYYOR ================");
  console.log("Quyidagi qatorni Vercel Dashboard > Settings > Environment");
  console.log("Variables bo'limiga TELEGRAM_SESSION_STRING nomi bilan qo'shing.");
  console.log("Bu qatorni hech kimga (shu jumladan AI yordamchilarga ham) YUBORMANG:\n");
  console.log(sessionString);
  console.log("==================================================\n");

  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
