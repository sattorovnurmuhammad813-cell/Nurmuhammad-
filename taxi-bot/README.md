# Shaharlararo taksi bot (MVP)

Telegram bot: haydovchi shaharlararo qatnov e'lon qiladi, yo'lovchi qidirib joy
band qiladi. Hozir odamlar bu ishni Telegram guruhlarida tartibsiz qiladi -
bot shuni tartibga soladi: aniq narx, bo'sh joylar soni, haydovchi reytingi.

Bu gift botdan **alohida loyiha** - o'z `package.json`i va o'z bot tokeni bor.

## Qanday ishlaydi

### Yo'lovchi
1. `/start` → telefon raqamini yuboradi (faqat o'zinikini, tugma orqali).
2. "Yo'lovchi" → "Qatnov qidirish" → qayerdan → qayerga → qaysi kun (bugun/ertaga/indinga).
3. Mos qatnovlar ro'yxati: vaqt, narx, bo'sh joy, mashina, haydovchi reytingi.
4. Joy band qiladi (1-4 joy) → haydovchining ismi, raqami, mashinasi va davlat raqamini oladi.
5. "Bronlarim" orqali bronni bekor qilishi mumkin - haydovchiga xabar boradi.
6. Safar tugagach haydovchiga 1-5 ⭐ baho beradi.

### Haydovchi
1. `/start` → raqam → "Haydovchi" → mashina markasi/rangi → davlat raqami.
2. Admin (`ADMIN_CHAT_ID`) ga ariza boradi, u "Tasdiqlash" yoki "Rad etish"ni bosadi.
3. Tasdiqlangach: "Qatnov e'lon qilish" → qayerdan → qayerga → kun (7 kun oldinga) →
   vaqt → bo'sh joylar → bir joy narxi → tasdiqlash.
4. Har bir yangi bron yoki bekor qilish haqida darhol xabar keladi
   (yo'lovchining ismi va raqami bilan).
5. "Qatnovlarim" → qatnov → yo'lovchilar ro'yxati, "Safar yakunlandi"
   (yo'lovchilardan baho so'raladi) yoki "Qatnovni bekor qilish"
   (yo'lovchilarga xabar boradi).

## Ishga tushirish

1. Telegram'da **@BotFather** → `/newbot` → yangi token oling.
2. O'zingizning chat ID'ingizni bilib oling (masalan **@userinfobot** orqali) - u admin bo'ladi.
3. Kompyuter yoki serverda:

```bash
cd taxi-bot
npm install
export TAXI_BOT_TOKEN="123456:ABC..."   # tokenni hech qayerga (GitHub'ga) yozmang
export ADMIN_CHAT_ID="123456789"
npm start
```

`ADMIN_CHAT_ID` bo'sh qolsa, har bir haydovchi avtomatik tasdiqlanadi - bu faqat
o'zingiz sinab ko'rish uchun.

Bot 24/7 ishlashi uchun uni doim yoqiq turadigan joyda ishga tushiring
(kichik VPS, Railway, Render va h.k.), masalan `pm2` bilan:

```bash
pm2 start "npx ts-node src/index.ts" --name taxi-bot
```

Ma'lumotlar `data.json` faylida saqlanadi (`DATA_FILE` bilan o'zgartirish mumkin).
Undan muntazam zaxira nusxa oling.

## Fayllar

| Fayl | Vazifasi |
|---|---|
| `src/index.ts` | Ishga tushirish, Telegram'dan yangilanishlarni olish (long polling) |
| `src/bot.ts` | Barcha menyular va bosqichlar: yo'lovchi, haydovchi, admin |
| `src/store.ts` | Foydalanuvchilar, qatnovlar, bronlar - JSON faylda |
| `src/telegram.ts` | Telegram Bot API bilan ishlash |

## Keyingi bosqichlar (MVP ishlasa)

- **Ma'lumotlar bazasi**: JSON fayl o'rniga PostgreSQL - foydalanuvchilar yuzlab bo'lganda.
- **Eslatma**: jo'nashdan 1 soat oldin haydovchi va yo'lovchilarga xabar.
- **Eski qatnovlarni avtomatik yopish**: sanasi o'tgan qatnovlar ro'yxatdan chiqsin.
- **Shikoyat tugmasi** va yomon reytingli haydovchini bloklash.
- **To'lov** (Payme/Click) - faqat odamlar haqiqatan foydalana boshlagach.
- **Daromad**: haydovchidan har bir bron uchun kichik komissiya yoki oylik obuna.

## Qonuniy jihat

Yo'lovchi tashish va dispetcherlik xizmati O'zbekistonda litsenziya va soliq
qoidalariga bo'ysunadi. Pul olishni boshlashdan oldin yurist bilan maslahatlashing.
