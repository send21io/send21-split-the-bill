import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { buildBill } from "../src/bills.js";
import type { Bill } from "../src/types.js";
import { signV2 } from "../src/verify.js";

export const SECRET = "whsec_test_only_not_a_real_secret";
export const BILL_ID = "abcdefghij0123456789";
export const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

export const form = (over: Record<string, unknown> = {}) => ({
  title: "Pizza night",
  emoji: "🍕",
  total: 100,
  currency: "EUR",
  includeMe: true,
  people: [{ name: "roomie", emoji: "🦊" }, { name: "bestie" }],
  coins: [{ coin: "usdc-sol", address: SOL }, { coin: "btc-ln", address: "me@wallet.example" }],
  ...over,
});

/** A bill whose friends' links exist: share 1 and 2, 33.33 EUR each, pay link ids pr-1 / pr-2. */
export function makeBill(): Bill {
  const built = buildBill(form(), BILL_ID, "2026-10-19T10:00:00.000Z");
  if (!built.ok) throw new Error(built.error);
  const bill = built.bill;
  bill.shares = bill.shares.map((s) => (s.orderId ? { ...s, paymentRequestId: `pr-${s.n}`, payUrl: `https://send21.io/pay/t${s.n}`, expiresAt: "2026-10-22T10:00:00.000Z", status: "waiting" } : s));
  return bill;
}

/** draft.confirmed for share 1 of makeBill(), shape from docs/webhooks "Payload". */
export function confirmed(over: Record<string, unknown> = {}) {
  return {
    event: "draft.confirmed",
    data: {
      draftId: "3f6c2a9e-5d1b-4c8e-9a7f-2b4d6e8f0a1c",
      quoteId: "9b2e7c41-6a3d-4f8e-b1c5-0d9a8e7f6c2b",
      status: "Confirmed",
      txId: "5KqZ9bQ",
      confirmations: 1,
      sentCurrency: "USDC",
      network: "Solana",
      amountSats: 36_230_000,
      sentAmount: "36.230000",
      fiatCurrency: "EUR",
      fiatAmount: 33.33,
      conversionRate: 0.92,
      rateSource: "coinbase",
      paymentRequestId: "pr-1",
      orderId: `split-${BILL_ID}-1`,
      occurredAt: "2026-10-19T10:05:00.000Z",
      ...over,
    },
  };
}

export async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export function deliver(url: string, body: unknown, { deliveryId = crypto.randomUUID(), t = Math.floor(Date.now() / 1000), secret = SECRET, raw }: { deliveryId?: string; t?: number; secret?: string; raw?: string } = {}) {
  const payload = raw ?? JSON.stringify(body);
  return fetch(`${url}/webhooks/send21`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-send21-delivery": deliveryId, "x-send21-signature-v2": signV2(payload, deliveryId, t, secret) },
    body: payload,
  });
}
