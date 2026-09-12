# Doimiy ishlaydigan tez tekshiruv (VPS worker) - o'rnatish qo'llanmasi

Bu `worker/` papkasi - Vercel'dan butunlay mustaqil, **doimiy ishlaydigan** dastur.
U MTProto ulanishini bir marta ochadi va umrbod saqlaydi, shu sabab har
`POLL_INTERVAL_MS` (standart 1.5 soniya) da bir marta narxlarni tekshiradi -
avvalgi 1 daqiqalik cron'dan ancha tezroq.

## 0-qadam: MUHIM - eski tizimni to'xtatish

Worker ishga tushgach, **bitta sessiya bilan faqat BITTA joy** ulanishi kerak.
Aks holda yana `AUTH_KEY_DUPLICATED` xatosi qaytadi. Shuning uchun worker
ishga tushishidan OLDIN:

1. **cron-job.org**'da "Gift checker" jobini **Disable** qiling
2. Har bir bot uchun Telegram webhook'ini o'chiring - brauzerda oching:
   ```
   https://api.telegram.org/bot<BOT_TOKEN>/deleteWebhook
   ```
   (ikkinchi bot bo'lsa, `<BOT_TOKEN_2>` bilan ham xuddi shunday)

## 1-qadam: Oracle Cloud Free Tier'da hisob ochish

1. https://www.oracle.com/cloud/free/ ga kiring, ro'yxatdan o'ting
2. Email, telefon tasdiqlash va karta ma'lumotlarini kiritish so'raladi
   (pul yechilmaydi, faqat tasdiqlash uchun - "Always Free" tarifida)

## 2-qadam: Virtual server (VM instance) yaratish

1. Oracle Cloud konsolida: **Compute → Instances → Create Instance**
2. **Image**: Ubuntu 22.04
3. **Shape**: "Always Free eligible" deb belgilangan birortasini tanlang
   (masalan `VM.Standard.A1.Flex`, 1 OCPU / 6 GB RAM)
4. SSH kaliti avtomatik yaratiladi - **"Save Private Key"** tugmasini bosib
   yuklab oling va xavfsiz joyda saqlang (bu serverga kirish "parolingiz")
5. **Create** tugmasini bosing, bir necha daqiqa kutib server tayyor
   bo'lishini kuting ("Running" holatiga o'tguncha)

## 3-qadam: Serverga ulanish

Oracle konsolida instance sahifasida **"Public IP Address"**ni ko'rasiz.

Eng oson yo'l - brauzer orqali: instance sahifasida **"Connect"** tugmasini
bosing, u yerda **"Launch Cloud Shell"** kabi variant chiqadi - bu brauzer
ichida to'g'ridan-to'g'ri terminal ochadi, alohida dastur o'rnatish shart emas.

## 4-qadam: Serverni sozlash

Ochilgan terminalda ketma-ket:

```bash
sudo apt update && sudo apt install -y nodejs npm git
node --version   # v18 yoki undan yuqori bo'lishi kerak
```

Agar `node --version` 18'dan past chiqsa:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

## 5-qadam: Loyihani yuklab olish

```bash
git clone https://github.com/sattorovnurmuhammad813-cell/Nurmuhammad-.git
cd Nurmuhammad-
npm install
```

## 6-qadam: Maxfiy kalitlarni sozlash

```bash
nano .env
```

Ochilgan muharrirga quyidagilarni yozing (har birini o'z qiymatingiz bilan,
Vercel'dagi Environment Variables'dan nusxalab oling):

```
TELEGRAM_API_ID=...
TELEGRAM_API_HASH=...
TELEGRAM_SESSION_STRING=...
BOT_TOKEN=...
BOT_TOKEN_2=...
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
POLL_INTERVAL_MS=1500
```

Saqlash: `Ctrl+O`, `Enter`, chiqish: `Ctrl+X`.

## 7-qadam: Sinab ko'rish

```bash
npm run worker
```

Terminalda `[telegramClient] MTProto ulandi...`, `[commands] Bot "a" uchun
long-polling boshlandi...`, `[poll] Tez tekshiruv sikli boshlandi...` kabi
qatorlar chiqishi kerak. Botga Telegram'da `/status` yuborib tekshiring.

`Ctrl+C` bilan to'xtating (keyingi qadamda uni "doimiy" qilib ishga
tushiramiz).

## 8-qadam: Doimiy (24/7, qulab tushsa avtomatik qayta ishga tushadigan) qilish

```bash
sudo npm install -g pm2
pm2 start node_modules/.bin/ts-node --name giftbot-worker --interpreter node -- worker/index.ts
pm2 save
pm2 startup
```

MUHIM: `pm2 start npm -- run worker` EMAS, aynan `ts-node`ni to'g'ridan-to'g'ri
ishga tushiring. `npm run worker` orqali ishga tushirilsa, pm2 aslida `npm`
jarayonini boshqaradi, haqiqiy kod esa uning FARZAND jarayonida ishlaydi -
pm2'ning `restart`/`stop` signali shu farzandgacha ishonchli yetib bormaydi,
natijada worker ichidagi "toza to'xtash" aniqlagichi (watchdog) har bir oddiy
qayta ishga tushirishni ham "kutilmagan crash" deb xato signal beradi.

`pm2 startup` buyrug'i ekranga yana bir buyruq chiqaradi (masalan
`sudo env PATH=... pm2 startup systemd -u ubuntu --hp /home/ubuntu`) -
o'sha chiqqan buyruqni nusxalab, alohida yana bir marta ishga tushiring.
Shu orqali server qayta yuklansa ham worker o'zi qayta ishga tushadi.

Loglarni ko'rish: `pm2 logs giftbot-worker`
Qayta ishga tushirish: `pm2 restart giftbot-worker`
To'xtatish: `pm2 stop giftbot-worker`
