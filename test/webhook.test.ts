import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient } from "../src/send21.js";
import { createApp } from "../src/server.js";
import { Store } from "../src/store.js";
import { BILL_ID, confirmed, deliver, form, listen, makeBill, SECRET } from "./helpers.js";

let dir: string;
let file: string;
let server: Awaited<ReturnType<typeof listen>>;
let store: Store;
const status = (n = 1) => store.getBill(BILL_ID)!.shares.find((s) => s.n === n)!.status;

async function start() {
  store = new Store(file);
  server = await listen(createApp({ store, send21: createMockClient("http://localhost"), secret: SECRET, links: { expiryHours: 72, shortfallPercent: 2 }, log: () => undefined }));
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "split-"));
  file = join(dir, "split.json");
  new Store(file).putBill(makeBill());
  await start();
});
afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("webhook receiver", () => {
  it("marks the share paid", async () => {
    const res = await deliver(server.url, confirmed());
    expect(await res.json()).toEqual({ ok: true, outcome: "paid" });
    expect(status()).toBe("paid");
  });

  it("401 for a bad signature or an old delivery, and nothing stored", async () => {
    expect((await deliver(server.url, confirmed(), { secret: "nope", deliveryId: "d-1" })).status).toBe(401);
    expect((await deliver(server.url, confirmed(), { t: Math.floor(Date.now() / 1000) - 301 })).status).toBe(401);
    expect(status()).toBe("waiting");
    // The forged try did not burn the delivery id.
    expect(await (await deliver(server.url, confirmed(), { deliveryId: "d-1" })).json()).toMatchObject({ outcome: "paid" });
  });

  it("400 for a signed body that is not a JSON object", async () => {
    expect((await deliver(server.url, null, { raw: "nope" })).status).toBe(400);
  });
});

describe("dedupe", () => {
  it("a retried delivery id is applied once", async () => {
    await deliver(server.url, confirmed(), { deliveryId: "same" });
    const b = await deliver(server.url, confirmed({ txId: "other" }), { deliveryId: "same" });
    expect(await b.json()).toEqual({ ok: true, duplicate: true });
    expect(store.getBill(BILL_ID)!.shares[1]!.paid?.txId).toBe("5KqZ9bQ");
  });

  it("the same body under a new delivery id is a duplicate", async () => {
    await deliver(server.url, confirmed(), { deliveryId: "one" });
    expect(await (await deliver(server.url, confirmed(), { deliveryId: "two" })).json()).toEqual({ ok: true, duplicate: true });
  });

  it("survives a restart", async () => {
    await deliver(server.url, { event: "draft.seen", data: { orderId: `split-${BILL_ID}-1` } }, { deliveryId: "keep" });
    await server.close();
    await start();
    expect(await (await deliver(server.url, { event: "draft.seen", data: { orderId: `split-${BILL_ID}-2` } }, { deliveryId: "keep" })).json()).toEqual({ ok: true, duplicate: true });
    expect(status(2)).toBe("waiting");
  });

  it("500 and forgotten when the write fails, so send21 retries", async () => {
    const spy = vi.spyOn(store as unknown as { persist: () => void }, "persist").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect((await deliver(server.url, confirmed(), { deliveryId: "retry" })).status).toBe(500);
    expect(status()).toBe("waiting");
    spy.mockRestore();
    expect(await (await deliver(server.url, confirmed(), { deliveryId: "retry" })).json()).toMatchObject({ outcome: "paid" });
  });
});

describe("app API", () => {
  it("creates a bill with links, serves it, its QR and safe headers", async () => {
    const res = await fetch(`${server.url}/api/bills`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form()) });
    expect(res.status).toBe(201);
    const bill = await res.json();
    expect(bill.shares.map((s: { status: string }) => s.status)).toEqual(["me", "waiting", "waiting"]);
    expect(JSON.stringify(bill)).not.toContain("paymentRequestId"); // internals stay on the server
    const get = await fetch(`${server.url}/api/bills/${bill.id}`);
    expect(get.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect((await fetch(`${server.url}/api/bills/${bill.id}/qr/1`)).headers.get("content-type")).toContain("image/svg+xml");
    expect((await fetch(`${server.url}/api/bills/${bill.id}/qr/0`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/bills/not-an-id`)).status).toBe(404);
  });

  it("400 with a short message for a bad form", async () => {
    const res = await fetch(`${server.url}/api/bills`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form({ total: -5 })) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^🔢/);
  });

  it("pushes webhook changes to the live board (SSE)", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${server.url}/api/bills/${BILL_ID}/live`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const next = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).replace(/^data: /, ""));
    expect((await next()).shares[1].status).toBe("waiting");
    await deliver(server.url, confirmed());
    expect((await next()).shares[1].status).toBe("paid");
    ctrl.abort();
  });

  it("rate-limits bill creation", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await fetch(`${server.url}/api/bills`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status);
    expect(codes).toContain(429);
  });
});
