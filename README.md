# Proodle auto-buy

A faster front end for VIT Proodle. Sign in with your registration number and PIN, see today's
breakfast, lunch, snacks and dinner with live stock, buy in one tap, or tick items to
**auto-buy the moment they are in stock**.

Runs free on Cloudflare Workers. Proodle only answers requests that start from a real device in India
(cloud servers and Cloudflare's own scheduler are refused), so the checking is driven by pings to
`/internal/tick?k=<TICK_KEY>` from someone's phone or laptop: iOS Shortcuts automations at meal times,
a laptop, or an old Android phone on charge. Each ping checks every 10 s for ~40 s, for everyone.

- Each auto-buy item is bought at most once a day. Overlapping runs can't double-buy.
- A failed payment (wrong PIN, low balance) stops that item for the day instead of retrying.
- If a payment gets no reply, it is not retried. Check My Orders on Proodle.

## Files

- `worker.js`: the Proodle API client, the auto-buy check and the web routes
- `public/index.html`: the site
- `schema.sql`: the one D1 table
- `test.mjs`: offline self-check with a fake Proodle (`npm test`)

## Deploy your own

```
npm install
npx wrangler login
npx wrangler d1 create proodle         # put the printed database_id in wrangler.toml
npx wrangler d1 execute proodle --remote --file schema.sql
npx wrangler deploy
```
