# Proodle auto-buy

Buys your VIT mess food from your Proodle wallet as soon as it is in stock.
Runs on GitHub Actions every 5 minutes (05:30 to 22:30 IST), so your laptop can be off.

## What to buy: edit `rules.json`

```json
[
  {"meal": "Lunch",  "item": "veg meals", "qty": 1},
  {"meal": "Dinner", "item": "chapathi",  "qty": 1}
]
```

- `meal`: Breakfast, Lunch, Snacks or Dinner
- `item`: any part of the item name as it appears on Proodle (not case sensitive)
- `qty`: 1 to 5

Each item is bought at most once a day. Every run prints today's menu, with stock counts, in the Actions log.
Use those names in `rules.json`.

## Login

Repo Settings > Secrets and variables > Actions:

- `PROODLE_REG`: registration / application number
- `PROODLE_PIN`: PIN
- `PROODLE_WPIN`: wallet PIN, only if it differs from the login PIN

## Run it on your own computer instead

`python3 proodle.py`, then open http://localhost:8765. You get a menu, a buy button and auto-buy checkboxes.
`python3 proodle.py test` runs an offline self-check.
