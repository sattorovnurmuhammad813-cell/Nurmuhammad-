import { Api, TelegramClient } from "teleproto";
import bigInt from "big-integer";
import { withTelegramLock } from "./telegramClient";

/**
 * Har bir funksiya ixtiyoriy `client` parametrini qabul qiladi. Agar
 * berilmasa (Vercel serverless muhitida bo'lgani kabi) - avvalgidek Redis
 * lock orqali vaqtinchalik ulanish ochib-yopiladi. Agar berilsa (doimiy
 * ishlaydigan worker/VPS muhitida) - o'sha bitta doimiy ulanish to'g'ridan-
 * to'g'ri ishlatiladi, hech qanday qo'shimcha ulanish ochilmaydi.
 */
async function invokeMTProto<T>(fn: (client: TelegramClient) => Promise<T>, client?: TelegramClient): Promise<T> {
  return client ? fn(client) : withTelegramLock(fn);
}

export interface CatalogGift {
  id: string;
  title: string;
  /** Sovg'ani birinchi marta sotib olish narxi (yulduz) */
  stars: number;
  /** Resale bozoridagi eng arzon (floor) narx, agar hozircha sotuvda yo'q bo'lsa null */
  resellMinStars: number | null;
  limited: boolean;
  soldOut: boolean;
  /**
   * Sovg'aning vizual (stiker) fayli - faqat MTProto orqali yuklab olish uchun,
   * Bot API bunday collectible gift'larni getAvailableGifts orqali bermaydi
   * (u faqat oddiy, kollektsion bo'lmagan sovg'alarni qaytaradi).
   */
  stickerDocument?: Api.TypeDocument;
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
export async function getGiftCatalog(force = false, client?: TelegramClient): Promise<CatalogGift[]> {
  if (!force && cache && Date.now() - cache.ts < CACHE_MS) {
    return cache.data;
  }

  const result = await invokeMTProto((c) => c.invoke(new Api.payments.GetStarGifts({ hash: 0 })), client);

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
      stickerDocument: g.sticker,
    }));

  cache = { data, ts: Date.now() };
  return data;
}

export interface GiftStickerFile {
  buffer: Buffer;
  ext: string;
  mimeType: string;
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "application/x-tgsticker") return "tgs";
  if (mimeType === "video/webm") return "webm";
  if (mimeType === "image/webp") return "webp";
  return "bin";
}

/**
 * Sovg'aning stiker faylini (rasm/animatsiya) MTProto orqali baytlarda yuklab oladi -
 * bu Bot API orqali to'g'ridan-to'g'ri (file_id bilan) ololmaydigan collectible
 * gift'lar uchun kerak. Natija keyin Bot API'ga multipart sifatida qayta yuklanadi.
 * `client` doim berilishi kerak (faqat doimiy ulanishga ega worker muhitida ishlatiladi).
 */
