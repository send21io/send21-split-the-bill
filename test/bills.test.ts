import { describe, expect, it } from "vitest";
import { buildBill, createLinks } from "../src/bills.js";
import { COINS } from "../src/currencies.js";
import { createMockClient, Send21Error, type Send21Client } from "../src/send21.js";
import { Store } from "../src/store.js";
import { BILL_ID, form, SOL } from "./helpers.js";

describe("building a bill", () => {
  it("splits among friends and you, remainder on you first", () => {
    const b = buildBill(form(), BILL_ID);
    if (!b.ok) throw new Error(b.error);
    expect(b.bill.shares.map((s) => [s.n, s.amount, s.status, s.orderId])).toEqual([
      [0, 33.34, "me", null],
      [1, 33.33, "creating", `split-${BILL_ID}-1`],
      [2, 33.33, "creating", `split-${BILL_ID}-2`],
    ]);
    expect(b.bill.shares[2]!.emoji).toBe("🐸"); // default avatar for a friend without one
  });

  it("without you, the first friends take the remainder", () => {
    const b = buildBill(form({ includeMe: false }), BILL_ID);
    if (!b.ok) throw new Error(b.error);
    expect(b.bill.shares.map((s) => [s.n, s.amount])).toEqual([[1, 50], [2, 50]]);
  });

  it.each([
    ["no friends", { people: [] }, "friend"],
    ["too many friends", { people: Array.from({ length: 21 }, () => ({})) }, "max 20"],
    ["a share under the minimum", { total: 1 }, "at least"],
    ["three decimals", { total: 10.001 }, "decimals"],
    ["a currency not on the list", { currency: "XYZ" }, "currency"],
    ["no coins", { coins: [] }, "coin"],
    ["a seed phrase as address", { coins: [{ coin: "btc", address: "abandon ability able about above absent absorb abstract absurd abuse access accident" }] }, "seed phrase"],
    ["an address of the wrong network", { coins: [{ coin: "eth-base", address: SOL }] }, "not a"],
    ["the same coin twice", { coins: [{ coin: "usdc-sol", address: SOL }, { coin: "usdc-sol", address: SOL }] }, "twice"],
    ["a name with a link", { people: [{ name: "free.xyz" }] }, "plain name"],
    ["a name with markup", { people: [{ name: "<img>" }] }, "plain name"],
  ])("refuses %s", (_n, over, word) => {
    const b = buildBill(form(over), BILL_ID);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toContain(word);
  });

  it("only offers pairs send21 supports", () => {
    const pairs = COINS.map((c) => `${c.currency}/${c.network}`);
    for (const bad of ["Usdt/Base", "Usdt/Arbitrum", "Usdt/Polygon", "Btc/Base"]) expect(pairs).not.toContain(bad);
  });
});

describe("creating the pay links", () => {
  const cfg = { expiryHours: 72, shortfallPercent: 2 };
  const fresh = () => {
    const store = new Store(":memory:");
    const b = buildBill(form(), BILL_ID);
    if (!b.ok) throw new Error(b.error);
    store.putBill(b.bill);
    return store;
  };

  it("one link per friend, orderId split-<billId>-<n> as orderId and Idempotency-Key", async () => {
    const store = fresh();
    const mock = createMockClient("http://localhost:3000");
    const keys: string[] = [];
    const spy: Send21Client = { ...mock, createPaymentRequest: (body, key) => (keys.push(key), mock.createPaymentRequest(body, key)) };
    const bill = await createLinks(store, spy, cfg, BILL_ID);
    expect(keys).toEqual([`split-${BILL_ID}-1`, `split-${BILL_ID}-2`]);
    const bodies = [...mock.requests.values()].map((r) => r.body);
    expect(bodies.map((b) => [b.orderId, b.fiatAmount, b.fiatCurrency])).toEqual([[`split-${BILL_ID}-1`, 33.33, "EUR"], [`split-${BILL_ID}-2`, 33.33, "EUR"]]);
    expect(bodies[0]).toMatchObject({ expiryHours: 72, shortfallPolicy: { absorbUpToPercent: 2, absorbedBy: "receiver" }, options: [{ currency: "Usdc", network: "Solana", address: SOL }, { currency: "Btc", network: "Mainnet", address: "me@wallet.example", method: "Lightning" }] });
    expect(bill.shares.map((s) => s.status)).toEqual(["me", "waiting", "waiting"]);
  });

  it("a failure halfway can be retried and never makes a second link", async () => {
    const store = fresh();
    const mock = createMockClient("http://localhost:3000");
    let calls = 0;
    const flaky: Send21Client = { ...mock, createPaymentRequest: (body, key) => (++calls === 2 ? Promise.reject(new Send21Error("down", 503)) : mock.createPaymentRequest(body, key)) };
    await expect(createLinks(store, flaky, cfg, BILL_ID)).rejects.toThrow("down");
    expect(store.getBill(BILL_ID)!.shares.map((s) => s.status)).toEqual(["me", "waiting", "creating"]);
    const bill = await createLinks(store, flaky, cfg, BILL_ID);
    expect(bill.shares.map((s) => s.status)).toEqual(["me", "waiting", "waiting"]);
    expect(mock.requests.size).toBe(2);
  });
});
