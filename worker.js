// VIT Proodle auto-buyer on Cloudflare Workers.
// The site (public/index.html) shows today's menu with live stock, buys in one tap,
// and lets you tick items to auto-buy. A 1-minute cron buys them the moment they are in stock.
// Storage: one D1 table kv(k, v). Keys: users, user:<reg>, tok:<token>, done:<day>:<reg>:<meal>:<item>.

const BASE = "https://vit-proodle.expertsoftsys.com";
const MEALS = { 1: "Breakfast", 2: "Lunch", 3: "Snacks", 4: "Dinner" };
const WEEKDAYS = ["", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PAY_ERR = { 2: "Insufficient wallet balance", 3: "Card expired", 4: "Card inactive",
                  5: "Invalid card", 6: "Wrong wallet PIN", 9: "Out of stock" };

class Err extends Error {
  constructor(msg, retry = false) { super(msg); this.retry = retry; } // retry: worth trying next minute
}

// ---------- storage ----------

const get = async (env, k) => {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first();
  return r ? JSON.parse(r.v) : null;
};
const put = (env, k, v) => env.DB.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v")
  .bind(k, JSON.stringify(v)).run();
const del = (env, k) => env.DB.prepare("DELETE FROM kv WHERE k = ?").bind(k).run();
// Atomic "first one wins": true only for the run that inserts the key. Stops double buys.
const claim = async (env, k) =>
  (await env.DB.prepare("INSERT OR IGNORE INTO kv (k, v) VALUES (?, '1')").bind(k).run()).meta.changes === 1;

async function update(env, reg, fn) { // re-read, change, write: edits from the site and the cron don't clobber each other
  const u = await get(env, "user:" + reg);
  if (u) { fn(u); await put(env, "user:" + reg, u); }
  return u;
}

function note(u, msg) {
  const t = istNow();
  const stamp = `${String(t.getUTCDate()).padStart(2, "0")} ${MONTHS[t.getUTCMonth()]} ` +
    `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}  `;
  u.log = [stamp + msg, ...(u.log || [])].slice(0, 50);
}

// ---------- Proodle API ----------

async function call(path, body, query) {
  const url = BASE + path + (query ? "?" + new URLSearchParams(query) : "");
  const init = { headers: { "Content-Type": "application/json; charset=utf-8", "User-Agent": "Mozilla/5.0" } };
  if (body !== undefined) Object.assign(init, { method: "POST", body: JSON.stringify(body) });
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`Proodle ${path} answered HTTP ${r.status}`);
  const text = (await r.text()).replace(/^﻿/, "");
  let out;
  try { out = text ? JSON.parse(text) : ""; } catch { out = text; } // orderQR answers with bare base64
  while (typeof out === "string" && /^[[{]/.test(out)) out = JSON.parse(out); // some endpoints double-encode
  return out;
}

const istNow = () => new Date(Date.now() + 5.5 * 3600e3); // read with getUTC* = IST wall clock

function today() {
  const d = istNow();
  return { day: d.toISOString().slice(0, 10), wd: d.getUTCDay() || 7,
           odt: `${String(d.getUTCDate()).padStart(2, "0")}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}` };
}

async function login(env, u) {
  for (let i = 0; i < 2; i++) {
    const r = await call("/api/GetOTPChecking", { MobileNo: u.reg, OtpNo: u.pin });
    if (!Array.isArray(r) || !r.length) throw new Err("Login failed");
    const st = String(r[0].OtpSts || "").split("|");
    if (st[0] === "Success") {
      u.s = { P1: u.reg, P2: r[0].ouid, P5: st[5], P6: st[6], P9: r[0].ctrid, P10: r[0].logid };
      await update(env, u.reg, x => { x.s = u.s; }); // reuse it, so we don't re-login every minute
      return u.s;
    }
    if (st[0] === "duplicate") { await call("/api/ulogout", { mobno: st[6] }); continue; } // the site's "close other session? Yes"
    throw new Err("Wrong registration number or PIN");
  }
  throw new Err("Could not close your other Proodle session");
}

async function session(env, u, fresh = false) {
  let s = u.s;
  if (s && fresh) {
    const alive = await call("/api/chkuserstat", { mobno: s.P6, logid: s.P10 }).then(r => String(r) !== "0", () => false);
    if (!alive) s = null;
  }
  return s || login(env, u);
}

async function rawMenu(env, u, meal) {
  const s = await session(env, u);
  const { odt, wd } = today();
  const r = await call("/api/GetOptionMenuItems", { DocumentNo: String(wd), SessionNo: String(meal), mobno: s.P6,
                                                    flg: "2", oid: s.P2, odt });
  return Array.isArray(r) ? r : [];
}

const stock = p => Math.trunc(Number(p.StockQty) || 0);

async function orders(env, u) { // same list as Proodle's My Orders page
  const s = await session(env, u);
  const r = await call("/api/GetOrderList", { MobileNo: s.P6 });
  return Array.isArray(r) ? r : [];
}

async function balance(u) {
  const r = await call("/api/getstudWBalinfo", undefined, { rno: u.reg });
  return Array.isArray(r) && r.length ? Number(r[0].bal) : null;
}

// Same steps as the site: order id -> GST -> insert cart -> wallet pay. Returns a receipt string.
async function buy(env, u, meal, id, qty) {
  const s = await session(env, u, true);
  const p = (await rawMenu(env, u, meal)).find(p => String(p.meitid) === String(id));
  if (!p) throw new Err("Item not on today's menu", true);
  if (stock(p) < qty) throw new Err("Not in stock yet", true);
  const { odt, wd } = today();
  const rt = Number(p.retrt);
  const item = { productId: `${p.skuid}_${p.meitid}_${p.tb}`, quantity: qty, ides: p.meitdes, rt, amt: qty * rt,
                 tp: p.type, odt, odtdes: WEEKDAYS[wd], tb: parseInt(p.tb), pid: String(p.meitid), dtstr: odt,
                 ldes: p.dispname, cal: p.itmsdes, sname: p.odtdes, skid: String(p.skuid), flag: 1, optcls: "" };
  const gst = await call("/api/getexgstval", undefined, { ouid: s.P2, pids: item.pid, qtys: String(qty) });
  const net = (item.amt + (Number(gst) || 0)).toFixed(2);
  const order = (await call("/api/GetOrderIdDetails", { MobileNo: s.P6, TableNo: "1" }))[0].OrderNo;
  const ins = await call("/api/GetOutletListInsert", { items: [item], OrderNumber: order, TableNo: "1", ItemTotal: net,
                                                       OutLetId: s.P2, MobileNo: s.P6, RefNo: s.P9 });
  if (String(ins) !== "1") throw new Err("Proodle refused the order", true);
  let r;
  try {
    r = String(await call("/api/OnlineWPayment", { MobileNo: s.P6, OrderNumber: order, OrderAmount: net, ouid: s.P2,
                                                   Otp: u.wpin || u.pin, p1: s.P1 }));
  } catch {
    // the payment may or may not have gone through: never retry blindly
    throw new Err(`No reply from payment for order ${order}. Check My Orders on Proodle.`);
  }
  const [code, bill] = r.split("|");
  if (code === "1") return `${qty} x ${p.meitdes}, Rs ${net}, bill ${bill}`;
  throw new Err(PAY_ERR[code] || `Order ${order} not processed (${r})`, code === "9");
}

// ---------- auto-buy (every minute) ----------

export async function watch(env) {
  const { day } = today();
  await env.DB.prepare("DELETE FROM kv WHERE k LIKE 'done:%' AND k < ?").bind("done:" + day).run();
  for (const reg of (await get(env, "users")) || []) {
    const u = await get(env, "user:" + reg);
    if (!u?.rules?.length) continue;
    const menus = {};
    for (const rule of u.rules) {
      try {
        menus[rule.meal] ??= await rawMenu(env, u, rule.meal);
        const p = menus[rule.meal].find(p => String(p.meitid) === rule.id);
        if (!p || stock(p) < rule.qty) continue;                       // not ready yet
        const key = `done:${day}:${reg}:${rule.meal}:${rule.id}`;
        if (!(await claim(env, key))) continue;                         // already bought today
        let msg;
        try {
          msg = `AUTO-BOUGHT ${MEALS[rule.meal]}: ${await buy(env, u, rule.meal, rule.id, rule.qty)}`;
        } catch (e) {
          if (!(e instanceof Err) || e.retry) { await del(env, key); throw e; } // safe to try again next minute
          msg = `Auto-buy ${rule.name} stopped for today: ${e.message}`;
        }
        await update(env, reg, x => note(x, msg));
      } catch (e) {
        console.log("watch", reg, rule.name, e.message);
      }
    }
  }
}

// ---------- web routes ----------

const json = (obj, status = 200, cookie) => {
  const h = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (cookie) h["Set-Cookie"] = cookie;
  return new Response(JSON.stringify(obj), { status, headers: h });
};

async function route(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const q = req.method === "POST" ? await req.json().catch(() => ({})) : Object.fromEntries(url.searchParams);

  if (path === "/api/login") {
    const reg = String(q.reg || "").trim(), pin = String(q.pin || "").trim();
    if (!/^\d+$/.test(reg) || !/^\d+$/.test(pin)) return json({ error: "Enter your registration number and PIN" }, 400);
    const u = { rules: [], log: [], ...(await get(env, "user:" + reg)), reg, pin, wpin: String(q.wpin || "").trim() };
    delete u.s;
    await put(env, "user:" + reg, u);
    try {
      await login(env, u);
    } catch (e) {
      if (!u.rules.length) await del(env, "user:" + reg); // don't keep a wrong PIN for a brand-new user
      throw e;
    }
    const users = (await get(env, "users")) || [];
    if (!users.includes(reg)) await put(env, "users", [...users, reg]);
    const tok = crypto.randomUUID() + crypto.randomUUID();
    await put(env, "tok:" + tok, reg);
    return json({ ok: true }, 200, `pt=${tok}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`);
  }

  const tok = (req.headers.get("Cookie") || "").split(";").map(c => c.trim().split("="))
    .find(([k]) => k === "pt")?.[1];
  const reg = tok && await get(env, "tok:" + tok);
  const u = reg && await get(env, "user:" + reg);
  if (!u) return json({ error: "Not logged in" }, 401);

  if (path === "/api/state")
    return json({ name: u.s?.P5 || u.reg, reg: u.reg, balance: await balance(u).catch(() => null),
                  rules: u.rules || [], log: u.log || [], meals: MEALS, poll: 60 });
  if (path === "/api/menu")
    return json((await rawMenu(env, u, Number(q.meal) || 1)).map(p => ({
      id: String(p.meitid), name: p.meitdes, price: Number(p.retrt), stock: stock(p), info: p.dispname || "" })));
  if (path === "/api/buy") {
    const meal = Number(q.meal), qty = Math.max(1, Math.min(5, parseInt(q.qty) || 1));
    try {
      const receipt = await buy(env, u, meal, q.id, qty);
      await update(env, reg, x => note(x, `Bought ${MEALS[meal]}: ${receipt}`));
      return json({ ok: true, receipt });
    } catch (e) {
      await update(env, reg, x => note(x, `Buy failed (${MEALS[meal]}): ${e.message}`));
      throw e;
    }
  }
  if (path === "/api/orders")
    return json((await orders(env, u)).slice(0, 20).map(o => ({
      id: String(o.OrderId), meal: o.sname, status: o.Status, qr: Number(o.qrstat) > 0,
      amount: o.NetAmount, date: o.OrderDate })));
  if (path === "/api/qr") {
    const o = (await orders(env, u)).find(o => String(o.OrderId) === String(q.id)); // only your own orders
    if (!o) return json({ error: "Order not found" }, 404);
    const [img, items] = await Promise.all([
      call("/api/orderQR", undefined, { ordno: String(o.OrderId) }),
      call("/api/GetStudordItemdet", { MobileNo: String(o.OrderId) }).catch(() => []),
    ]);
    if (typeof img !== "string" || img.length < 100) return json({ error: "Proodle has no QR for this order yet" }, 404);
    return json({ img, name: o.studname, reg: o.RegNo, meal: o.sname, date: o.OrderDate, status: o.Status,
                  items: (Array.isArray(items) ? items : []).map(i => ({ name: i.itmdes, qty: i.pqty, total: i.itot })) });
  }
  if (path === "/api/rules") {
    const rules = (q.rules || []).filter(r => MEALS[r.meal]).map(r => ({
      meal: Number(r.meal), id: String(r.id), name: String(r.name).slice(0, 80),
      qty: Math.max(1, Math.min(5, parseInt(r.qty) || 1)) }));
    await update(env, reg, x => { x.rules = rules; });
    return json({ ok: true });
  }
  if (path === "/api/forget") { // sign out + delete stored PIN and rules
    await del(env, "user:" + reg);
    await del(env, "tok:" + tok);
    await put(env, "users", ((await get(env, "users")) || []).filter(r => r !== reg));
    return json({ ok: true }, 200, "pt=; Path=/; Max-Age=0");
  }
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(req, env) {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof Err) return json({ error: e.message }, 400);
      console.log("error", e.stack);
      return json({ error: `Proodle error: ${e.message}` }, 502);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(watch(env));
  },
};
