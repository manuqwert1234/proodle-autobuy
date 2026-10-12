#!/usr/bin/env python3
"""VIT Proodle auto-buyer.

Log in with registration number + PIN, see today's menu with live stock,
buy in one tap, or set items to auto-buy the moment they come in stock.

Local:  python3 proodle.py         then open http://localhost:8765
Test:   python3 proodle.py test    (offline self-check, no real orders)
Online: GitHub Actions runs `python3 proodle.py actions` every 5 minutes
        (secrets PROODLE_REG / PROODLE_PIN, wanted items in rules.json).
"""
import datetime, json, os, secrets, ssl, sys, threading, time, traceback, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = "https://vit-proodle.expertsoftsys.com"
HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "proodle-data.json")
POLL = 60  # seconds between stock checks
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
MEALS = {1: "Breakfast", 2: "Lunch", 3: "Snacks", 4: "Dinner"}
WEEKDAYS = ["", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
PAY_ERR = {"2": "Insufficient wallet balance", "3": "Card expired", "4": "Card inactive",
           "5": "Invalid card", "6": "Wrong wallet PIN", "9": "Out of stock"}

CAFILE = "/etc/ssl/cert.pem" if os.path.exists("/etc/ssl/cert.pem") else None
SSL = ssl.create_default_context(cafile=CAFILE)
lock = threading.RLock()


class Err(Exception):
    def __init__(self, msg, retry=False):
        super().__init__(msg)
        self.retry = retry  # True = worth trying again next poll


# ---------- storage ----------

def load():
    try:
        with open(DB_PATH) as f:
            return json.load(f)
    except FileNotFoundError:
        return {"users": {}, "tokens": {}}

def save(d):
    tmp = DB_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, indent=1)
    os.chmod(tmp, 0o600)  # holds PINs
    os.replace(tmp, DB_PATH)

db = {"users": {}, "tokens": {}}

def mutate(fn):
    """Re-read, change, write. Keeps edits from the site and the auto-buy run from overwriting each other."""
    global db
    with lock:
        db = load()
        fn(db)
        save(db)

def update(reg, fn):
    mutate(lambda d: reg in d["users"] and fn(d["users"][reg]))

def note(u, msg):
    u.setdefault("log", []).insert(0, datetime.datetime.now(IST).strftime("%d %b %H:%M  ") + msg)
    del u["log"][50:]


# ---------- Proodle API ----------

def call(path, body=None, query=None):
    url = BASE + path + ("?" + urllib.parse.urlencode(query) if query else "")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/json; charset=utf-8", "User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20, context=SSL) as r:
        out = json.loads(r.read().decode("utf-8-sig") or '""')
    while isinstance(out, str) and out[:1] in "[{":  # some endpoints double-encode
        out = json.loads(out)
    return out

def today():
    d = datetime.datetime.now(IST).date()
    return d.isoformat(), f"{d.day:02d}-{MONTHS[d.month - 1]}-{d.year}", d.isoweekday()

def login(u):
    for _ in range(2):
        r = call("/api/GetOTPChecking", {"MobileNo": u["reg"], "OtpNo": u["pin"]})
        if not isinstance(r, list) or not r:
            raise Err("Login failed")
        row = r[0]
        st = str(row.get("OtpSts", "")).split("|")
        if st[0] == "Success":
            u["s"] = s = {"P1": u["reg"], "P2": row["ouid"], "P5": st[5], "P6": st[6],
                          "P9": row["ctrid"], "P10": row["logid"]}
            update(u["reg"], lambda x: x.__setitem__("s", s))  # reuse it, so we don't re-login every minute
            return s
        if st[0] == "duplicate":  # same as the site's "close the other session? Yes"
            call("/api/ulogout", {"mobno": st[6]})
            continue
        raise Err("Wrong registration number or PIN")
    raise Err("Could not close your other Proodle session")

def session(u, fresh=False):
    s = u.get("s")
    if s and fresh:
        try:
            alive = str(call("/api/chkuserstat", {"mobno": s["P6"], "logid": s["P10"]})) != "0"
        except Exception:
            alive = False
        if not alive:
            s = None
    return s or login(u)

def raw_menu(u, meal):
    s = session(u)
    _, odt, wd = today()
    r = call("/api/GetOptionMenuItems", {"DocumentNo": str(wd), "SessionNo": str(meal), "mobno": s["P6"],
                                         "flg": "2", "oid": s["P2"], "odt": odt})
    return r if isinstance(r, list) else []

def stock(p):
    try:
        return int(float(p.get("StockQty") or 0))
    except ValueError:
        return 0

