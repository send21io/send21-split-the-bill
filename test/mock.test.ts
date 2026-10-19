import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockClient } from "../src/send21.js";
import { createApp } from "../src/server.js";
import { Store } from "../src/store.js";
import { form, listen, SECRET } from "./helpers.js";

let dir: string;
let server: Awaited<ReturnType<typeof listen>>;
let store: Store;
let mock: { client: ReturnType<typeof createMockClient>; selfUrl: string };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "split-mock-"));
  store = new Store(join(dir, "s.json"));
  mock = { client: createMockClient("http://localhost"), selfUrl: "" };
  server = await listen(createApp({ store, send21: mock.client, secret: SECRET, links: { expiryHours: 72, shortfallPercent: 2 }, log: () => undefined, mock }));
  mock.selfUrl = server.url;
});
afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function newBill() {
  const bill = await (await fetch(`${server.url}/api/bills`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form()) })).json();
  const token = /\/mock\/pay\/([^/?#]+)/.exec(bill.shares[1].payUrl)![1]!;
  const act = (a: string) => fetch(`${server.url}/mock/pay/${token}/${a}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "coin=0" });
  const status = async () => (await (await fetch(`${server.url}/api/bills/${bill.id}`)).json()).shares[1];
  return { id: bill.id as string, token, act, status };
}

describe("mock pay page", () => {
  it("offers sample addresses in mock mode only", async () => {
    const meta = await (await fetch(`${server.url}/api/meta`)).json();
    expect(meta.demoAddresses.solana).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(meta.coins.find((c: { id: string }) => c.id === "usdc-sol").kind).toBe("solana");
  });

  it("one coin picker, every action, lang set", async () => {
    const { token } = await newBill();
    const html = await (await fetch(`${server.url}/mock/pay/${token}`)).text();
    expect(html).toContain('<html lang="en">');
    expect(html.match(/<select/g)).toHaveLength(1);
    for (const a of ["seen", "paid", "short", "accept", "decline", "expire"]) expect(html).toContain(`/mock/pay/${token}/${a}`);
  });

  it("short → accept ends paid (≈ accepted), short → decline ends declined", async () => {
    const one = await newBill();
    expect((await one.act("short")).status).toBe(200);
    expect((await one.status()).status).toBe("review");
    expect((await one.act("accept")).status).toBe(200);
    const paid = await one.status();
    expect(paid.status).toBe("paid");
    expect(paid.paid.differentAmount).toBe(true);

    const two = await newBill();
    await two.act("short");
    await two.act("decline");
    expect((await two.status()).status).toBe("declined");
  });

  it("an expired share no longer hands out its pay link or QR", async () => {
    const { id, act, status } = await newBill();
    expect((await fetch(`${server.url}/api/bills/${id}/qr/1`)).status).toBe(200);
    expect((await status()).payUrl).toMatch(/mock\/pay/);
    await act("expire");
    const s = await status();
    expect(s.status).toBe("expired");
    expect(s.payUrl).toBeNull();
    expect((await fetch(`${server.url}/api/bills/${id}/qr/1`)).status).toBe(404);
  });

  it("an unknown action is a 404, not an expiry", async () => {
    const { act, status } = await newBill();
    expect((await act("nope")).status).toBe(404);
    expect((await status()).status).toBe("waiting");
  });
});
