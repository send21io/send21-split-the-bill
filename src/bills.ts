import { randomInt } from "node:crypto";
import { checkAddress, coinById, coinFor, fiatDecimals, formatFiat, isFiat, parseTotal, toMinor } from "./currencies.js";
import { cleanText, isEmoji } from "./sanitize.js";
import type { Send21Client } from "./send21.js";
import { splitAmount } from "./split.js";
import type { Store, StoreData } from "./store.js";
import type { Bill, PayOption, Share, ShareStatus } from "./types.js";

export const LIMITS = { maxPeople: 20, maxCoins: 8, maxTotal: 10_000 } as const;
const AVATARS = ["🦊", "🐸", "🐼", "🦄", "🐙", "🐯", "🐨", "🐵", "🦁", "🐧", "🐲", "🐳", "🦉", "🐝", "🦋", "🐢", "🦖", "🐰", "🐮", "🐷"];

/** 20 characters of [a-z0-9] (~103 bits): the bill id is also the board's secret link. */
export function newBillId(): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 20 }, () => abc[randomInt(abc.length)]).join("");
}

export const orderIdFor = (billId: string, n: number) => `split-${billId}-${n}`;
const ORDER_ID = /^split-([a-z0-9]{20})-(\d{1,2})$/;

export interface NewBillInput {
  title?: unknown;
  emoji?: unknown;
  total?: unknown;
  currency?: unknown;
  includeMe?: unknown;
  people?: unknown;
  coins?: unknown;
}

export type Checked = { ok: true; bill: Bill } | { ok: false; error: string };

/** Validate the form and build the bill with its shares. Pure: nothing is stored or sent. */
export function buildBill(input: NewBillInput, id = newBillId(), now = new Date().toISOString()): Checked {
  const currency = String(input.currency ?? "").toUpperCase();
  if (!isFiat(currency)) return { ok: false, error: "💱 pick a currency" };
  const total = parseTotal(input.total, currency, LIMITS.maxTotal);
  if (!total.ok) return total;

  if (!Array.isArray(input.people) || input.people.length < 1) return { ok: false, error: "👥 add at least one friend" };
  if (input.people.length > LIMITS.maxPeople) return { ok: false, error: `👥 max ${LIMITS.maxPeople} friends` };
  const friends: { name: string; emoji: string }[] = [];
  for (const [i, p] of (input.people as unknown[]).entries()) {
    const raw = (p ?? {}) as { name?: unknown; emoji?: unknown };
    const hasName = typeof raw.name === "string" && raw.name.trim() !== "";
    const name = hasName ? cleanText(raw.name, 24) : "";
    if (name === null) return { ok: false, error: `✏️ friend ${i + 1}: plain name, max 24 characters` };
    friends.push({ name, emoji: isEmoji(raw.emoji) ? raw.emoji : AVATARS[i % AVATARS.length]! });
  }

  if (!Array.isArray(input.coins) || input.coins.length < 1) return { ok: false, error: "🪙 add at least one coin + your address" };
  if (input.coins.length > LIMITS.maxCoins) return { ok: false, error: `🪙 max ${LIMITS.maxCoins} coins` };
  const options: PayOption[] = [];
  for (const c of input.coins as unknown[]) {
    const raw = (c ?? {}) as { coin?: unknown; address?: unknown };
    const coin = coinById(String(raw.coin ?? ""));
    if (!coin) return { ok: false, error: "🪙 unknown coin" };
    if (options.some((o) => coinFor(o.currency, o.network, o.method) === coin)) return { ok: false, error: `🪙 ${coin.label} twice` };
    const address = checkAddress(coin, String(raw.address ?? ""));
    if (!address.ok) return address;
    options.push({ currency: coin.currency, network: coin.network, address: address.address, ...(coin.method ? { method: coin.method } : {}) });
  }

  const includeMe = input.includeMe !== false;
  const people = [...(includeMe ? [{ name: "me", emoji: "🙋" }] : []), ...friends];
  // Fair split in minor units; the remainder goes to the first person or persons (you, when you're in).
  const amounts = splitAmount(total.amount, currency, people.length);
  const min = fiatDecimals(currency) === 0 ? 50 : 0.5;
  if (amounts.some((a) => a < min)) return { ok: false, error: `🔢 each share must be at least ${min} ${currency}` };

  const title = typeof input.title === "string" && input.title.trim() ? cleanText(input.title, 32) : "Bill";
  if (title === null) return { ok: false, error: "✏️ title: plain text, max 32 characters" };

  const shares: Share[] = people.map((p, i) => {
    const n = includeMe ? i : i + 1;
    const me = includeMe && i === 0;
    return {
      n,
      name: p.name,
      emoji: p.emoji,
      amount: amounts[i]!,
      orderId: me ? null : orderIdFor(id, n),
      paymentRequestId: null,
      payUrl: null,
      expiresAt: null,
      status: me ? "me" : "creating",
    };
  });
  return {
    ok: true,
    bill: { id, title, emoji: isEmoji(input.emoji) ? input.emoji : "🧾", currency, total: total.amount, options, shares, createdAt: now, updatedAt: now },
  };
}

