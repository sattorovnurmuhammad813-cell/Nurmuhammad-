# Giftaniqlivchi — Telegram gift narx kuzatuvchi bot

Telegram'ning kolleksion sovg'alar (gift) bozorida ("Buy a Gift → Resale")
biror sovg'aning eng arzon (floor) narxi siz belgilagan oraliqqa tushganda
Telegram orqali darhol xabar beradi.

## ⚠️ Muhim: arxitektura haqida

Telegram **Bot API** orqali resale bozor narxlarini o'qib bo'lmaydi — bu
funksiya faqat oddiy foydalanuvchi akkaunti orqali ishlaydigan maxsus
MTProto metodida (`payments.getStarGifts`, `resellMinStars` maydoni) mavjud.
Shu sababli loyihada ikki xil "aktyor" bor:

1. **Bot** (`BOT_TOKEN`) — faqat sizga xabar yuborish uchun.
2. **Oddiy Telegram akkaunt** (`TELEGRAM_SESSION_STRING`) — bozor narxlarini
   o'qish uchun. Bu — sizning shaxsiy (yoki shu maqsad uchun ochilgan alohida)
   Telegram akkauntingiz bo'lishi mumkin. Bu akkauntning "session"i parolingiz
   kabi maxfiy — uni hech kimga (shu jumladan AI yordamchilarga ham) bermang.

Shuningdek, Vercel **Hobby (bepul)** reja cron ishlarini faqat kuniga bir
marta ishga tushirishga ruxsat beradi, daqiqasiga emas. Haqiqiy 1 daqiqalik
(yoki tezroq) tekshiruv uchun ikkita yo'l bor:

