import { Api, TelegramClient } from "teleproto";
import { Redis } from "@upstash/redis";
import { withTelegramLock } from "./telegramClient";

const redis = Redis.fromEnv();

async function invokeMTProto<T>(fn: (client: TelegramClient) => Promise<T>, client?: TelegramClient): Promise<T> {
  return client ? fn(client) : withTelegramLock(fn);
}

// --- Kunlik xarid limiti (butun akkaunt bo'yicha, hamma bot/chat uchun umumiy -
// chunki xarid bitta MTProto akkauntning yulduzlari bilan qilinadi) ---
const DAILY_LIMIT = 1;
const DAILY_KEY = "gifts:autobuy:daily_count";
const DAILY_TTL_SEC = 24 * 60 * 60;

/** Kunlik limitni ISHLATMASDAN tekshiradi (dry-run va oldindan tekshiruv uchun) */
export async function peekDailyLimitAvailable(): Promise<boolean> {
  const count = Number((await redis.get<number | string>(DAILY_KEY)) ?? 0);
  return count < DAILY_LIMIT;
}

/** Kunlik limitdan bitta joy band qiladi (atomik INCR orqali) - muvaffaqiyatsiz bo'lsa false */
async function claimDailySlot(): Promise<boolean> {
  const count = await redis.incr(DAILY_KEY);
  if (count === 1) await redis.expire(DAILY_KEY, DAILY_TTL_SEC);
  if (count > DAILY_LIMIT) {
    await redis.decr(DAILY_KEY);
    return false;
  }
  return true;
}

/** Xarid muvaffaqiyatsiz bo'lsa, band qilingan joyni qaytarib beradi */
async function releaseDailySlot(): Promise<void> {
  const count = await redis.decr(DAILY_KEY);
  if (count < 0) await redis.set(DAILY_KEY, 0, { keepTtl: true });
}

/** Joriy Telegram Stars balansini oladi (payments.GetStarsStatus, o'z akkaunti uchun) */
export async function getStarsBalance(client?: TelegramClient): Promise<number> {
  const result: any = await invokeMTProto(
    (c) =>
      c.invoke(
        new (Api.payments as any).GetStarsStatus({
          peer: new Api.InputPeerSelf(),
        })
      ),
    client
  );
  return Number(result?.balance?.amount ?? 0);
}

export interface ResaleForm {
  /** teleproto'ning xom (bigInt) formId qiymati - SendStarsForm'ga o'zgarishsiz qaytariladi */
  formId: unknown;
  priceStars: number;
  currency: string;
}

function buildResaleInvoice(slug: string) {
  return new (Api as any).InputInvoiceStarGiftResale({
    slug,
    toId: new Api.InputPeerSelf(),
  });
}

/**
 * Bozordagi bitta nusxani (slug) sotib olish uchun to'lov formasini oladi (hali
 * pul yechilmaydi - faqat narx va formId'ni tasdiqlaydi).
 */
export async function getResaleForm(slug: string, client?: TelegramClient): Promise<ResaleForm | null> {
  try {
    const invoice = buildResaleInvoice(slug);
    const result: any = await invokeMTProto(
      (c) => c.invoke(new (Api.payments as any).GetPaymentForm({ invoice })),
      client
    );

    if (result.className !== "payments.PaymentFormStarGift") return null;

    const inv = result.invoice;
    const priceStars = ((inv?.prices ?? []) as any[]).reduce((sum, p) => sum + Number(p.amount), 0);
    return { formId: result.formId, priceStars, currency: inv?.currency ?? "XTR" };
  } catch (err) {
    console.error(`getResaleForm(${slug}) xatosi:`, err);
    return null;
  }
}

export interface PurchaseOutcome {
  ok: boolean;
  error?: string;
}