def menu(u, meal):
    return [{"id": str(p["meitid"]), "name": p["meitdes"], "price": float(p["retrt"]),
             "stock": stock(p), "info": p.get("dispname") or ""} for p in raw_menu(u, meal)]

def balance(u):
    r = call("/api/getstudWBalinfo", query={"rno": u["reg"]})
    return float(r[0]["bal"]) if isinstance(r, list) and r else None

def cart_item(p, qty, odt, wd):
    rt = float(p["retrt"])
    return {"productId": f'{p["skuid"]}_{p["meitid"]}_{p["tb"]}', "quantity": qty, "ides": p["meitdes"],
            "rt": rt, "amt": qty * rt, "tp": p.get("type"), "odt": odt, "odtdes": WEEKDAYS[wd],
            "tb": int(p["tb"]), "pid": str(p["meitid"]), "dtstr": odt, "ldes": p.get("dispname"),
            "cal": p.get("itmsdes"), "sname": p.get("odtdes"), "skid": str(p["skuid"]), "flag": 1, "optcls": ""}

def buy(u, meal, item_id, qty):
    """Same steps as the site: order id -> GST -> insert cart -> wallet pay. Returns a receipt string."""
    s = session(u, fresh=True)
    p = next((p for p in raw_menu(u, meal) if str(p["meitid"]) == str(item_id)), None)
    if not p:
        raise Err("Item not on today's menu", retry=True)
    if stock(p) < qty:
        raise Err("Not in stock yet", retry=True)
    _, odt, wd = today()
    items = [cart_item(p, qty, odt, wd)]
    gross = sum(i["amt"] for i in items)
    gst = call("/api/getexgstval", query={"ouid": s["P2"], "pids": ",".join(i["pid"] for i in items),
                                          "qtys": ",".join(str(i["quantity"]) for i in items)})
    net = f"{gross + float(gst or 0):.2f}"
    ids = call("/api/GetOrderIdDetails", {"MobileNo": s["P6"], "TableNo": "1"})
    order = ids[0]["OrderNo"]
    if str(call("/api/GetOutletListInsert", {"items": items, "OrderNumber": order, "TableNo": "1",
                                              "ItemTotal": net, "OutLetId": s["P2"], "MobileNo": s["P6"],
                                              "RefNo": s["P9"]})) != "1":
        raise Err("Proodle refused the order", retry=True)
    try:
        r = str(call("/api/OnlineWPayment", {"MobileNo": s["P6"], "OrderNumber": order, "OrderAmount": net,
                                             "ouid": s["P2"], "Otp": u.get("wpin") or u["pin"], "p1": s["P1"]}))
    except Exception:
        # payment may or may not have gone through: never retry blindly (no double buys)
        raise Err(f"No reply from payment for order {order}. Check My Orders on Proodle.")
    code, _, bill = r.partition("|")
    if code == "1":
        return f"{qty} x {p['meitdes']}, Rs {net}, bill {bill}"
    raise Err(PAY_ERR.get(code, f"Order {order} not processed ({r})"), retry=(code == "9"))


# ---------- auto-buy check ----------

def watch_once():
    day, _, _ = today()
    for reg in list(load()["users"]):
        for rule in load()["users"].get(reg, {}).get("rules", []):
            u = load()["users"].get(reg)  # fresh copy before every buy: never act on a stale "not done"
            key = f'{rule["meal"]}:{rule["id"]}'
            if not u or rule not in u.get("rules", []) or key in u.get("done", {}).get(day, []):
                continue
            try:
                receipt = buy(u, rule["meal"], rule["id"], int(rule.get("qty", 1)))
                msg, finished = f"AUTO-BOUGHT {MEALS[int(rule['meal'])]}: {receipt}", True
            except Err as e:
                msg = None if e.retry else f"Auto-buy {rule['name']} stopped for today: {e}"
                finished = not e.retry
            except Exception as e:
                msg, finished = None, False
                print("watch error:", e, file=sys.stderr)
            if finished or msg:
                def rec(x):
                    if finished:
                        done = x.setdefault("done", {})
                        done.setdefault(day, []).append(key)
                        for old in [k for k in done if k != day]:
                            del done[old]
                    if msg:
                        note(x, msg)
                update(reg, rec)

def watcher():
    while True:
        try:
            watch_once()
        except Exception:
            traceback.print_exc()
        time.sleep(POLL)


# ---------- web routes ----------

