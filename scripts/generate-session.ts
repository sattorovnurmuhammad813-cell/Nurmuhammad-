/**
 * BU SKRIPTNI FAQAT O'ZINGIZNING LOKAL KOMPYUTERINGIZDA ISHGA TUSHIRING.
 * Hech qachon uzoq/umumiy serverda yoki boshqa birov bilan ishlatmang -
 * u sizning shaxsiy Telegram akkauntingizga to'liq kirish huquqi beruvchi
 * "session string" hosil qiladi (parolingiz kabi maxfiy).
 *
 * Ishga tushirish: npm run session
 * (TELEGRAM_API_ID / TELEGRAM_API_HASH ni .env faylga yozib qo'ying yoki
 *  so'ralganda qo'lda kiriting)
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

  const forceSMS = process.env.FORCE_SMS === "1";

  await client.start({
    phoneNumber: async () => ask("Telefon raqamingiz (+998...): "),
    password: async () => ask("Ikki bosqichli parol (bo'lmasa bo'sh qoldiring): "),
    phoneCode: async (isCodeViaApp) => {
      console.log(
        isCodeViaApp
          ? "\n(Kod Telegram ilovasi ichida - 'Telegram' nomli maxsus xabar sifatida yuborildi)"
          : "\n(Kod SMS xabar sifatida yuborildi - Xabarlar ilovasini tekshiring)"
      );
      return ask("Tasdiqlash kodi: ");
    },
    forceSMS,
    onError: (err) => console.error(err),
  });

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
