// VIT Proodle auto-buyer on Cloudflare Workers.
// The site (public/index.html) shows today's menu with live stock, buys in one tap,
// and lets you tick items to auto-buy. Pings to /internal/tick (from a phone/laptop in India) do the checking.
// Storage: one D1 table kv(k, v). Keys: users, user:<reg>, tok:<token>,
// day:<day>:done:<reg>:<meal>:<item> (bought today), day:<day>:open:<reg>:<meal> (open alert sent today),
// times:<outlet> (learned meal start/end times).

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

// Proodle (behind Cloudflare bot protection) only answers requests that start from a real device in India.
// Requests started by a user's tap carry their device's address and pass; the cron and cloud servers don't.
// So background checks are driven by /internal/tick, pinged from someone's phone (iOS Shortcuts) or laptop.
let ENV = {};

async function call(path, body, query) {
  const init = { headers: { "Content-Type": "application/json; charset=utf-8", "User-Agent": "Mozilla/5.0" } };
  if (body !== undefined) Object.assign(init, { method: "POST", body: JSON.stringify(body) });
  const r = await fetch(BASE + path + (query ? "?" + new URLSearchParams(query) : ""), init);
  if (!r.ok) throw new Error(`Proodle ${path} answered HTTP ${r.status}`);
  const text = (await r.text()).replace(/^\uFEFF/, "");
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
      await update(env, u.reg, x => { x.s = u.s; });
      return u.s;
    }
    if (st[0] === "duplicate") { await call("/api/ulogout", { mobno: st[6] }); continue; } // the site's "close other session? Yes"
    throw new Err("Wrong registration number or PIN");
  }
  throw new Err("Could not close your other Proodle session");
}

// Proodle allows one login per person, and logging in closes the phone app's session.
// Menu, orders and payment only need the saved account ids (+ PIN for paying), not a live session,
// so we log in once at sign-in and never again in the background: nobody gets kicked out.
const session = (env, u) => u.s || login(env, u);

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

// Same steps as the site: order id -> GST -> insert cart -> wallet pay. Returns { text, order }.
async function buy(env, u, meal, id, qty) {
  const s = await session(env, u);
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
  if (code === "1") return { text: `${qty} x ${p.meitdes}, Rs ${net}, bill ${bill}`, order: String(order) };
  throw new Err(PAY_ERR[code] || `Order ${order} not processed (${r})`, code === "9");
}

// ---------- auto-buy (every minute) ----------

// Email alert, sent from the owner's Gmail by a small Apps Script web app (MAIL_URL + MAIL_KEY). Never throws.
const notify = (u, subject, body = subject) => u.email && ENV.MAIL_URL
  ? fetch(ENV.MAIL_URL, { method: "POST", body: JSON.stringify({ key: ENV.MAIL_KEY, to: u.email, subject,
      body: body + "\n\nOpen Mess Auto-Buy: https://proodle-autobuy.proodle-autobuy.workers.dev" }) })
      .then(r => r.text()).then(t => t === "ok" || console.log("mail", t.slice(0, 120))).catch(e => console.log("mail", e.message))
  : null;