export interface LinkConfig {
  expiryHours: number;
  shortfallPercent: number;
}

const inFlight = new Set<string>();

/**
 * Create the missing pay links, one per friend, one after the other. Safe to
 * call again after a failure: each call uses the share's orderId as the
 * Idempotency-Key, so a retry returns the same pay link instead of a second one.
 */
export async function createLinks(store: Store, send21: Send21Client, cfg: LinkConfig, billId: string): Promise<Bill> {
  if (inFlight.has(billId)) return store.getBill(billId)!;
  inFlight.add(billId);
  try {
    for (;;) {
      const bill = store.getBill(billId);
      if (!bill) throw new Error("unknown bill");
      const share = bill.shares.find((s) => s.status === "creating");
      if (!share || !share.orderId) return bill;
      const people = bill.shares.length;
      const pr = await send21.createPaymentRequest(
        {
          fiatCurrency: bill.currency,
          fiatAmount: share.amount,
          orderId: share.orderId,
          // Shown on the pay page: the bill and the friend's own share only.
          memo: `${bill.emoji} ${bill.title} · ${share.emoji}${share.name ? ` ${share.name}` : ""} · ${formatFiat(share.amount, bill.currency)} (1/${people} of ${formatFiat(bill.total, bill.currency)})`.slice(0, 140),
          options: bill.options,
          expiryHours: cfg.expiryHours,
          declineNote: "Nothing happens. Your friend just keeps waiting for their money.",
          ...(cfg.shortfallPercent > 0 ? { shortfallPolicy: { absorbUpToPercent: cfg.shortfallPercent, absorbedBy: "receiver" as const } } : {}),
        },
        share.orderId,
      );
      const now = new Date().toISOString();
      const next: Bill = {
        ...bill,
        updatedAt: now,
        shares: bill.shares.map((s) =>
          s.n === share.n ? { ...s, paymentRequestId: pr.id, payUrl: send21.payUrl(pr.payPath), expiresAt: pr.expiresAt, status: s.status === "creating" ? "waiting" : s.status } : s,
        ),
      };
      store.putBill(next);
    }
  } finally {
    inFlight.delete(billId);
  }
}

// ---------- webhooks ----------

/** Fields of a draft webhook payload that the app reads. See docs/webhooks "Payload". */
export interface DraftEventData {
  draftId?: string;
  status?: string;
  txId?: string;
  sentCurrency?: string;
  network?: string;
  amountSats?: number;
  sentAmount?: string;
  receivedAmountSats?: number;
  receivedAmount?: string;
  fiatCurrency?: string;
  fiatAmount?: number;
  paymentRequestId?: string;
  orderId?: string;
  reviewState?: string;
  occurredAt?: string;
}

const eq = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const isPosInt = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/**
 * Compare a draft.confirmed payload with that person's share.
 * @returns problems; empty when the payment is exactly this share
 */
export function checkPaymentAgainstShare(data: DraftEventData, share: Share, bill: Bill): string[] {
  const problems: string[] = [];
  if (!share.orderId || data.orderId !== share.orderId) problems.push(`orderId ${data.orderId} != ${share.orderId}`);
  if (!share.paymentRequestId || data.paymentRequestId !== share.paymentRequestId) problems.push(`pay link ${data.paymentRequestId} != ${share.paymentRequestId}`);
  if (data.status !== "Confirmed") problems.push(`status ${data.status} != Confirmed`);
  if (!data.txId) problems.push("no txId");
  if (!eq(data.fiatCurrency, bill.currency)) problems.push(`fiat ${data.fiatCurrency} != ${bill.currency}`);
  if (typeof data.fiatAmount !== "number" || toMinor(data.fiatAmount, bill.currency) !== toMinor(share.amount, bill.currency)) {
    problems.push(`amount ${data.fiatAmount} != ${share.amount}`);
  }
  if (!isPosInt(data.amountSats)) problems.push("no amountSats");
  if (data.receivedAmountSats !== undefined && !isPosInt(data.receivedAmountSats)) problems.push("bad receivedAmountSats");
  // sentCurrency is upper case in payloads ("USDC"), options use API enums ("Usdc").
  if (!bill.options.some((o) => eq(o.currency, data.sentCurrency) && eq(o.network, data.network))) {
    problems.push(`asset ${data.sentCurrency} on ${data.network} was not offered on this bill`);
  }
  return problems;
}