def handle(method, path, q, cookie):
    """Returns (status, body, content_type, set_cookie_or_None)."""
    if method == "GET" and path == "/":
        with open(os.path.join(HERE, "index.html"), encoding="utf-8") as f:
            return 200, f.read(), "text/html; charset=utf-8", None
    try:
        if path == "/api/login":
            reg, pin = str(q.get("reg", "")).strip(), str(q.get("pin", "")).strip()
            if not (reg.isdigit() and pin.isdigit()):
                return 400, {"error": "Enter your registration number and PIN"}, None, None
            u = dict(load()["users"].get(reg) or {"reg": reg, "rules": [], "log": []})
            u.update(pin=pin, wpin=str(q.get("wpin", "")).strip())
            u.pop("s", None)
            login(u)
            tok = secrets.token_urlsafe(24)
            def add(d):
                d["users"][reg] = {**d["users"].get(reg, {}), **u}
                d["tokens"][tok] = reg
            mutate(add)
            return 200, {"ok": True}, None, f"pt={tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000"

        tok = next((v for k, _, v in (p.strip().partition("=") for p in cookie.split(";")) if k == "pt"), "")
        reg = db["tokens"].get(tok)
        u = db["users"].get(reg) if reg else None
        if not u:
            return 401, {"error": "Not logged in"}, None, None

        if path == "/api/state":
            return 200, {"name": u.get("s", {}).get("P5", u["reg"]), "reg": u["reg"], "balance": balance(u),
                         "rules": u.get("rules", []), "log": u.get("log", []), "meals": MEALS, "poll": POLL}, None, None
        if path == "/api/menu":
            return 200, menu(u, int(q.get("meal", 1))), None, None
        if path == "/api/buy":
            receipt = buy(u, int(q["meal"]), q["id"], max(1, int(q.get("qty", 1))))
            update(reg, lambda x: note(x, f"Bought {MEALS[int(q['meal'])]}: {receipt}"))
            return 200, {"ok": True, "receipt": receipt}, None, None
        if path == "/api/rules":
            rules = [{"meal": int(r["meal"]), "id": str(r["id"]), "name": str(r["name"])[:80],
                      "qty": max(1, min(5, int(r.get("qty", 1))))} for r in q.get("rules", [])]
            update(reg, lambda x: x.__setitem__("rules", rules))
            return 200, {"ok": True}, None, None
        if path == "/api/forget":  # log out + delete stored PIN and rules
            def forget(d):
                d["users"].pop(reg, None)
                d["tokens"] = {t: r for t, r in d["tokens"].items() if r != reg}
            mutate(forget)
            return 200, {"ok": True}, None, "pt=; Path=/; Max-Age=0"
        return 404, {"error": "Not found"}, None, None
    except Err as e:
        return 400, {"error": str(e)}, None, None
    except Exception as e:
        traceback.print_exc()
        return 502, {"error": f"Proodle error: {e}"}, None, None


class H(BaseHTTPRequestHandler):
    def go(self, method, q):
        global db
        db = load()
        code, out, ctype, cookie = handle(method, urllib.parse.urlparse(self.path).path, q,
                                          self.headers.get("Cookie", ""))
        body = out.encode() if isinstance(out, str) else json.dumps(out).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype or "application/json")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.go("GET", dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query)))

    def do_POST(self):
        try:
            q = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except ValueError:
            q = {}
        self.go("POST", q)

    def log_message(self, *a):
        pass


# ---------- GitHub Actions mode ----------

def actions():
    """One scheduled run: login from secrets, wanted items from rules.json, state kept in .state/ (Actions cache)."""
    global DB_PATH
    DB_PATH = os.path.join(os.environ.get("STATE_DIR", os.path.join(HERE, ".state")), "state.json")
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    reg = os.environ["PROODLE_REG"].strip()
    with open(os.environ.get("RULES", os.path.join(HERE, "rules.json"))) as f:
        wanted = json.load(f)
    meal_no = {v.lower(): k for k, v in MEALS.items()}
    old_log = load()["users"].get(reg, {}).get("log", [])

    def setup(d):
        u = d["users"].setdefault(reg, {"reg": reg, "log": []})
        u.update(pin=os.environ["PROODLE_PIN"].strip(), wpin=os.environ.get("PROODLE_WPIN", "").strip())
    mutate(setup)
    try:
        rules = []
        print("Today's menu, with stock:")
        for meal, mname in MEALS.items():
            items = raw_menu(load()["users"][reg], meal)
            print(f"  {mname}: " + (", ".join(f'{p["meitdes"]} ({stock(p)})' for p in items) or "nothing listed"))
            for w in wanted:
                if meal_no.get(str(w.get("meal", "")).strip().lower()) != meal:
                    continue
                p = next((p for p in items if str(w["item"]).strip().lower() in p["meitdes"].lower()), None)
                if p:
                    rules.append({"meal": meal, "id": str(p["meitid"]), "name": p["meitdes"],
                                  "qty": max(1, min(5, int(w.get("qty", 1))))})
        update(reg, lambda x: x.__setitem__("rules", rules))
        watch_once()
        new = [l for l in load()["users"][reg].get("log", []) if l not in old_log]
        print("\n".join(new) or "Nothing to buy right now.")
    finally:
        def scrub(d):  # the cache must never hold the PIN
            d["users"][reg].pop("pin", None)
            d["users"][reg].pop("wpin", None)
        mutate(scrub)