export async function downloadGiftSticker(giftId: string, client: TelegramClient): Promise<GiftStickerFile | null> {
  const catalog = await getGiftCatalog(false, client);
  const gift = catalog.find((g) => g.id === giftId);
  const doc = gift?.stickerDocument;
  if (!doc || doc.className !== "Document") return null;

  try {
    // teleproto'ning .d.ts fayli xato yozilgan - u faqat Message yoki MessageMedia
    // qabul qiladi deb ko'rsatadi, lekin amalda (downloads.js) xom Document
    // obyektini ham to'g'ridan-to'g'ri qabul qiladi (Message'ga o'rashsiz).
    const buffer = (await client.downloadMedia(doc as unknown as Parameters<typeof client.downloadMedia>[0], {})) as Buffer;
    if (!buffer || buffer.length === 0) return null;
    return { buffer, mimeType: doc.mimeType, ext: extensionForMimeType(doc.mimeType) };
  } catch (err) {
    console.error(`downloadGiftSticker(${giftId}) xatosi:`, err);
    return null;
  }
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
export async function getCheapestListing(giftId: string, client?: TelegramClient): Promise<ListingInfo | null> {
  try {
    const result = await invokeMTProto(
      (c) =>
        c.invoke(
          new Api.payments.GetResaleStarGifts({
            giftId: bigInt(giftId),
            sortByPrice: true,
            offset: "",
            limit: 1,
          } as any)
        ),
      client
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
  /** Berilsa, faqat shu Model nomiga (katta-kichik harflarga sezgir emas) ega nusxalar qaytariladi */
  model?: string,
  /** Berilsa, faqat shu Backdrop nomiga (katta-kichik harflarga sezgir emas) ega nusxalar qaytariladi */
  backdrop?: string,
  fetchLimit = 100,
  client?: TelegramClient
): Promise<ListingInfo[]> {
  try {
    const result = await invokeMTProto(
      (c) =>
        c.invoke(
          new Api.payments.GetResaleStarGifts({
            giftId: bigInt(giftId),
            sortByPrice: true,
            offset: "",
            limit: fetchLimit,
          } as any)
        ),
      client
    );

    if (result.className !== "payments.ResaleStarGifts") return [];

    const modelLower = model?.toLowerCase();
    const backdropLower = backdrop?.toLowerCase();
    const listings: ListingInfo[] = [];
    for (const g of result.gifts) {
      const listing = parseUniqueListing(g);
      if (!listing) continue;
      if (listing.priceStars > maxStars) break; // narx bo'yicha o'sish tartibida - keyingilari ham oshiq bo'ladi
      if (modelLower && listing.model?.toLowerCase() !== modelLower) continue;
      if (backdropLower && listing.backdrop?.toLowerCase() !== backdropLower) continue;
      if (listing.priceStars >= minStars) listings.push(listing);
    }
    return listings;
  } catch (err) {
    console.error(`getListingsInRange(${giftId}) xatosi:`, err);
    return [];
  }
}

export interface GiftAttributeOption {
  name: string;
  /** Shu attributga ega hozirgi bozor takliflari soni */
  count: number;
  /** StarGiftAttributeIdModel uchun document id */
  documentId?: string;
  /** StarGiftAttributeIdBackdrop uchun backdrop id */
  backdropId?: number;
}

let attrCache: Map<string, { models: GiftAttributeOption[]; backdrops: GiftAttributeOption[]; ts: number }> =
  new Map();
// Model/backdrop TO'PLAMI (qaysi variantlar umuman mavjud) narxlardan farqli o'laroq
// tez-tez o'zgarmaydi - shuning uchun ancha uzoqroq keshlanadi. Bu /giftlar
// menyusida bir necha bosqichli tanlov (Model -> Backdrop -> narx) davomida
// indekslar (ro'yxatdagi tartib raqami) o'zgarib ketmasligi uchun ham muhim.
const ATTR_CACHE_MS = 5 * 60_000;

/**
 * Shu gift uchun bozorda mavjud barcha Model va Backdrop variantlarini (nomi va
 * shu variantga ega hozirgi takliflar soni bilan) oladi - /giftlar menyusidagi
 * "Model" va "Backdrop" tanlov ro'yxatlari uchun.
 */
export async function getGiftAttributeOptions(
  giftId: string,
  client?: TelegramClient
): Promise<{ models: GiftAttributeOption[]; backdrops: GiftAttributeOption[] }> {
  const cached = attrCache.get(giftId);
  if (cached && Date.now() - cached.ts < ATTR_CACHE_MS) {
    return cached;
  }

  try {
    const result = await invokeMTProto(
      (c) =>
        c.invoke(
          new Api.payments.GetResaleStarGifts({
            giftId: bigInt(giftId),
            sortByPrice: true,
            offset: "",
            limit: 1,
          } as any)
        ),
      client
    );

    if (result.className !== "payments.ResaleStarGifts") {
      return cached ?? { models: [], backdrops: [] };
    }

    const attrs = (result.attributes ?? []) as any[];
    const counters = (result.counters ?? []) as any[];

    const modelCounts = new Map<string, number>();
    const backdropCounts = new Map<number, number>();
    for (const c of counters) {
      const a = c.attribute;
      if (a?.className === "StarGiftAttributeIdModel") modelCounts.set(String(a.documentId), Number(c.count));
      else if (a?.className === "StarGiftAttributeIdBackdrop")
        backdropCounts.set(Number(a.backdropId), Number(c.count));
    }

    const models: GiftAttributeOption[] = [];
    const backdrops: GiftAttributeOption[] = [];
    for (const a of attrs) {
      if (a.className === "StarGiftAttributeModel") {
        const documentId = String(a.document?.id ?? "");
        models.push({ name: a.name, count: modelCounts.get(documentId) ?? 0, documentId });
      } else if (a.className === "StarGiftAttributeBackdrop") {
        const backdropId = Number(a.backdropId);
        backdrops.push({ name: a.name, count: backdropCounts.get(backdropId) ?? 0, backdropId });
      }
    }
    // Alifbo bo'yicha (son bo'yicha emas) tartiblanadi - ro'yxatdagi indekslar
    // /giftlar'ning bosqichma-bosqich tanlovida barqaror qolishi kerak, bu esa
    // sonlarga emas, faqat nomlarga bog'liq bo'lganda kafolatlanadi (sonlar har
    // safar so'rov yangilanganda o'zgarib turadi, nomlar to'plami deyarli o'zgarmas).
    models.sort((x, y) => x.name.localeCompare(y.name));
    backdrops.sort((x, y) => x.name.localeCompare(y.name));

    const data = { models, backdrops, ts: Date.now() };
    attrCache.set(giftId, data);
    return data;
  } catch (err) {
    console.error(`getGiftAttributeOptions(${giftId}) xatosi:`, err);
    return cached ?? { models: [], backdrops: [] };
  }
}
