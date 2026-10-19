import { describe, expect, it } from "vitest";
import { applyEvent, checkPaymentAgainstShare } from "../src/bills.js";
import type { StoreData } from "../src/store.js";
import type { ShareStatus } from "../src/types.js";
import { BILL_ID, confirmed, makeBill } from "./helpers.js";

const share1 = () => makeBill().shares.find((s) => s.n === 1)!;
const ref = { orderId: `split-${BILL_ID}-1`, paymentRequestId: "pr-1" };
function run(body: { event: string; data: Record<string, unknown> }, status: ShareStatus = "waiting") {
  const bill = makeBill();
  bill.shares = bill.shares.map((s) => (s.n === 1 ? { ...s, status } : s));
  const d: StoreData = { version: 1, bills: { [bill.id]: bill }, deliveries: {}, events: {} };
  const applied = applyEvent(d, body);
  return { applied, share: d.bills[BILL_ID]!.shares.find((s) => s.n === 1)!, other: d.bills[BILL_ID]!.shares.find((s) => s.n === 2)! };
}

describe("amount and asset matching per share", () => {
  it("accepts exactly that person's share", () => {
    expect(checkPaymentAgainstShare(confirmed().data, share1(), makeBill())).toEqual([]);
  });

  it.each([
    ["the whole bill instead of the share", { fiatAmount: 100 }, "amount"],
    ["another person's (larger) share", { fiatAmount: 33.34 }, "amount"],
    ["another fiat currency", { fiatCurrency: "USD" }, "fiat"],
    ["a coin not offered", { sentCurrency: "USDT" }, "asset"],
    ["the right coin on another network", { network: "Base" }, "asset"],
    ["another person's pay link", { paymentRequestId: "pr-2" }, "pay link"],
    ["status other than Confirmed", { status: "Seen" }, "status"],
    ["no txId", { txId: undefined }, "txId"],
    ["no amountSats", { amountSats: undefined }, "amountSats"],
  ])("refuses %s", (_n, over, word) => {
    expect(checkPaymentAgainstShare(confirmed(over).data, share1(), makeBill()).join(" ")).toContain(word);
  });

  it("matches BTC over Lightning when it was offered", () => {
    expect(checkPaymentAgainstShare(confirmed({ sentCurrency: "BTC", network: "Mainnet" }).data, share1(), makeBill())).toEqual([]);
  });

  it("flags a non-matching payment, never marks it paid", () => {
    const { applied, share } = run(confirmed({ fiatAmount: 1 }));
    expect(applied.outcome).toBe("flagged");
    expect(share.paid).toBeUndefined();
  });

  it("only touches the person the orderId names", () => {
    const { share, other } = run(confirmed());
    expect(share.status).toBe("paid");
    expect(other.status).toBe("waiting");
  });

  it("ignores foreign orderIds, unknown bills and the payer's own part", () => {
    expect(run(confirmed({ orderId: "shop-1042" })).applied.outcome).toBe("unknown_share");
    expect(run(confirmed({ orderId: "split-zzzzzzzzzzzzzzzzzzzz-1" })).applied.outcome).toBe("unknown_share");
    expect(run(confirmed({ orderId: `split-${BILL_ID}-0` })).applied.outcome).toBe("unknown_share");
    expect(run({ event: "draft.seen", data: { ...ref, paymentRequestId: "pr-2" } }).applied.outcome).toBe("unknown_share");
  });
});

describe("board states", () => {
  it("🟡 → 👀 → ✅, and late events never undo ✅", () => {
    expect(run({ event: "draft.seen", data: ref }).share.status).toBe("seen");
    expect(run(confirmed(), "seen").share.status).toBe("paid");
    expect(run({ event: "draft.seen", data: ref }, "paid").applied.outcome).toBe("unchanged");
    expect(run({ event: "payment_request.expired", data: ref }, "paid").applied.outcome).toBe("unchanged");
    expect(run(confirmed({ txId: "again" }), "paid").applied.outcome).toBe("already_paid");
  });

  it("⚠️ different amount: review → accepted → ✅ with the flag, or declined / undecided", () => {
    expect(run({ event: "draft.amount_mismatch", data: { ...ref, reviewState: "pending" } }).share.status).toBe("review");
    expect(run({ event: "draft.mismatch_accepted", data: ref }, "review").share.status).toBe("accepted");
    const { share } = run(confirmed({ receivedAmountSats: 35_000_000, receivedAmount: "35.000000" }), "accepted");
    expect(share).toMatchObject({ status: "paid", paid: { differentAmount: true, amount: "35.000000" } });
    expect(run({ event: "draft.mismatch_rejected", data: ref }, "review").share.status).toBe("declined");
    expect(run({ event: "draft.mismatch_unresolved", data: ref }, "review").share.status).toBe("unresolved");
    expect(run({ event: "draft.expired", data: { ...ref, reviewState: "unresolved" } }, "review").share.status).toBe("unresolved");
  });

  it("⌛ expired, and a valid payment after expiry still shows ✅", () => {
    expect(run({ event: "payment_request.expired", data: { ...ref, opened: true, quoteRequested: false } }).share.status).toBe("expired");
    expect(run({ event: "draft.expired", data: ref }, "seen").share.status).toBe("expired");
    expect(run(confirmed(), "expired").share.status).toBe("paid");
  });

  it("finds the share by pay link id when a payload has no orderId", () => {
    expect(run({ event: "payment_request.expired", data: { paymentRequestId: "pr-1" } }).share.status).toBe("expired");
  });

  it("test and informational events change nothing", () => {
    expect(run({ event: "test", data: {} }).applied.outcome).toBe("test");
    for (const event of ["draft.created", "draft.cancelled", "draft.mismatch_reminder"]) expect(run({ event, data: ref }).applied.outcome).toBe("ignored");
  });
});