/** HAQIQIY xaridni tasdiqlaydi (payments.SendStarsForm) - shu chaqiruv pul yechadi */
async function confirmResalePurchase(slug: string, formId: unknown, client?: TelegramClient): Promise<PurchaseOutcome> {
  try {
    const invoice = buildResaleInvoice(slug);
    const result: any = await invokeMTProto(
      (c) => c.invoke(new (Api.payments as any).SendStarsForm({ formId, invoice })),
      client
    );

    if (result.className === "payments.PaymentResult") {
      return { ok: true };
    }
    if (result.className === "payments.PaymentVerificationNeeded") {
      return { ok: false, error: `Qo'shimcha tasdiqlash talab qilinadi: ${result.url}` };
    }
    return { ok: false, error: `Kutilmagan javob: ${result.className}` };
  } catch (err: any) {
    console.error(`confirmResalePurchase(${slug}) xatosi:`, err);
    return { ok: false, error: err?.errorMessage ?? err?.message ?? String(err) };
  }
}

export type AutoBuySkipReason =
  | "disabled"
  | "price_exceeds_cap"
  | "daily_limit"
  | "insufficient_balance"
  | "form_error"
  | "form_price_exceeds_cap";

export interface AutoBuyResult {
  attempted: boolean;
  dryRun?: boolean;
  success?: boolean;
  priceStars?: number;
  balance?: number;
  reason?: AutoBuySkipReason;
  error?: string;
}

/**
 * Bitta topilgan e'lonni avtomatik sotib olishga harakat qiladi.
 *
 * Xavfsizlik qatlamlari (har biri mustaqil ravishda xaridni to'xtatishi mumkin):
 * 1. E'londagi narx kuzatuv `capStars` (foydalanuvchining max chegarasi)dan oshmasligi kerak
 * 2. Kunlik limit (odatda 1 ta/kun) hali ishlatilmagan bo'lishi kerak
 * 3. Joriy Stars balansi narxdan kam bo'lmasligi kerak
 * 4. Telegram'ning o'zi qaytargan HAQIQIY narx (forma orqali) ham `capStars`dan oshmasligi kerak
 *    (bozor narxi biz tekshirgandan keyin o'zgargan bo'lishi mumkin)
 * 5. `dryRun=true` bo'lsa - shu yergacha hammasi bajariladi, lekin HAQIQIY xarid
 *    (SendStarsForm) chaqirilmaydi va kunlik limit ISHLATILMAYDI.
 */
export async function tryAutoBuy(
  enabled: boolean,
  dryRun: boolean,
  slug: string,
  listedPriceStars: number,
  capStars: number,
  client?: TelegramClient
): Promise<AutoBuyResult> {
  if (!enabled) return { attempted: false, reason: "disabled" };

  if (listedPriceStars > capStars) {
    return { attempted: false, reason: "price_exceeds_cap", priceStars: listedPriceStars };
  }

  if (!(await peekDailyLimitAvailable())) {
    return { attempted: false, reason: "daily_limit" };
  }

  const balance = await getStarsBalance(client);
  if (balance < listedPriceStars) {
    return { attempted: false, reason: "insufficient_balance", balance, priceStars: listedPriceStars };
  }

  const form = await getResaleForm(slug, client);
  if (!form) {
    return { attempted: false, reason: "form_error" };
  }

  if (form.priceStars > capStars) {
    return { attempted: false, reason: "form_price_exceeds_cap", priceStars: form.priceStars };
  }

  if (dryRun) {
    console.log(
      `[purchase] DRY RUN: "${slug}" sotib olinar edi (${form.priceStars} ⭐, balans: ${balance} ⭐, cap: ${capStars} ⭐) - haqiqiy xarid QILINMADI.`
    );
    return { attempted: true, dryRun: true, success: true, priceStars: form.priceStars, balance };
  }

  const claimed = await claimDailySlot();
  if (!claimed) {
    return { attempted: false, reason: "daily_limit" };
  }

  const outcome = await confirmResalePurchase(slug, form.formId, client);
  if (!outcome.ok) {
    await releaseDailySlot();
    return { attempted: true, success: false, error: outcome.error, priceStars: form.priceStars };
  }

  console.log(`[purchase] SOTIB OLINDI: "${slug}" (${form.priceStars} ⭐).`);
  return { attempted: true, success: true, priceStars: form.priceStars, balance };
}