- **Vercel Pro** rejaga o'tish va `vercel.json`ga native cron qo'shish (pastda).
- **Bepul**: Vercel Hobby'da qolib, tashqi bepul cron xizmati
  (masalan [cron-job.org](https://cron-job.org)) orqali
  `/api/check-gifts?secret=...` endpointini har daqiqada chaqirtirish.

5-10 soniyalik tekshiruv chinakam real-time kerak bo'lsa, bu loyihani
Vercel'dan tashqari, 24/7 ishlaydigan alohida worker (Railway/Render/Fly.io
yoki kichik VPS'dagi `while true` sikli) sifatida ham ishga tushirish mumkin
— buning uchun `lib/` papkasidagi kod qayta ishlatiladi, faqat `api/*.ts`
o'rniga oddiy Node skript yoziladi.

## 1-qadam: eski tokenni bekor qiling

Siz bot tokenini ochiq chatda yubordingiz, u endi xavfsiz emas.
Telegram'da **@BotFather** ga o'ting:

```
/revoke
```

va botingizni tanlab, yangi token oling. Yangi tokenni hech qayerga (kodga,
GitHub'ga) yozmang — faqat quyida ko'rsatilgandek environment variable
sifatida saqlang.

## 2-qadam: MTProto uchun API_ID / API_HASH

1. https://my.telegram.org ga kiring (o'z telefon raqamingiz bilan).
2. **API development tools** bo'limiga o'ting.
3. Istalgan nom bilan ilova yarating — sizga `api_id` va `api_hash` beriladi.

## 3-qadam: loyihani sozlash

```bash
npm install
cp .env.example .env
```

`.env` faylni to'ldiring: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`.

## 4-qadam: session string yaratish (FAQAT lokal kompyuteringizda)

```bash
npm run session
```

Telefon raqam va Telegram'dan keladigan tasdiqlash kodini kiritasiz
(2FA bo'lsa, parolni ham). Oxirida uzun bir qator (`session string`) chiqadi.

**Bu qatorni hech qayerga nusxalab tashlamang, faylga yozmang, chatga
yubormang.** Uni to'g'ridan-to'g'ri keyingi qadamda Vercel Dashboard'ga
kiritasiz.

## 5-qadam: Upstash Redis (holatni saqlash uchun)

1. https://upstash.com da bepul akkaunt oching, yangi **Redis** database
   yarating (Region — Vercel regioningizga yaqin bo'lsin).
2. **REST API** bo'limidan `UPSTASH_REDIS_REST_URL` va
   `UPSTASH_REDIS_REST_TOKEN` qiymatlarini oling.

## 6-qadam: Vercel'ga deploy

```bash
npm i -g vercel   # agar o'rnatilmagan bo'lsa
vercel link
vercel env add BOT_TOKEN
vercel env add TELEGRAM_API_ID
vercel env add TELEGRAM_API_HASH
vercel env add TELEGRAM_SESSION_STRING
vercel env add CRON_SECRET
vercel env add WEBHOOK_SECRET
vercel env add UPSTASH_REDIS_REST_URL
vercel env add UPSTASH_REDIS_REST_TOKEN
vercel --prod
```

`CRON_SECRET` va `WEBHOOK_SECRET` uchun o'zingiz tasodifiy uzun matn
o'ylab toping, masalan:

```bash
openssl rand -hex 24
```

## 7-qadam: Telegram webhookni ulash

Deploy tugagach, `https://<loyihangiz>.vercel.app` manzilingiz bo'ladi.
Quyidagi buyruqni **bir marta**, o'zingiz terminalda ishga tushiring
(o'z `BOT_TOKEN` va `WEBHOOK_SECRET` qiymatlaringiz bilan):

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<loyihangiz>.vercel.app/api/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

### Ikkinchi bot (ixtiyoriy)

Loyiha bitta MTProto akkaunt va bitta Redis'dan foydalangan holda **ikkita
alohida Telegram botini** bir vaqtda ishlata oladi — ular bir-biridan
mustaqil, har birining o'z foydalanuvchilari va kuzatuvlari bo'ladi.

Buning uchun `BOT_TOKEN_2` va `WEBHOOK_SECRET_2` ni ham (5-qadamdagi kabi)
Vercel env variables'ga qo'shing, qayta deploy qiling, so'ng shu botning
o'z tokeni bilan webhookni ulang:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN_2>/setWebhook" \
  -d "url=https://<loyihangiz>.vercel.app/api/webhook2" \
  -d "secret_token=<WEBHOOK_SECRET_2>"
```

E'tibor bering: ikkinchi bot uchun `/api/webhook2` manzili ishlatiladi
(birinchisi — `/api/webhook`).

## 8-qadam: narxni tekshirish jadvalini yoqish

**Agar Vercel Pro'dasiz** — `vercel.json` fayliga qo'shing va qayta deploy
qiling:

```jsonc
{
  "functions": {
    "api/check-gifts.ts": { "maxDuration": 60 },
    "api/webhook.ts": { "maxDuration": 30 }
  },
  "crons": [
    { "path": "/api/check-gifts", "schedule": "* * * * *" }
  ]
}
```

Vercel bunday cron so'rovlariga avtomatik `Authorization: Bearer
<CRON_SECRET>` header qo'shadi — kod buni allaqachon tekshiradi.

**Agar Vercel Hobby (bepul)'dasiz** — [cron-job.org](https://cron-job.org)da
bepul akkaunt oching va har daqiqada quyidagi manzilni GET qiladigan cron
job yarating:

```
https://<loyihangiz>.vercel.app/api/check-gifts?secret=<CRON_SECRET>
```

## Botdan foydalanish

Botingiz bilan shaxsiy chatda:

- `/listgifts` — barcha kolleksion sovg'alar ro'yxati, ID va hozirgi
  eng arzon (floor) narxi bilan.
- `/track <gift_id> <min> <max>` — shu sovg'a narxi berilgan oraliqqa
  tushganda xabar berilsin.
  Masalan (skrinshotdagi kabi): `/track 123456789 125 420`
- `/list` — siz kuzatayotgan sovg'alar ro'yxati.
- `/untrack <gift_id>` — kuzatuvdan olib tashlash.

Narx belgilangan oralig'ingizga yangi kirganda (yoki oraliq ichida
o'zgarganda) bot avtomatik xabar yuboradi.

## Loyiha tuzilishi

```
api/
  webhook.ts       — Bot A buyruqlarini qabul qiladi (/track, /list, ...)
  webhook2.ts      — Bot B buyruqlarini qabul qiladi (ixtiyoriy, ikkinchi bot)
  check-gifts.ts   — cron/tashqi pinger chaqiradigan narx tekshiruvchi (ikkala bot uchun)
lib/
  telegramClient.ts — MTProto (teleproto) ulanishi
  gifts.ts          — sovg'alar katalogi va floor narxni olish
  botApi.ts         — Telegram Bot API'ga xabar yuborish
  store.ts          — Upstash Redis orqali kuzatuvlar va holatni saqlash (botId bo'yicha ajratilgan)
  bots.ts           — env vardan bot(lar) konfiguratsiyasini o'qish
  webhookHandler.ts — ikkala bot ham ishlatadigan umumiy buyruq logikasi
scripts/
  generate-session.ts — session string yaratish uchun lokal skript
```

## Xavfsizlik eslatmalari

- `TELEGRAM_SESSION_STRING` — akkauntingizga to'liq kirish huquqi. Uni
  faqat Vercel'ning shifrlangan environment variables bo'limida saqlang.
- `CRON_SECRET` va `WEBHOOK_SECRET` bo'lmasa, endpointlar ochiq qoladi —
  ularni albatta sozlang.
- `.env` fayli `.gitignore`da — hech qachon commit qilmang.
