# Proodle auto-buy

A faster front end for VIT Proodle. Sign in with your registration number and PIN, see today's
breakfast, lunch, snacks and dinner with live stock, buy in one tap, or tick items to
**auto-buy the moment they are in stock**.

Runs free on Cloudflare Workers. A 1-minute schedule (05:30 to 22:30 IST) does the auto-buying,
so your phone and laptop can be off.

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
