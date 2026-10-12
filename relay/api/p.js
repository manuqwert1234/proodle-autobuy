// Mumbai relay. Proodle only answers Indian IP addresses, and Cloudflare's scheduled runs look like the USA,
// so the Worker sends its Proodle requests through this function (pinned to bom1 in vercel.json).
// Only forwards to Proodle's /api/*, and only with the shared key.
const BASE = "https://vit-proodle.expertsoftsys.com";

export default async function handler(req, res) {
  if (req.method !== "POST" || !process.env.RELAY_KEY || req.headers["x-relay-key"] !== process.env.RELAY_KEY)
    return res.status(404).end();
  const { path, query, body, where } = req.body || {};
  if (where) { // diagnostic: where Cloudflare thinks this relay is
    const t = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
    return res.status(200).send((t.match(/(colo|loc)=\w+/g) || []).join(" "));
  }
  if (!/^\/api\/[A-Za-z]+$/.test(path || "")) return res.status(400).end();
  const init = { headers: { "Content-Type": "application/json; charset=utf-8", "User-Agent": "Mozilla/5.0" } };
  if (body !== undefined) Object.assign(init, { method: "POST", body: JSON.stringify(body) });
  const r = await fetch(BASE + path + (query ? "?" + new URLSearchParams(query) : ""), init);
  res.status(r.status).setHeader("Content-Type", "text/plain; charset=utf-8").send(await r.text());
}
