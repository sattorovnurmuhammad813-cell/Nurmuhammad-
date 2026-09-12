import { Redis } from "@upstash/redis";
import { getConfiguredBots } from "./bots";
import { sendMessage } from "./botApi";

const redis = Redis.fromEnv();

// Bir xil turdagi xavf signali qisqa vaqt ichida ko'p marta takrorlansa
// (masalan FLOOD_WAIT ketma-ket bir necha so'rovda), foydalanuvchini xabarlar
// bilan bosib qolmaslik uchun har bir tur uchun sovish (cooldown) muddati.
const ALERT_COOLDOWN_SEC = 5 * 60;

export type RiskSignal =
  | "FLOOD_WAIT"
  | "PEER_FLOOD"
  | "AUTH_KEY_DUPLICATED"
  | "AUTH_KEY_UNREGISTERED"
  | "AUTH_KEY_INVALID"
  | "DISCONNECTED";

/** Xato xabarini xavf turlaridan biriga mos kelishini tekshiradi, mos kelmasa null */
export function classifyRisk(err: unknown): RiskSignal | null {
  const msg = String((err as any)?.errorMessage ?? (err as any)?.message ?? err ?? "");
  if (/FLOOD_WAIT/i.test(msg)) return "FLOOD_WAIT";
  if (/PEER_FLOOD/i.test(msg)) return "PEER_FLOOD";
  if (/AUTH_KEY_DUPLICATED/i.test(msg)) return "AUTH_KEY_DUPLICATED";
  if (/AUTH_KEY_UNREGISTERED/i.test(msg)) return "AUTH_KEY_UNREGISTERED";
  if (/AUTH_KEY_INVALID/i.test(msg)) return "AUTH_KEY_INVALID";
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket.*(closed|disconnect)|disconnect.*socket/i.test(msg)) return "DISCONNECTED";
  return null;
}

/**
 * Bir xil `cooldownKey` uchun qisqa vaqt ichida qayta-qayta chaqirilishning
 * oldini oladi (masalan ketma-ket bir necha so'rovda FLOOD_WAIT, yoki uzoq
 * vaqt davom etayotgan watchdog "stall" holati) - foydalanuvchini xabarlar
 * bilan bosib qolmaslik uchun.
 */
async function coolingDown(cooldownKey: string): Promise<boolean> {
  const key = `gifts:alerts:cooldown:${cooldownKey}`;
  const set = await redis.set(key, "1", { nx: true, ex: ALERT_COOLDOWN_SEC });
  return set !== "OK"; // NX muvaffaqiyatsiz bo'lsa (allaqachon bor) - hali sovimagan
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Barcha ma'lum (botlar bilan gaplashgan) chatlarga Bot API orqali xabar yuboradi */
async function broadcastToAllChats(text: string): Promise<void> {
  const bots = getConfiguredBots();
  for (const bot of bots) {
    const chatIds = await redis.smembers(`gifts:${bot.id}:chats`);
    for (const chatId of chatIds) {
      await sendMessage(bot.token, chatId, text).catch(() => {});
    }
  }
}

/**
 * Umumiy operatsion ogohlantirish kanali - MTProto xavf signallari, worker
 * watchdog (crash/stall aniqlash) va kelajakdagi boshqa turdagi muhim
 * hodisalar shu orqali xabar yuborishi mumkin. `cooldownKey` xabar TURI
 * bo'yicha noyob bo'lishi kerak - shunda turli xil ogohlantirishlar
 * bir-birining sovish muddatiga ta'sir qilmaydi.
 */
export async function sendOpsAlert(text: string, cooldownKey: string): Promise<void> {
  try {
    if (await coolingDown(cooldownKey)) return;
    await broadcastToAllChats(text);
  } catch (err) {
    // Ogohlantirish tizimining o'zi hech qachon asosiy oqimni to'xtatmasligi kerak
    console.error("[alerts] sendOpsAlert xatosi:", err);
  }
}

/**
 * Xato MTProto xavf signaliga mos kelsa, barcha faol chatlarga (Bot API orqali,
 * MTProto'dan mustaqil alohida kanal) darhol ogohlantirish yuboradi. Mos
 * kelmasa yoki hozirgina xuddi shu turdagi ogohlantirish yuborilgan bo'lsa,
 * hech narsa qilmaydi.
 */
export async function alertRiskSignal(err: unknown, context: string): Promise<void> {
  const signal = classifyRisk(err);
  if (!signal) return;

  const rawMsg = String((err as any)?.errorMessage ?? (err as any)?.message ?? err);
  const text =
    `⚠️ <b>Diqqat! Telegram tomonidan cheklov signali aniqlandi</b>\n\n` +
    `Turi: <code>${signal}</code>\n` +
    `Joyi: ${escapeHtml(context)}\n` +
    `Xato: <code>${escapeHtml(rawMsg).slice(0, 300)}</code>\n\n` +
    `Xavfsizlik uchun tekshirib chiqing.`;

  await sendOpsAlert(text, signal);
}
