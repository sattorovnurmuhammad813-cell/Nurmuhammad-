import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAllTracked, getGiftState, setGiftState } from "../lib/store";
import { getGiftCatalog } from "../lib/gifts";
import { sendMessage } from "../lib/botApi";

function isAuthorized(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // CRON_SECRET sozlanmagan bo'lsa, cheklovsiz (faqat dev uchun)

  const authHeader = req.headers["authorization"];
  if (authHeader === `Bearer ${secret}`) return true; // Vercel native Cron shu headerni qo'shadi

  const querySecret = req.query.secret;
  if (typeof querySecret === "string" && querySecret === secret) return true; // tashqi pinger uchun

  return false;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    const tracked = await getAllTracked();
    if (tracked.length === 0) {
      res.status(200).json({ checked: 0, notified: 0 });
      return;
    }

    const catalog = await getGiftCatalog(true);
    const floorById = new Map(catalog.map((g) => [g.id, g]));

    let notified = 0;

    for (const t of tracked) {
      const gift = floorById.get(t.giftId);
      const floor = gift?.resellMinStars ?? null;

      if (floor == null) {
        // Sovg'a hozircha resale bozorida yo'q - narx bo'lmagani uchun o'tkazib yuboramiz
        continue;
      }

      const inRange = floor >= t.min && floor <= t.max;
      const prevState = await getGiftState(t.chatId, t.giftId);

      // Faqat "diapazonga yangi kirganda" yoki "diapazon ichida narx o'zgarganda" xabar beramiz,
      // har daqiqa bir xil narxni qayta-qayta yubormaslik uchun.
      const shouldNotify = inRange && (!prevState?.lastInRange || prevState.lastPrice !== floor);

      if (shouldNotify) {
        const title = gift?.title ?? t.title;
        await sendMessage(
          t.chatId,
          `🎁 <b>${escapeHtml(title)}</b>\n` +
            `Bozordagi eng arzon narx: <b>${floor} ⭐</b>\n` +
            `Sizning chegarangiz: ${t.min}-${t.max} ⭐\n\n` +
            `Telegram → Sovg'alar → Resale bo'limidan tez tekshiring!`
        );
        notified++;
      }

      await setGiftState(t.chatId, t.giftId, { lastInRange: inRange, lastPrice: floor });
    }

    res.status(200).json({ checked: tracked.length, notified });
  } catch (err) {
    console.error("check-gifts xatosi:", err);
    res.status(500).json({ error: "internal_error" });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
