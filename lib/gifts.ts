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

export interface ListingInfo {
  /** Shu aniq nusxaning barqaror identifikatori (slug) - qayta xabar bermaslik uchun */
  slug: string;
  /** Telegram'ning t.me/nft/<slug> formatidagi to'g'ridan-to'g'ri havolasi (native karta ochadi) */
  link: string;
  /** Nusxa raqami, masalan #40669 */
  num: number;
  /** Shu aniq nusxaning sotuv narxi (yulduz) */
  priceStars: number;
  model?: string;
  symbol?: string;
  backdrop?: string;
}

function parseUniqueListing(g: Api.TypeStarGift): ListingInfo | null {
  if (g.className !== "StarGiftUnique") return null;

  const priceEntry = (g.resellAmount ?? []).find((a: any) => a.className === "StarsAmount") as any;
  if (!priceEntry) return null;

  const attrs = (g.attributes ?? []) as any[];
  const model = attrs.find((a) => a.className === "StarGiftAttributeModel");
  const symbol = attrs.find((a) => a.className === "StarGiftAttributePattern");
  const backdrop = attrs.find((a) => a.className === "StarGiftAttributeBackdrop");

  return {
    slug: g.slug,
    link: `https://t.me/nft/${g.slug}`,
    num: Number(g.num),
    priceStars: Number(priceEntry.amount),
    model: model?.name,
    symbol: symbol?.name,
    backdrop: backdrop?.name,
  };
}

/**
 * Bozordagi eng arzon (floor) taklifning havolasi va atributlarini oladi.
 * Topilmasa yoki xatolik bo'lsa null qaytaradi.
 */
export async function getCheapestListing(giftId: string): Promise<ListingInfo | null> {
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
    return first ? parseUniqueListing(first) : null;
  } catch (err) {
    console.error(`getCheapestListing(${giftId}) xatosi:`, err);
    return null;
  }
}

/**
 * [minStars, maxStars] oralig'idagi barcha bozor takliflarini (nusxalarini) oladi
 * (narx bo'yicha o'sish tartibida, maxStars'dan oshgach to'xtaydi). `fetchLimit` -
 * bir chaqiruvda so'raladigan maksimal nusxa soni (xavfsizlik uchun cheklov).
 */
export async function getListingsInRange(
  giftId: string,
  minStars: number,
  maxStars: number,
  fetchLimit = 50
): Promise<ListingInfo[]> {
  try {
    const client = await getClient();
    const result = await client.invoke(
      new Api.payments.GetResaleStarGifts({
        giftId: bigInt(giftId),
        sortByPrice: true,
        offset: "",
        limit: fetchLimit,
      } as any)
    );

    if (result.className !== "payments.ResaleStarGifts") return [];

    const listings: ListingInfo[] = [];
    for (const g of result.gifts) {
      const listing = parseUniqueListing(g);
      if (!listing) continue;
      if (listing.priceStars > maxStars) break; // narx bo'yicha o'sish tartibida - keyingilari ham oshiq bo'ladi
      if (listing.priceStars >= minStars) listings.push(listing);
    }
    return listings;
  } catch (err) {
    console.error(`getListingsInRange(${giftId}) xatosi:`, err);
    return [];
  }
}
