// split the bill: create view (#/) and live board (#/b/<id>). No framework, no build step.
// User text only ever goes into the page through textContent, never innerHTML.

const $app = document.getElementById("app");
const STATUS = {
  me: ["🙋", "you"],
  creating: ["⚙️", "making link"],
  waiting: ["🟡", "waiting"],
  seen: ["👀", "seen"],
  review: ["⚠️", "different amount"],
  accepted: ["👍", "accepted"],
  paid: ["✅", "paid"],
  declined: ["↩️", "declined"],
  unresolved: ["⚠️", "undecided"],
  expired: ["⌛", "expired"],
  flagged: ["🚩", "check"],
};
const BILL_EMOJI = ["🍕", "🍣", "🍔", "🍻", "🌮", "🏕️", "✈️", "🎉", "🎟️", "🧾"];
const AVATARS = ["🦊", "🐸", "🐼", "🦄", "🐙", "🐯", "🐨", "🐵", "🦁", "🐧", "🐲", "🐳", "🦉", "🐝", "🦋", "🐢", "🦖", "🐰", "🐮", "🐷"];
let meta = null;
let live = null;

// ---------- tiny helpers ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const decimals = (cur) => meta?.fiats.find((f) => f.code === cur)?.decimals ?? 2;
const money = (n, cur) => `${Number(n).toLocaleString("en-US", { minimumFractionDigits: decimals(cur), maximumFractionDigits: decimals(cur) })} ${cur}`;
function toast(text) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}
async function api(path, body) {
  const res = await fetch(`/api${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || "😵 something broke"), { body: json });
  return json;
}
// Same split as the server (src/split.ts): remainder to the first person or persons.
export function splitMinor(total, count) {
  const base = Math.floor(total / count);
  const rest = total - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < rest ? 1 : 0));
}
const stored = (k, d) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; }
};

// ---------- create ----------
function createView() {
  const state = {
    emoji: "🍕",
    title: "",
    total: "",
    currency: stored("split.currency", "EUR"),
    includeMe: true,
    people: [{ name: "", emoji: AVATARS[0] }, { name: "", emoji: AVATARS[1] }, { name: "", emoji: AVATARS[2] }],
    coins: stored("split.coins", [{ coin: "usdc-sol", address: "" }]),
  };
  const preview = h("p", { class: "each" });
  const peopleBox = h("div", { class: "people" });
  const coinBox = h("div", { class: "coins" });

  function updatePreview() {
    const d = decimals(state.currency);
    const total = Math.round(Number(String(state.total).replace(",", ".")) * 10 ** d);
    const count = state.people.length + (state.includeMe ? 1 : 0);
    if (!(total > 0)) return (preview.textContent = `👥 ${count}`);
    const shares = splitMinor(total, count).map((m) => m / 10 ** d);
    const lo = shares[shares.length - 1];
    const hi = shares[0];
    preview.textContent = `👥 ${count} · 💸 ${hi === lo ? money(hi, state.currency) : `${money(lo, state.currency)}–${money(hi, state.currency).split(" ")[0]}`} each`;
  }
  function drawPeople() {
    peopleBox.replaceChildren(
      ...state.people.map((p, i) =>
        h("div", { class: "row" },
          h("button", { type: "button", class: "avatar", "aria-label": "change emoji", onclick: () => { p.emoji = AVATARS[(AVATARS.indexOf(p.emoji) + 1) % AVATARS.length]; drawPeople(); } }, p.emoji),
          h("input", { value: p.name, placeholder: `friend ${i + 1}`, maxlength: 24, "aria-label": `name ${i + 1}`, oninput: (e) => (p.name = e.target.value) }),
          h("button", { type: "button", class: "x", "aria-label": "remove", disabled: state.people.length === 1, onclick: () => { state.people.splice(i, 1); drawPeople(); } }, "✕"),
        ),
      ),
      h("button", { type: "button", class: "add", disabled: state.people.length >= meta.limits.maxPeople, onclick: () => { state.people.push({ name: "", emoji: AVATARS[state.people.length % AVATARS.length] }); drawPeople(); } }, "➕ friend"),
    );
    updatePreview();
  }
  function drawCoins() {
    coinBox.replaceChildren(
      ...state.coins.map((c, i) =>
        h("div", { class: "row coin" },
          h("select", { "aria-label": "coin", onchange: (e) => (c.coin = e.target.value) }, meta.coins.map((m) => h("option", { value: m.id, selected: m.id === c.coin }, `${m.emoji} ${m.label}`))),
          h("input", { value: c.address, placeholder: "your address", autocomplete: "off", spellcheck: "false", "aria-label": "your receiving address", oninput: (e) => (c.address = e.target.value.trim()) }),
          h("button", { type: "button", class: "x", "aria-label": "remove", disabled: state.coins.length === 1, onclick: () => { state.coins.splice(i, 1); drawCoins(); } }, "✕"),
        ),
      ),
      h("button", { type: "button", class: "add", disabled: state.coins.length >= meta.limits.maxCoins, onclick: () => { state.coins.push({ coin: meta.coins[0].id, address: "" }); drawCoins(); } }, "➕ coin"),
    );
  }

  const go = h("button", { class: "go", type: "submit" }, "⚡ make links");
  const form = h("form", { class: "card create", onsubmit: async (e) => {
      e.preventDefault();
      if (go.disabled) return;
      go.disabled = true;
      go.textContent = "⏳";
      localStorage.setItem("split.coins", JSON.stringify(state.coins));
      localStorage.setItem("split.currency", JSON.stringify(state.currency));
      try {
        const bill = await api("/bills", { ...state, total: Number(String(state.total).replace(",", ".")) });
        location.hash = `#/b/${bill.id}`;
      } catch (err) {
        if (err.body?.bill?.id) location.hash = `#/b/${err.body.bill.id}`;
        toast(err.message);
      } finally {
        go.disabled = false;
        go.textContent = "⚡ make links";
      }
    } },
    h("div", { class: "hero" },
      h("button", { type: "button", class: "bill-emoji", "aria-label": "change emoji", onclick: (e) => { state.emoji = BILL_EMOJI[(BILL_EMOJI.indexOf(state.emoji) + 1) % BILL_EMOJI.length]; e.target.textContent = state.emoji; } }, state.emoji),
      h("input", { class: "title", placeholder: "pizza night", maxlength: 32, "aria-label": "title", oninput: (e) => (state.title = e.target.value) }),
    ),
    h("div", { class: "total" },
      h("input", { class: "amount", inputmode: "decimal", placeholder: "0.00", required: true, "aria-label": "total", autofocus: true, oninput: (e) => { state.total = e.target.value; updatePreview(); } }),
      h("select", { class: "cur", "aria-label": "currency", onchange: (e) => { state.currency = e.target.value; updatePreview(); } }, meta.fiats.map((f) => h("option", { value: f.code, selected: f.code === state.currency }, f.code))),
    ),
    h("label", { class: "toggle" }, h("input", { type: "checkbox", checked: state.includeMe, onchange: (e) => { state.includeMe = e.target.checked; updatePreview(); } }), " 🙋 I'm in too"),
    preview,
    h("h2", {}, "👥"),
    peopleBox,
    h("h2", {}, "🪙 paid to you"),
    coinBox,
    h("p", { class: "hint" }, "🔒 your own address · never a seed phrase"),
    go,
  );
  drawPeople();
  drawCoins();
  $app.replaceChildren(form);
}

