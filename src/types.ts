import type { Send21Currency, Send21Network } from "./currencies.js";

/** One receiving option on a pay link, exactly as POST /payment-requests takes it. */
export interface PayOption {
  currency: Send21Currency;
  network: Send21Network;
  address: string;
  method?: "Lightning";
}

export type ShareStatus =
  | "me" // 🙋 the payer's own part: no pay link
  | "creating" // ⚙️ pay link not created yet (or creation failed, retry)
  | "waiting" // 🟡 pay link open
  | "seen" // 👀 a payment is on its way
  | "review" // ⚠️ a different amount arrived; the account owner decides on send21
  | "accepted" // 👍 different amount accepted, waiting for confirmation
  | "paid" // ✅ confirmed and checked against this share
  | "declined" // ↩️ different amount declined, refund is manual
  | "unresolved" // ⚠️ expired while a different amount was undecided
  | "expired" // ⌛ nobody paid
  | "flagged"; // 🚩 a confirmed payment did NOT match this share (not marked paid)

export interface Share {
  /** 0 is the payer's own part (when included); friends are 1..n. */
  n: number;
  name: string;
  emoji: string;
  amount: number;
  orderId: string | null;
  paymentRequestId: string | null;
  payUrl: string | null;
  expiresAt: string | null;
  status: ShareStatus;
  paid?: { currency: string; network: string; amount: string | null; txId: string; differentAmount: boolean; at: string };
  problems?: string[];
}

export interface Bill {
  id: string;
  title: string;
  emoji: string;
  currency: string;
  total: number;
  options: PayOption[];
  shares: Share[];
  createdAt: string;
  updatedAt: string;
}
