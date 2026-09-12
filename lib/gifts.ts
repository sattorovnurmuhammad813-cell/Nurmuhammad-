import { Api, TelegramClient } from "teleproto";
import bigInt from "big-integer";
import { withTelegramLock } from "./telegramClient";
import { alertRiskSignal } from "./alerts";

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

/**
 * `payments.GetResaleStarGifts` (narx tekshiruvi HAM /giftlar'dagi Model/Backdrop
 * ro'yxati HAM shu metoddan foydalanadi) uchun umumiy tezlik cheklovi. Ko'p sonli
 * kuzatuv har biri o'z gift_id'i bilan har poll siklida alohida chaqirilsa,
 * Telegram tez orada FLOOD_WAIT bilan bloklaydi - va bu blok BUTUN hisobga,
 * demak /giftlar tugmalariga ham tegadi (kuzatilgan holat: soatlab deyarli
 * uzluksiz ~24s flood-wait uyqusi, shu sabab tugmalar javob berolmay qolgan).
 * Shu yerda BARCHA chaqiruvchilar (poll.ts va getGiftAttributeOptions) ketma-ket
 * navbatga qo'yiladi va ular orasida kamida RESALE_MIN_GAP_MS oraliq saqlanadi -
 * shunda flood-wait umuman kelib chiqmaydi.
 */
const RESALE_MIN_GAP_MS = Number(process.env.RESALE_MIN_GAP_MS || 1500);
let resaleLastCallAt = 0;
let resaleQueue: Promise<void> = Promise.resolve();

