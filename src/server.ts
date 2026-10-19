import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import QRCode from "qrcode";
import { applyEvent, buildBill, createLinks, LIMITS, publicBill, type LinkConfig } from "./bills.js";
import { COINS, FIATS, fiatDecimals, formatFiat } from "./currencies.js";
import { friendlyError, type createMockClient, type Send21Client } from "./send21.js";
import { Store } from "./store.js";
import type { Bill } from "./types.js";
import { signV2, verifySignatureV2 } from "./verify.js";

export interface AppDeps {
  store: Store;
  send21: Send21Client;
  secret: string;
  links: LinkConfig;
  log?: (line: string) => void;
  /** Mock mode only: serves /mock/pay/<token> to simulate payments. */
  mock?: { client: ReturnType<typeof createMockClient>; selfUrl: string };
  trustProxy?: boolean;
}

// public/ sits next to src/ (tsx) or two levels up from dist/src/ (built).
const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, HERE.includes(`${sep}dist${sep}`) ? "../../public" : "../public");
const BILL_ID = /^[a-z0-9]{20}$/;

/** Token bucket per IP: `burst` requests, refilled at one per `everyMs`. */
export function rateLimit(burst: number, everyMs: number) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (req: Request, res: Response, next: () => void) => {
    const key = req.ip ?? "?";
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + (now - b.at) / everyMs);
    b.at = now;
    if (b.tokens < 1) {
      res.set("Retry-After", String(Math.ceil(everyMs / 1000))).status(429).json({ error: "🐢 slow down" });
      return;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    if (buckets.size > 10_000) buckets.clear();
    next();
  };
}

export function createApp({ store, send21, secret, links, log = console.log, mock, trustProxy = false }: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy);
  app.use((_req, res, next) => {
    res.set({
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, mode: send21.mode });
  });

  // ---------- send21 webhook: raw bytes, the signature covers the exact body ----------
  app.post("/webhooks/send21", express.raw({ type: () => true, limit: "64kb" }), (req, res) => {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const deliveryId = req.get("x-send21-delivery");
    // 1. Signature V2 + 300 s window. Nothing is stored for a request that fails.
    if (!verifySignatureV2(raw, req.get("x-send21-signature-v2"), deliveryId, secret)) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    let body: { event?: unknown; data?: unknown };
    try {
      body = JSON.parse(raw.toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    } catch {
      res.status(400).json({ error: "invalid json" });
      return;
    }
    // 2 + 3. Dedupe and apply in one write: either both are on disk or neither.
    const eventKey = createHash("sha256").update(raw).digest("hex");
    let applied;
    try {
      applied = store.transaction((d) => (Store.remember(d, deliveryId as string, eventKey) ? applyEvent(d, body) : null));
    } catch (err) {
      log(`webhook: store write failed, send21 will retry: ${(err as Error).message}`);
      res.status(500).json({ error: "try again" });
      return;
    }
    if (applied === null) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    log(`webhook ${String(body.event)} ${deliveryId}: ${applied.outcome}`);
    res.status(200).json({ ok: true, outcome: applied.outcome });
    // 4. Only now push to live boards.
    if (applied.bill) store.changed(applied.bill);
  });

  // ---------- app API ----------
  const api = express.Router();
  api.use(express.json({ limit: "16kb" }));
  const getBill = (req: Request, res: Response): Bill | null => {
    const id = String(req.params.id ?? "");
    const bill = BILL_ID.test(id) ? store.getBill(id) : undefined;
    if (!bill) res.status(404).json({ error: "🫥 bill not found" });
    return bill ?? null;
  };
  const makeLinks = async (bill: Bill, res: Response, status: number) => {
    try {
      res.status(status).json(publicBill(await createLinks(store, send21, links, bill.id)));
    } catch (err) {
      log(`pay link failed for bill ${bill.id}: ${(err as Error).message}`);
      res.status(502).json({ error: friendlyError(err), bill: publicBill(store.getBill(bill.id) ?? bill) });
    }
  };

  // Coins, currencies and limits for the form: one source of truth.
  api.get("/meta", (_req, res) => {
    res.json({
      mode: send21.mode,
      fiats: FIATS.map((f) => ({ code: f, decimals: fiatDecimals(f) })),
      coins: COINS.map((c) => ({ id: c.id, emoji: c.emoji, label: c.label })),
      limits: LIMITS,
    });
  });
  api.post("/bills", rateLimit(10, 60_000), async (req, res) => {
    const built = buildBill(req.body ?? {});
    if (!built.ok) {
      res.status(400).json({ error: built.error });
      return;
    }
    store.putBill(built.bill);
    await makeLinks(built.bill, res, 201);
  });
  // Retry after a failed create: idempotent, the same orderIds return the same pay links.
  api.post("/bills/:id/links", rateLimit(10, 60_000), async (req, res) => {
    const bill = getBill(req, res);
    if (bill) await makeLinks(bill, res, 200);
  });
  api.get("/bills/:id", (req, res) => {
    const bill = getBill(req, res);
    if (bill) res.json(publicBill(bill));
  });
  api.get("/bills/:id/qr/:n", async (req, res) => {
    const bill = getBill(req, res);
    const share = bill?.shares.find((s) => String(s.n) === req.params.n);
    if (!bill) return;
    if (!share?.payUrl) {
      res.status(404).end();
      return;
    }
    const svg = await QRCode.toString(share.payUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#1b1c20", light: "#fef8ec" } });
    res.type("image/svg+xml").set("Cache-Control", "private, max-age=3600").send(svg);
  });

  // Live board: Server-Sent Events, one message per change of this bill.
  let open = 0;
  api.get("/bills/:id/live", (req, res) => {
    const bill = getBill(req, res);
    if (!bill) return;
    if (open >= 1000) {
      res.status(503).end();
      return;
    }
    open++;
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const send = (b: Bill) => res.write(`data: ${JSON.stringify(publicBill(b))}\n\n`);
    const onBill = (b: Bill) => {
      if (b.id === bill.id) send(b);
    };
    send(store.getBill(bill.id) ?? bill);
    store.on("bill", onBill);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      open--;
      clearInterval(ping);
      store.off("bill", onBill);
    });
  });
  app.use("/api", api);

  if (mock) mountMock(app, secret, mock);
  app.use(express.static(PUBLIC_DIR, { index: "index.html" }));
  return app;
}