# ---------- offline self-check ----------

def selftest():
    global call, DB_PATH
    import tempfile
    DB_PATH = os.path.join(tempfile.mkdtemp(), "t.json")
    calls, state = [], {"stock": 0, "pay": "1|B42"}
    item = {"meitid": 7, "meitdes": "Veg Meals", "retrt": "60.00", "skuid": 3, "tb": "2", "type": "V",
            "dispname": "Rice, dal", "itmsdes": "", "odtdes": "LUNCH"}

    def fake(path, body=None, query=None):
        calls.append(path)
        if path == "/api/GetOTPChecking":
            return [{"OtpSts": "Success|0|x|x|x|NAME|M123|5", "ouid": 9, "ctrid": 1, "logid": 5}]
        if path == "/api/chkuserstat":
            return 1
        if path == "/api/GetOptionMenuItems":
            return [dict(item, StockQty=state["stock"])]
        if path == "/api/getexgstval":
            return 3
        if path == "/api/GetOrderIdDetails":
            return [{"OrderNo": "O1"}]
        if path == "/api/GetOutletListInsert":
            assert body["items"][0]["productId"] == "3_7_2" and body["ItemTotal"] == "123.00", body
            return "1"
        if path == "/api/OnlineWPayment":
            assert body["Otp"] == "1234" and body["OrderAmount"] == "123.00", body
            return state["pay"]
        if path == "/api/getstudWBalinfo":
            return [{"bal": "500"}]
        raise AssertionError(path)

    call = fake
    # sign in through the real route, then add a rule through the real route
    code, _, _, cookie = handle("POST", "/api/login", {"reg": "2023000000", "pin": "1234"}, "")
    assert code == 200 and cookie, code
    ck = cookie.split(";")[0]
    globals()["db"] = load()
    assert handle("POST", "/api/rules", {"rules": [{"meal": 2, "id": "7", "name": "Veg Meals", "qty": 2}]}, ck)[0] == 200
    logins = calls.count("/api/GetOTPChecking")
    log = lambda: load()["users"]["2023000000"]["log"]

    watch_once()                                   # out of stock: no order, keeps watching
    assert "/api/OnlineWPayment" not in calls and not log()
    state["stock"] = 5
    watch_once()                                   # in stock: buys once
    assert calls.count("/api/OnlineWPayment") == 1 and "AUTO-BOUGHT" in log()[0], log()
    watch_once()                                   # same day: never buys twice
    assert calls.count("/api/OnlineWPayment") == 1
    assert calls.count("/api/GetOTPChecking") == logins  # session reused, no re-login each minute
    update("2023000000", lambda x: x.__setitem__("done", {}))
    state["pay"] = "6|"
    watch_once(); watch_once()                     # wrong PIN: stops for the day, no retry loop
    assert calls.count("/api/OnlineWPayment") == 2 and "Wrong wallet PIN" in log()[0]
    globals()["db"] = load()
    assert handle("GET", "/api/state", {}, ck)[1]["balance"] == 500.0
    assert handle("GET", "/api/state", {}, "pt=nope")[0] == 401

    # GitHub Actions mode: buys by item name, once per day, never stores the PIN
    tmp = tempfile.mkdtemp()
    with open(os.path.join(tmp, "rules.json"), "w") as f:
        json.dump([{"meal": "Lunch", "item": "veg meals", "qty": 2}], f)
    os.environ.update(PROODLE_REG="2023111111", PROODLE_PIN="1234", STATE_DIR=tmp, RULES=os.path.join(tmp, "rules.json"))
    state["pay"], paid = "1|B43", calls.count("/api/OnlineWPayment")
    actions(); actions()
    assert calls.count("/api/OnlineWPayment") == paid + 1
    saved = open(os.path.join(tmp, "state.json")).read()
    assert "1234" not in saved and '"s"' in saved, saved
    print("self-test passed")


if __name__ == "__main__":
    if sys.argv[1:] == ["test"]:
        selftest()
        sys.exit()
    if sys.argv[1:] == ["actions"]:
        actions()
        sys.exit()
    threading.Thread(target=watcher, daemon=True).start()
    host, port = os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", 8765))
    print(f"Proodle auto-buyer on http://{'localhost' if host == '127.0.0.1' else host}:{port}")
    ThreadingHTTPServer((host, port), H).serve_forever()