function throttleResaleCall<T>(fn: () => Promise<T>): Promise<T> {
  const turn = resaleQueue.then(async () => {
    const wait = resaleLastCallAt + RESALE_MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    resaleLastCallAt = Date.now();
  });
  resaleQueue = turn.catch(() => {});
  return turn.then(fn);
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
// Kesh eskirganda ham darhol (stale) natijani qaytarib, yangilanishni FONDA
// boshlaymiz - shu bilan /giftlar va Menu buyruqlari hech qachon jonli MTProto
// so'rovini kutib turmaydi (bu narx tekshiruv siklining band ulanishidan
// kutilmagan sekinlik keltirib chiqarardi).
let refreshPromise: Promise<CatalogGift[]> | null = null;

async function fetchCatalog(client?: TelegramClient): Promise<CatalogGift[]> {
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

/**
 * Telegram'ning barcha kolleksion (limited) sovg'alar katalogini oladi.
 * `resellMinStars` maydoni aynan bozordagi "floor" (eng arzon) narx bo'lib,
 * har bir sovg'a uchun alohida so'rov yubormasdan bitta chaqiruvda barchasini beradi.
 */
export async function getGiftCatalog(force = false, client?: TelegramClient): Promise<CatalogGift[]> {
  if (force) {
    return fetchCatalog(client);
  }

  if (cache) {
    if (Date.now() - cache.ts >= CACHE_MS && !refreshPromise) {
      refreshPromise = fetchCatalog(client)
        .catch((err) => {
          console.error("getGiftCatalog fon yangilanishi xatosi:", err);
          return cache!.data;
        })
        .finally(() => {
          refreshPromise = null;
        });
    }
    return cache.data;
  }

  // Sovuq boshlanish - keshda hech narsa yo'q, majburan kutamiz
  return fetchCatalog(client);
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
  // `resellAmount` yulduz narxini o'z ichiga olsa ham, `resaleTonOnly: true`
  // bo'lsa bu faqat KO'RSATISH uchun hisoblangan ekvivalent - nusxani haqiqatda
  // faqat TON orqali sotib olish mumkin, yulduzda emas. Shunday e'lonlarni
  // butunlay chiqarib tashlaymiz (na kuzatuvga, na xabarga tushmasin).
  if (g.resaleTonOnly) return null;

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
    const result = await throttleResaleCall(() =>
      invokeMTProto(
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
      )
    );

    if (result.className !== "payments.ResaleStarGifts") return null;
    const first = result.gifts[0];
    return first ? parseUniqueListing(first) : null;
  } catch (err) {
    console.error(`getCheapestListing(${giftId}) xatosi:`, err);
    alertRiskSignal(err, `getCheapestListing(${giftId})`).catch(() => {});
    return null;
  }
}

/**
 * Shu gift uchun bozordagi barcha takliflarni (narx bo'yicha o'sish tartibida,
 * TON-only e'lonlarsiz) xom holda oladi - hech qanday min/max/Model/Backdrop
 * filtrisiz. Bir nechta kuzatuv (turli chat/Model/Backdrop) bitta giftId'ga
 * ishora qilsa, shu funksiya orqali BITTA MTProto so'rovi barchasiga
 * yetadi - `filterListings` bilan har biriga alohida qo'llaniladi.
 */
export async function fetchResaleListings(
  giftId: string,
  fetchLimit = 100,
  client?: TelegramClient
): Promise<ListingInfo[]> {
  const result = await throttleResaleCall(() =>
    invokeMTProto(
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
    )
  );

  if (result.className !== "payments.ResaleStarGifts") return [];

  const listings: ListingInfo[] = [];
  for (const g of result.gifts) {
    const listing = parseUniqueListing(g);
    if (listing) listings.push(listing);
  }
  return listings;
}

/** `fetchResaleListings` natijasidan [minStars, maxStars] va ixtiyoriy Model/Backdrop bo'yicha filtrlaydi */
export function filterListings(
  listings: ListingInfo[],
  minStars: number,
  maxStars: number,
  model?: string,
  backdrop?: string
): ListingInfo[] {
  const modelLower = model?.toLowerCase();
  const backdropLower = backdrop?.toLowerCase();
  const result: ListingInfo[] = [];
  for (const listing of listings) {
    if (listing.priceStars > maxStars) break; // kirish ro'yxati narx bo'yicha o'sish tartibida
    if (modelLower && listing.model?.toLowerCase() !== modelLower) continue;
    if (backdropLower && listing.backdrop?.toLowerCase() !== backdropLower) continue;
    if (listing.priceStars >= minStars) result.push(listing);
  }
  return result;
}

/**
 * [minStars, maxStars] oralig'idagi barcha bozor takliflarini (nusxalarini) oladi
 * (narx bo'yicha o'sish tartibida, maxStars'dan oshgach to'xtaydi). `fetchLimit` -
 * bir chaqiruvda so'raladigan maksimal nusxa soni (xavfsizlik uchun cheklov).
 * Faqat BITTA kuzatuvni tekshirish uchun qulay qisqa yo'l - bir nechtasi uchun
 * `fetchResaleListings` + `filterListings`dan foydalaning (bitta MTProto so'rovi kifoya).
 */
export async function getListingsInRange(
  giftId: string,
  minStars: number,
  maxStars: number,
  model?: string,
  backdrop?: string,
  fetchLimit = 100,
  client?: TelegramClient
): Promise<ListingInfo[]> {
  try {
    const listings = await fetchResaleListings(giftId, fetchLimit, client);
    return filterListings(listings, minStars, maxStars, model, backdrop);
  } catch (err) {
    console.error(`getListingsInRange(${giftId}) xatosi:`, err);
    alertRiskSignal(err, `getListingsInRange(${giftId})`).catch(() => {});
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

interface AttrCacheEntry {
  models: GiftAttributeOption[];
  backdrops: GiftAttributeOption[];
  ts: number;
}

let attrCache: Map<string, AttrCacheEntry> = new Map();
// Model/backdrop TO'PLAMI (qaysi variantlar umuman mavjud) narxlardan farqli o'laroq
// tez-tez o'zgarmaydi - shuning uchun ancha uzoqroq keshlanadi. Bu /giftlar
// menyusida bir necha bosqichli tanlov (Model -> Backdrop -> narx) davomida
// indekslar (ro'yxatdagi tartib raqami) o'zgarib ketmasligi uchun ham muhim.
const ATTR_CACHE_MS = 5 * 60_000;
// giftId bo'yicha fon-yangilanish davom etayotganini belgilaydi - bir vaqtda
// bir xil gift uchun bir nechta MTProto so'rovi qatorlashib ketmasligi uchun.
const attrRefreshing = new Set<string>();

async function fetchGiftAttributeOptions(giftId: string, client?: TelegramClient): Promise<AttrCacheEntry> {
  const cached = attrCache.get(giftId);
  try {
    const result = await throttleResaleCall(() =>
      invokeMTProto(
        (c) =>
          c.invoke(
            new Api.payments.GetResaleStarGifts({
              giftId: bigInt(giftId),
              sortByPrice: true,
              offset: "",
              limit: 1,
              // Telegram bu maydon berilmasa (undefined) "attributes" ro'yxatini
              // umuman qaytarmaydi (faqat "counters"ni beradi) - shu bilan birga
              // aniq 0 (yoki har qanday eski hash) berilsa, to'liq ro'yxatni beradi.
              attributesHash: bigInt(0),
            } as any)
          ),
        client
      )
    );

    if (result.className !== "payments.ResaleStarGifts") {
      return cached ?? { models: [], backdrops: [], ts: Date.now() };
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
    alertRiskSignal(err, `getGiftAttributeOptions(${giftId})`).catch(() => {});
    return cached ?? { models: [], backdrops: [], ts: Date.now() };
  }
}

/**
 * Shu gift uchun bozorda mavjud barcha Model va Backdrop variantlarini (nomi va
 * shu variantga ega hozirgi takliflar soni bilan) oladi - /giftlar menyusidagi
 * "Model" va "Backdrop" tanlov ro'yxatlari uchun. Kesh eskirgan bo'lsa ham,
 * mavjud bo'lsa darhol shu eski qiymatni qaytaradi va yangilanishni fonda
 * boshlaydi - foydalanuvchi tugma bosganda MTProto javobini kutib turmaydi.
 */
export async function getGiftAttributeOptions(
  giftId: string,
  client?: TelegramClient
): Promise<{ models: GiftAttributeOption[]; backdrops: GiftAttributeOption[] }> {
  const cached = attrCache.get(giftId);

  if (cached) {
    if (Date.now() - cached.ts >= ATTR_CACHE_MS && !attrRefreshing.has(giftId)) {
      attrRefreshing.add(giftId);
      fetchGiftAttributeOptions(giftId, client).finally(() => attrRefreshing.delete(giftId));
    }
    return cached;
  }

  // Sovuq boshlanish - keshda hech narsa yo'q, majburan kutamiz
  return fetchGiftAttributeOptions(giftId, client);
}