// ---------- mock mode: a tiny local "pay page" that sends signed deliveries ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function mountMock(app: Express, secret: string, { client, selfUrl }: NonNullable<AppDeps["mock"]>): void {
  app.get("/mock/pay/:token", (req, res) => {
    const entry = client.requests.get(req.params.token);
    if (!entry) {
      res.status(404).send("unknown pay link");
      return;
    }
    const t = esc(req.params.token);
    const coins = entry.body.options.map((o, i) => `<option value="${i}">${esc(`${o.currency.toUpperCase()} · ${o.method ?? o.network}`)}</option>`).join("");
    res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>mock pay</title><link rel="stylesheet" href="/mock.css">
<main class="mock"><p class="tag">🧪 MOCK · no real money</p><h1>${esc(formatFiat(entry.body.fiatAmount, entry.body.fiatCurrency))}</h1><p>${esc(entry.body.memo)}</p>
${[["seen", "👀 start paying"], ["paid", "✅ pay"], ["short", "⚠️ pay 5% short"], ["expire", "⌛ expire"]].map(([a, l]) => `<form method="post" action="/mock/pay/${t}/${a}"><select name="coin">${coins}</select><button>${l}</button></form>`).join("")}
</main>`);
  });

  app.post("/mock/pay/:token/:action", express.urlencoded({ extended: false, limit: "1kb" }), async (req, res) => {
    const entry = client.requests.get(req.params.token);
    if (!entry) {
      res.status(404).send("unknown pay link");
      return;
    }
    const option = entry.body.options[Number((req.body as { coin?: string })?.coin ?? 0)] ?? entry.body.options[0]!;
    const units = option.currency === "Btc" ? 1e8 : option.currency === "Sol" || option.currency === "Eth" ? 1e9 : 1e6;
    const price = option.currency === "Btc" ? 60000 : option.currency === "Eth" ? 3000 : option.currency === "Sol" ? 150 : 1;
    const amountSats = Math.max(1, Math.round((entry.body.fiatAmount / price) * units));
    const base = {
      draftId: randomUUID(),
      paymentRequestId: entry.response.id,
      orderId: entry.body.orderId,
      sentCurrency: option.currency.toUpperCase(),
      network: option.network,
      fiatCurrency: entry.body.fiatCurrency,
      fiatAmount: entry.body.fiatAmount,
      amountSats,
      sentAmount: (amountSats / units).toFixed(Math.log10(units)),
      occurredAt: new Date().toISOString(),
    };
    const action = req.params.action;
    const body =
      action === "paid"
        ? { event: "draft.confirmed", data: { ...base, status: "Confirmed", txId: `mock-${randomUUID()}`, confirmations: 1 } }
        : action === "seen"
          ? { event: "draft.seen", data: { ...base, status: "Seen", txId: `mock-${randomUUID()}`, confirmations: 0 } }
          : action === "short"
            ? { event: "draft.amount_mismatch", data: { ...base, status: "AwaitingPayment", reviewState: "pending", receivedAmountSats: Math.round(amountSats * 0.95) } }
            : { event: "payment_request.expired", data: { paymentRequestId: entry.response.id, orderId: entry.body.orderId, opened: true, quoteRequested: false } };
    const raw = JSON.stringify(body);
    const deliveryId = randomUUID();
    const r = await fetch(`${selfUrl}/webhooks/send21`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-send21-event": body.event,
        "x-send21-delivery": deliveryId,
        "x-send21-signature-v2": signV2(raw, deliveryId, Math.floor(Date.now() / 1000), secret),
      },
      body: raw,
    });
    const billId = /^split-([a-z0-9]{20})-/.exec(entry.body.orderId)?.[1] ?? "";
    res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/mock.css">
<main class="mock"><h1>${r.ok ? "📨" : "❌"}</h1><p>${esc(r.ok ? body.event : String(r.status))}</p><p><a href="/#/b/${esc(billId)}">👉 board</a> · <a href="/mock/pay/${esc(req.params.token)}">↩️ back</a></p></main>`);
  });
}
