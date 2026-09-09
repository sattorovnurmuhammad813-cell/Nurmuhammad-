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
import { exec } from "child_process";
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

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "win32"
      ? `start "" "${url}"`
      : platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.error("Brauzerni avtomatik ochib bo'lmadi:", err.message);
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
        const tgUrl = `tg://login?token=${token}`;
        const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(tgUrl)}`;

        console.log("\n=============================================");
        console.log("Brauzerda QR-kod avtomatik ochilmoqda...");
        console.log("DARHOL telefoningizda: Telegram -> Sozlamalar -> Qurilmalar");
        console.log("-> Qurilma ulash (Link Desktop Device) -> kamerani ekrandagi");
        console.log("QR-kodga qarating!");
        console.log("(Agar brauzer ochilmasa, shu havolani qo'lda oching: " + qrImageUrl + ")");
        console.log("=============================================\n");

        openInBrowser(qrImageUrl);
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