// ---------- board ----------
function boardView(id, openFirst) {
  const box = h("section", { class: "board" }, h("p", { class: "loading" }, "⏳"));
  $app.replaceChildren(box);
  const open = new Set(openFirst ? [openFirst] : []);
  let last = null;

  const draw = (bill) => {
    last = bill;
    const friends = bill.shares.filter((s) => s.status !== "me");
    const paid = friends.filter((s) => s.status === "paid");
    const got = paid.reduce((a, s) => a + s.amount, 0) + bill.shares.filter((s) => s.status === "me").reduce((a, s) => a + s.amount, 0);
    const pct = Math.round((got / bill.total) * 100);
    const missing = friends.some((s) => s.status === "creating");
    box.replaceChildren(...[
      h("div", { class: "card head" },
        h("div", { class: "big" }, bill.emoji),
        h("h1", {}, bill.title),
        h("p", { class: "sum" }, money(bill.total, bill.currency)),
        h("div", { class: "bar", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 }, h("span", { class: "fill" })),
        h("p", { class: "count" }, paid.length === friends.length ? "🎉 all paid" : `✅ ${paid.length}/${friends.length}`),
      ),
      missing ? h("button", { class: "go retry", onclick: async (e) => { e.target.disabled = true; try { draw(await api(`/bills/${id}/links`, {})); } catch (err) { toast(err.message); if (err.body?.bill) draw(err.body.bill); } } }, "🔁 make missing links") : null,
      ...bill.shares.map((s) => shareCard(bill, s, open)),
      h("button", { class: "ghost", onclick: () => copy(location.href, "🔒 board link copied · keep it private") }, "🔗 board link"),
    ].filter(Boolean));
    // Width via CSSOM, not an inline style attribute (CSP: style-src 'self').
    box.querySelector(".fill").style.width = `${pct}%`;
  };

  api(`/bills/${id}`).then(draw).catch((err) => box.replaceChildren(h("p", { class: "loading" }, err.message)));
  live?.close();
  live = new EventSource(`/api/bills/${id}/live`);
  live.onmessage = (e) => {
    const next = JSON.parse(e.data);
    if (last) for (const s of next.shares) {
      const before = last.shares.find((x) => x.n === s.n);
      if (before && before.status !== s.status && s.status === "paid") toast(`✅ ${s.emoji} ${s.name || `friend ${s.n}`} paid`);
    }
    draw(next);
  };
  box.addEventListener("toggle-share", (e) => {
    const n = e.detail;
    if (open.has(n)) open.delete(n);
    else open.add(n);
    if (last) draw(last);
  });
}