// Meal timetable: Proodle items carry StartTime/EndTime ("/Date(ms)/"). Only the open meal is listed,
// so each meal's times are learned the first time it is seen, per outlet, and kept in times:<outlet>.
function tod(v) {
  const ms = Number(/\d{9,}/.exec(String(v || ""))?.[0]);
  if (!ms) return null;
  const d = new Date(ms + 5.5 * 3600e3);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

async function learn(env, u, meal, list) {
  const start = tod(list[0]?.StartTime), end = tod(list[0]?.EndTime);
  if (!start || !u.s) return;
  const key = "times:" + u.s.P2, t = (await get(env, key)) || {};
  if (t[meal]?.start === start && t[meal]?.end === end) return;
  t[meal] = { start, end };
  await put(env, key, t);
}

// seconds since this meal's start time today (negative = before it opens)
function sinceStart(t) {
  if (!t?.start) return null;
  const [h, m] = t.start.split(":").map(Number), n = istNow();
  return n.getUTCHours() * 3600 + n.getUTCMinutes() * 60 + n.getUTCSeconds() - (h * 3600 + m * 60);
}

// When food usually goes up (IST). Learned Proodle start times are used too, e.g. for snacks.
const MEAL_STARTS = { 1: "06:00", 2: "12:00", 4: "18:00" };
const RUSH_BEFORE = 120, RUSH_AFTER = 30 * 60;                         // seconds around a start time

// Alert + auto-buy for one user and one meal, given that meal's current menu.
// Returns how many things are still waiting (rules not bought yet, open-alert not sent yet).
async function checkMeal(env, u, day, meal, list) {
  const reg = u.reg;
  let pending = 0;
  const ready = list.filter(p => stock(p) > 0);
  if (u.email) {
    if (!ready.length) pending++;
    else if (await claim(env, `day:${day}:open:${reg}:${meal}`))      // "Lunch is open" once a day
      await notify(u, `${MEALS[meal]} is open on Proodle`,
        `${MEALS[meal]} is open: ${ready.length} items in stock, e.g. ${ready.slice(0, 5).map(p => p.meitdes).join(", ")}.`);
  }
  for (const rule of (u.rules || []).filter(r => r.meal === meal)) {
    try {
      const p = list.find(p => String(p.meitid) === rule.id)         // by id, or by name if Proodle renumbered it
        || list.find(p => String(p.meitdes).trim().toLowerCase() === rule.name.trim().toLowerCase());
      if (!p || stock(p) < rule.qty) { pending++; continue; }          // not ready yet
      const key = `day:${day}:done:${reg}:${rule.meal}:${rule.id}`;
      if (!(await claim(env, key))) continue;                           // already bought today
      let msg;
      try {
        msg = `AUTO-BOUGHT ${MEALS[rule.meal]}: ${(await buy(env, u, rule.meal, p.meitid, rule.qty)).text}`;
      } catch (e) {
        if (!(e instanceof Err) || e.retry) { await del(env, key); pending++; throw e; } // try again shortly
        msg = `Auto-buy ${rule.name} stopped for today: ${e.message}`;
      }
      await update(env, reg, x => note(x, msg));
      await notify(u, msg.startsWith("AUTO") ? `Bought: ${rule.name}` : `Auto-buy failed: ${rule.name}`,
                   msg + (msg.startsWith("AUTO") ? "\n\nYour pickup QR is under My orders." : ""));
    } catch (e) {
      console.log("watch", reg, rule.name, e.message);
    }
  }
  return pending;
}

export async function watch(env, t0 = Date.now()) {
  ENV = env;
  const RUSH_EVERY = env.RUSH_EVERY ?? 10000, RUSH_UNTIL = env.RUSH_UNTIL ?? 50000;
  const { day } = today();
  await env.DB.prepare("DELETE FROM kv WHERE k LIKE 'day:%' AND k < ?").bind("day:" + day).run();
  let rush = [];                                                        // [user, meal] near a start time
  const open = new Set();
  for (const reg of (await get(env, "users")) || []) {
    const u = await get(env, "user:" + reg);
    if (!u || (!u.rules?.length && !u.email)) continue;
    const times = u.s ? (await get(env, "times:" + u.s.P2)) || {} : {};
    const meals = u.email ? [1, 2, 3, 4] : [...new Set(u.rules.map(r => r.meal))];
    for (const meal of meals) {
      try {
        const list = await rawMenu(env, u, meal);
        if (list.length) await learn(env, u, meal, list);
        if (list.some(p => stock(p) > 0)) open.add(MEALS[meal]);
        const pending = await checkMeal(env, u, day, meal, list);
        const near = [MEAL_STARTS[meal], times[meal]?.start].some(st => {
          const t = sinceStart(st && { start: st });
          return t !== null && t >= -RUSH_BEFORE && t <= RUSH_AFTER;
        });
        if (pending && near) rush.push([u, meal]);
      } catch (e) {
        console.log("watch meal", reg, meal, e.message);
      }
    }
  }
  if (!open.size) { // nobody needed a full check: still report honestly what's open, using any signed-in user
    const any = await get(env, "user:" + ((await get(env, "users")) || [])[0]);
    if (any?.s) for (const meal of [1, 2, 3, 4]) {
      const list = await rawMenu(env, any, meal).catch(() => []);
      if (list.some(p => stock(p) > 0)) { open.add(MEALS[meal]); await learn(env, any, meal, list); }
    }
  }
  // Pings arrive about once a minute. Around meal start times keep re-checking every 10 s for the
  // rest of the minute, so ticked food is bought (and the alert sent) within seconds of going up.
  // ponytail: ~6 Proodle calls per rushing user per minute; free plan allows 50 per run, so a handful
  // of users rush fine; with many users split the run per user (service binding / queue).
  while (rush.length && Date.now() - t0 < RUSH_UNTIL) {
    await new Promise(r => setTimeout(r, RUSH_EVERY));
    const still = [];
    for (const [u, meal] of rush) {
      try {
        if (await checkMeal(env, u, day, meal, await rawMenu(env, u, meal))) still.push([u, meal]);
      } catch (e) {
        console.log("rush", u.reg, meal, e.message);
        still.push([u, meal]);
      }
    }
    rush = still;
  }
  return [...open];
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
    const old = await get(env, "user:" + reg);
    const wpin = String(q.wpin || "").trim();
    if (old?.s && old.pin === pin) {
      // already signed in before with this same (Proodle-verified) PIN: no new Proodle login, so the app isn't kicked
      if (wpin) await update(env, reg, x => { x.wpin = wpin; });
    } else {
      const u = { rules: [], log: [], ...old, reg, pin, wpin };
      delete u.s;
      await put(env, "user:" + reg, u);
      try {
        await login(env, u);
      } catch (e) {
        if (old) await put(env, "user:" + reg, old);  // keep the working setup on a wrong PIN
        else await del(env, "user:" + reg);           // don't keep a wrong PIN for a brand-new user
        throw e;
      }
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
                  rules: u.rules || [], log: u.log || [], meals: MEALS, poll: 60, email: u.email || "",
                  times: u.s ? (await get(env, "times:" + u.s.P2)) || {} : {} });
  if (path === "/api/menu") {
    const meal = Number(q.meal) || 1, list = await rawMenu(env, u, meal);
    if (list.length) await learn(env, u, meal, list);
    return json(list.map(p => ({
      id: String(p.meitid), name: p.meitdes, price: Number(p.retrt), stock: stock(p), info: p.dispname || "" })));
  }
  if (path === "/api/buy") {
    const meal = Number(q.meal), qty = Math.max(1, Math.min(5, parseInt(q.qty) || 1));
    try {
      const r = await buy(env, u, meal, q.id, qty);
      await update(env, reg, x => note(x, `Bought ${MEALS[meal]}: ${r.text}`));
      return json({ ok: true, receipt: r.text, order: r.order });
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
  if (path === "/api/email") { // email alerts on (address) / off ("")
    const email = String(q.email || "").trim().slice(0, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "That email address looks wrong" }, 400);
    await update(env, reg, x => { x.email = email; delete x.alerts; });
    if (email) await notify({ email }, "Mess Auto-Buy alerts are on",
      "You'll get an email when each meal opens on Proodle, and whenever something is auto-bought for you.");
    return json({ ok: true, email });
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
    ENV = env;
    const url = new URL(req.url);
    if (url.pathname === "/internal/tick") { // pinged by a phone/laptop in India; see README
      if (!env.TICK_KEY || url.searchParams.get("k") !== env.TICK_KEY) return json({ error: "Not found" }, 404);
      const open = await watch({ ...env, RUSH_UNTIL: 40000 }).catch(e => (console.log("tick", e.message), null));
      return new Response(open === null ? "Check failed, will retry"
        : open.length ? `Open now: ${open.join(", ")}` : "Checked: nothing open yet", { headers: { "Content-Type": "text/plain" } });
    }
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof Err) return json({ error: e.message }, 400);
      console.log("error", e.stack);
      return json({ error: `Proodle error: ${e.message}` }, 502);
    }
  },
};
