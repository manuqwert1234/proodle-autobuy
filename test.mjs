// Offline self-check: fake Proodle + fake D1, no real orders. Run: npm test
import assert from "node:assert/strict";
import worker, { watch } from "./worker.js";

const m = new Map();
const DB = { prepare: sql => ({ bind: (...a) => ({
  first: async () => (m.has(a[0]) ? { v: m.get(a[0]) } : null),
  run: async () => {
    if (sql.startsWith("INSERT OR IGNORE")) { const c = m.has(a[0]) ? 0 : 1; m.set(a[0], "1"); return { meta: { changes: c } }; }
    if (sql.startsWith("INSERT INTO")) { m.set(a[0], a[1]); return { meta: { changes: 1 } }; }
    if (sql.includes("LIKE")) { for (const k of [...m.keys()]) if (k.startsWith("done:") && k < a[0]) m.delete(k); return { meta: {} }; }
    if (sql.startsWith("DELETE")) { m.delete(a[0]); return { meta: {} }; }
    throw new Error(sql);
  },
}) }) };
const env = { DB };

const calls = [];
const st = { stock: 0, pay: "1|B42" };
const item = { meitid: 7, meitdes: "Veg Meals", retrt: "60.00", skuid: 3, tb: "2", type: "V",
               dispname: "Rice, dal", itmsdes: "", odtdes: "LUNCH" };
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname, body = init.body && JSON.parse(init.body);
  calls.push(path);
  await new Promise(r => setTimeout(r, 1)); // let overlapping runs interleave
  const out = {
    "/api/GetOTPChecking": () => body.OtpNo === "1234"
      ? JSON.stringify([{ OtpSts: "Success|0|x|x|x|NAME|M123|5", ouid: 9, ctrid: 1, logid: 5 }]) // double-encoded, like the real API
      : [{ OtpSts: "Fail" }],
    "/api/chkuserstat": () => 1,
    "/api/GetOptionMenuItems": () => (assert.match(body.odt, /^\d\d-[A-Z][a-z]{2}-\d{4}$/), [{ ...item, StockQty: st.stock }]),
    "/api/getexgstval": () => 3,
    "/api/GetOrderIdDetails": () => [{ OrderNo: "O1" }],
    "/api/GetOutletListInsert": () => {
      assert.equal(body.items[0].productId, "3_7_2"); assert.equal(body.ItemTotal, "123.00"); return "1";
    },
    "/api/OnlineWPayment": () => { assert.equal(body.Otp, "1234"); assert.equal(body.OrderAmount, "123.00"); return st.pay; },
    "/api/getstudWBalinfo": () => [{ bal: "500" }],
  }[path];
  if (!out) throw new Error("unexpected " + path);
  return new Response(JSON.stringify(out()));
};

const req = (path, body, cookie) => worker.fetch(new Request("https://x" + path, {
  method: body ? "POST" : "GET", body: body && JSON.stringify(body), headers: cookie ? { Cookie: cookie } : {} }), env);
const pays = () => calls.filter(c => c === "/api/OnlineWPayment").length;
const log = () => JSON.parse(m.get("user:2023000000")).log;

// wrong PIN is rejected and not stored
let r = await req("/api/login", { reg: "2023000000", pin: "9999" });
assert.equal(r.status, 400);
assert.ok(!m.has("user:2023000000"));

// sign in, add an auto-buy rule
r = await req("/api/login", { reg: "2023000000", pin: "1234" });
assert.equal(r.status, 200);
const ck = r.headers.get("Set-Cookie").split(";")[0];
assert.equal((await req("/api/rules", { rules: [{ meal: 2, id: "7", name: "Veg Meals", qty: 2 }] }, ck)).status, 200);
assert.equal((await (await req("/api/state", null, ck)).json()).balance, 500);
assert.equal((await req("/api/state", null, "pt=nope")).status, 401);
const logins = calls.filter(c => c === "/api/GetOTPChecking").length;

await watch(env);                                   // out of stock: nothing bought
assert.equal(pays(), 0);
st.stock = 5;
await Promise.all([watch(env), watch(env)]);        // two overlapping runs: still exactly one order
assert.equal(pays(), 1);
assert.match(log()[0], /AUTO-BOUGHT Lunch: 2 x Veg Meals, Rs 123.00, bill B42/);
await watch(env);                                   // same day: never again
assert.equal(pays(), 1);
assert.equal(calls.filter(c => c === "/api/GetOTPChecking").length, logins); // session reused, no re-login

for (const k of [...m.keys()]) if (k.startsWith("done:")) m.delete(k);
st.pay = "6|";
await watch(env); await watch(env);                 // wrong wallet PIN: stops for the day, no retry loop
assert.equal(pays(), 2);
assert.match(log()[0], /Wrong wallet PIN/);

for (const k of [...m.keys()]) if (k.startsWith("done:")) m.delete(k);
st.pay = "9|";
await watch(env);                                   // sold out at pay time: tries again next minute
st.pay = "1|B44";
await watch(env);
assert.equal(pays(), 4);
assert.match(log()[0], /bill B44/);

assert.equal((await req("/api/forget", {}, ck)).status, 200);
assert.ok(!m.has("user:2023000000"));
console.log("self-test passed");
