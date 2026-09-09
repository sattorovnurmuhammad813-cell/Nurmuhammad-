import { Api } from "teleproto";
import bigInt from "big-integer";
import { getClient } from "./telegramClient";

export interface CatalogGift {
  id: string;
  title: string;
  /** Sovg'ani birinchi marta sotib olish narxi (yulduz) */
  stars: number;
  /** Resale bozoridagi eng arzon (floor) narx, agar hozircha sotuvda yo'q bo'lsa null */
  resellMinStars: number | null;
  limited: boolean;
  soldOut: boolean;
}

let cache: { data: CatalogGift[]; ts: number } | null = null;
// Bir necha so'rov (webhook + check-gifts) bir vaqtda kelib qolsa, MTProto'ga
// ortiqcha yuk tushmasligi uchun juda qisqa muddatli kesh.
const CACHE_MS = 15_000;

/**
 * Telegram'ning barcha kolleksion (limited) sovg'alar katalogini oladi.
 * `resellMinStars` maydoni aynan bozordagi "floor" (eng arzon) narx bo'lib,
 * har bir sovg'a uchun alohida so'rov yubormasdan bitta chaqiruvda barchasini beradi.
 */
export async function getGiftCatalog(force = false): Promise<CatalogGift[]> {
  if (!force && cache && Date.now() - cache.ts < CACHE_MS) {
    return cache.data;
  }

  const client = await getClient();
  const result = await client.invoke(new Api.payments.GetStarGifts({ hash: 0 }));

  if (result.className !== "payments.StarGifts") {
    // Nazariy jihatdan hash=0 bilan bu holat bo'lmasligi kerak, lekin ehtiyot chorasi
    return cache?.data ?? [];
  }

  const data: CatalogGift[] = result.gifts
    .filter((g): g is Api.StarGift => g.className === "StarGift")
    .map((g) => ({
      id: String(g.id),
      title: g.title ?? `Gift #${g.id}`,
      stars: Number(g.stars),
      resellMinStars: g.resellMinStars != null ? Number(g.resellMinStars) : null,
      limited: Boolean(g.limited),
      soldOut: Boolean(g.soldOut),
    }));

  cache = { data, ts: Date.now() };
  return data;
}

export async function getFloorPrice(giftId: string): Promise<number | null> {
  const catalog = await getGiftCatalog();
  const gift = catalog.find((g) => g.id === giftId);
  return gift?.resellMinStars ?? null;
}

/**
 * Bozordagi eng arzon (floor) taklifning "View Collectible" havolasini oladi
 * (Telegram'ning t.me/nft/<slug> formatidagi to'g'ridan-to'g'ri havolasi).
 * Topilmasa yoki xatolik bo'lsa null qaytaradi - bu holatda xabar link'siz yuboriladi.
 */
export async function getCheapestListingLink(giftId: string): Promise<string | null> {
  try {
    const client = await getClient();
    const result = await client.invoke(
      new Api.payments.GetResaleStarGifts({
        giftId: bigInt(giftId),
        sortByPrice: true,
        offset: "",
        limit: 1,
      } as any)
    );

    if (result.className !== "payments.ResaleStarGifts") return null;

    const first = result.gifts[0];
    if (!first || first.className !== "StarGiftUnique") return null;

    return `https://t.me/nft/${first.slug}`;
  } catch (err) {
    console.error(`getCheapestListingLink(${giftId}) xatosi:`, err);
    return null;
  }
}
