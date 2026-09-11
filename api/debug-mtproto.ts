import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getGiftCatalog } from "../lib/gifts";

/**
 * Vaqtinchalik diagnostika endpointi - MTProto sessiyasi ishlayotganini
 * to'g'ridan-to'g'ri (bot suhbatisiz, hech qanday chatga xabar yubormasdan)
 * tekshirish uchun. Muammo hal bo'lgach OLIB TASHLANADI.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const secret = process.env.DEBUG_MTPROTO_SECRET;
  if (!secret || req.query.secret !== secret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    const catalog = await getGiftCatalog(true);
    res.status(200).json({ ok: true, count: catalog.length });
  } catch (err: any) {
    res.status(200).json({
      ok: false,
      errorName: err?.constructor?.name ?? typeof err,
      errorMessage: err?.errorMessage ?? err?.message ?? String(err),
      code: err?.code,
    });
  }
}