function shareCard(bill, s, open) {
  const [icon, word] = STATUS[s.status] ?? ["❔", s.status];
  const isOpen = open.has(s.n) && s.payUrl && !["paid", "me"].includes(s.status);
  const name = s.status === "me" ? "you" : s.name || `friend ${s.n}`;
  const el = h("article", { class: `card share st-${s.status}${isOpen ? " open" : ""}` },
    h("button", { class: "share-head", type: "button", "aria-expanded": String(Boolean(isOpen)), disabled: !s.payUrl || ["paid", "me"].includes(s.status), onclick: (e) => e.target.closest(".board").dispatchEvent(new CustomEvent("toggle-share", { detail: s.n })) },
      h("span", { class: "who" }, s.emoji),
      h("span", { class: "name" }, name),
      h("span", { class: "amt" }, money(s.amount, bill.currency)),
      h("span", { class: "chip", title: word }, icon, h("span", { class: "word" }, word)),
    ),
    s.status === "paid" && s.paid ? h("p", { class: "paid-with" }, `🪙 ${s.paid.amount ?? ""} ${s.paid.currency} · ${s.paid.network === "Mainnet" ? "Bitcoin" : s.paid.network}${s.paid.differentAmount ? " · ≈ accepted" : ""}`) : null,
    isOpen
      ? h("div", { class: "pay" },
          h("img", { class: "qr", src: `/api/bills/${bill.id}/qr/${s.n}`, alt: `QR pay link for ${name}`, width: 240, height: 240 }),
          h("div", { class: "actions" },
            navigator.share ? h("button", { class: "go", onclick: () => navigator.share({ title: `${bill.emoji} ${bill.title}`, text: `${s.emoji} your share: ${money(s.amount, bill.currency)}`, url: s.payUrl }).catch(() => undefined) }, "📤 share") : null,
            h("button", { class: navigator.share ? "ghost" : "go", onclick: () => copy(s.payUrl, "📋 link copied") }, "📋 copy"),
            h("a", { class: "ghost", href: s.payUrl, target: "_blank", rel: "noopener noreferrer" }, "🔗 open"),
          ),
        )
      : null,
  );
  return el;
}

async function copy(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    toast(text);
  }
}

// ---------- router ----------
async function route() {
  meta ??= await api("/meta");
  document.getElementById("mode").hidden = meta.mode !== "mock";
  // #/b/<id> is the board; #/b/<id>/<n> opens that person's QR card.
  const m = /^#\/b\/([a-z0-9]{20})(?:\/(\d{1,2}))?$/.exec(location.hash);
  if (m) boardView(m[1], m[2] ? Number(m[2]) : null);
  else {
    live?.close();
    createView();
  }
}
addEventListener("hashchange", route);
route().catch((err) => toast(err.message));