export type Outcome = "test" | "ignored" | "unknown_share" | "unchanged" | "already_paid" | ShareStatus;
export interface Applied {
  outcome: Outcome;
  /** Set when the bill changed and live boards should refresh. */
  bill?: Bill;
}

function locate(d: StoreData, data: DraftEventData): { bill: Bill; share: Share } | null {
  const m = typeof data.orderId === "string" ? ORDER_ID.exec(data.orderId) : null;
  if (data.orderId && !m) return null; // someone else's order (another integration on the same account)
  if (m) {
    const bill = d.bills[m[1]!];
    const share = bill?.shares.find((s) => s.n === Number(m[2]) && s.orderId === data.orderId);
    return bill && share ? { bill, share } : null;
  }
  if (!data.paymentRequestId) return null;
  for (const bill of Object.values(d.bills)) {
    const share = bill.shares.find((s) => s.paymentRequestId === data.paymentRequestId);
    if (share) return { bill, share };
  }
  return null;
}

/** Apply one verified, de-duplicated event. Call inside store.transaction() with Store.remember(). */
export function applyEvent(d: StoreData, body: { event?: unknown; data?: unknown }, nowIso = new Date().toISOString()): Applied {
  const event = typeof body.event === "string" ? body.event : "";
  if (event === "test") return { outcome: "test" };
  const data = (body.data && typeof body.data === "object" ? body.data : {}) as DraftEventData;
  const found = locate(d, data);
  if (!found) return { outcome: "unknown_share" };
  const { bill, share } = found;
  if (data.paymentRequestId && data.paymentRequestId !== share.paymentRequestId) return { outcome: "unknown_share" };

  const set = (status: ShareStatus, extra: Partial<Share> = {}): Applied => {
    const next: Bill = { ...bill, updatedAt: nowIso, shares: bill.shares.map((s) => (s.n === share.n ? { ...s, ...extra, status } : s)) };
    d.bills[bill.id] = next;
    return { outcome: status, bill: next };
  };
  const is = (...s: ShareStatus[]) => s.includes(share.status);
  const same: Applied = { outcome: "unchanged" };

  switch (event) {
    case "draft.confirmed": {
      if (share.status === "paid") return { outcome: "already_paid" };
      const problems = checkPaymentAgainstShare(data, share, bill);
      if (problems.length) return set("flagged", { problems });
      return set("paid", {
        problems: undefined,
        paid: {
          currency: String(data.sentCurrency),
          network: String(data.network),
          amount: data.receivedAmount ?? data.sentAmount ?? null,
          txId: String(data.txId),
          differentAmount: data.receivedAmountSats !== undefined && data.receivedAmountSats !== data.amountSats,
          at: data.occurredAt ?? nowIso,
        },
      });
    }
    case "draft.seen":
      return is("waiting", "expired") ? set("seen") : same;
    case "draft.amount_mismatch":
      return is("waiting", "seen", "expired") ? set("review") : same;
    case "draft.mismatch_accepted":
      return is("paid", "declined") ? same : set("accepted");
    case "draft.mismatch_rejected":
      return is("paid") ? same : set("declined");
    case "draft.mismatch_unresolved":
      return is("waiting", "seen", "review", "expired") ? set("unresolved") : same;
    case "draft.expired":
      if (data.reviewState === "unresolved") return is("waiting", "seen", "review", "expired") ? set("unresolved") : same;
      return is("waiting", "seen") ? set("expired") : same;
    case "payment_request.expired":
      return is("waiting", "seen") ? set("expired") : same;
    // draft.created, draft.cancelled, draft.mismatch_reminder: nothing to show.
    default:
      return { outcome: "ignored" };
  }
}

/** What the browser gets: no receiving addresses beyond what the pay page shows anyway, no internals. */
export function publicBill(bill: Bill) {
  return {
    id: bill.id,
    title: bill.title,
    emoji: bill.emoji,
    currency: bill.currency,
    total: bill.total,
    coins: bill.options.map((o) => coinFor(o.currency, o.network, o.method)?.id ?? null).filter(Boolean),
    shares: bill.shares.map((s) => ({
      n: s.n,
      name: s.name,
      emoji: s.emoji,
      amount: s.amount,
      status: s.status,
      payUrl: s.payUrl,
      expiresAt: s.expiresAt,
      paid: s.paid ? { currency: s.paid.currency, network: s.paid.network, amount: s.paid.amount, differentAmount: s.paid.differentAmount } : null,
    })),
    createdAt: bill.createdAt,
    updatedAt: bill.updatedAt,
  };
}
