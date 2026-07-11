// Shopee Account Checker — microservice terpisah.
//
// Cara kerja: Playwright buka halaman Shopee (reset password / phone flow),
// biarkan JS SDK Shopee init & generate signature anti-bot (x-sap-sec dkk),
// lalu panggil endpoint check_account_exist DARI DALAM konteks halaman
// (page.evaluate + fetch) supaya interceptor Shopee otomatis nyuntik header valid.
//
// Kita TIDAK reverse-engineer signature — SDK Shopee sendiri yang bikin.

import express from "express";
import { chromium } from "playwright";

// ==================== Config ====================
const PORT = Number(process.env.PORT) || 4100;
const API_KEY = process.env.API_KEY || ""; // WAJIB set di production
const SHOPEE_URL =
  process.env.SHOPEE_URL || "https://shopee.co.id/buyer/reset?scenario=7";
const CHECK_ENDPOINT =
  "https://shopee.co.id/api/v4/account/basic/check_account_exist";
const HEADLESS = process.env.HEADLESS !== "false";
// Refresh halaman tiap N cek biar signature/session tetap fresh.
const MAX_CHECKS_BEFORE_REFRESH = Number(process.env.MAX_CHECKS_BEFORE_REFRESH) || 40;
// Kode error anti-bot Shopee (signature invalid/expired).
const ANTIBOT_ERROR = 90309999;

// ==================== Browser manager ====================
class ShopeeBrowser {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.ready = false;
    this.checksSinceRefresh = 0;
    this.initPromise = null;
  }

  async ensureReady() {
    if (this.ready && this.page && !this.page.isClosed()) return;
    if (!this.initPromise) this.initPromise = this._init();
    await this.initPromise;
  }

  async _init() {
    try {
      await this._teardown();
      console.log("[browser] launching chromium...");
      this.browser = await chromium.launch({
        headless: HEADLESS,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
        ],
      });
      this.context = await this.browser.newContext({
        locale: "id-ID",
        timezoneId: "Asia/Jakarta",
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
        viewport: { width: 1366, height: 768 },
      });
      this.page = await this.context.newPage();
      await this._loadShopee();
      this.ready = true;
      this.checksSinceRefresh = 0;
      console.log("[browser] ready");
    } catch (err) {
      console.error("[browser] init failed:", err.message);
      this.ready = false;
      throw err;
    } finally {
      this.initPromise = null;
    }
  }

  async _loadShopee() {
    console.log("[browser] navigating to Shopee...");
    await this.page.goto(SHOPEE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    // Kasih waktu SDK anti-bot init (generate token device).
    await this.page.waitForTimeout(4000);
  }

  async refresh() {
    try {
      await this._loadShopee();
      this.checksSinceRefresh = 0;
    } catch (err) {
      console.error("[browser] refresh failed, full reinit:", err.message);
      this.ready = false;
      await this.ensureReady();
    }
  }

  async _teardown() {
    try { if (this.page && !this.page.isClosed()) await this.page.close(); } catch {}
    try { if (this.context) await this.context.close(); } catch {}
    try { if (this.browser) await this.browser.close(); } catch {}
    this.page = null;
    this.context = null;
    this.browser = null;
    this.ready = false;
  }

  /** Jalankan check_account_exist DI DALAM konteks halaman Shopee. */
  async _callCheck(phone) {
    return this.page.evaluate(
      async ({ endpoint, phone }) => {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              "x-api-source": "pc",
              "x-shopee-language": "id",
              "x-requested-with": "XMLHttpRequest",
            },
            body: JSON.stringify({ phone, scenario: 2 }),
            credentials: "include",
          });
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch {}
          return { status: res.status, json, text };
        } catch (e) {
          return { status: 0, json: null, text: String(e) };
        }
      },
      { endpoint: CHECK_ENDPOINT, phone }
    );
  }

  async check(phone) {
    await this.ensureReady();

    if (this.checksSinceRefresh >= MAX_CHECKS_BEFORE_REFRESH) {
      await this.refresh();
    }

    let result = await this._callCheck(phone);
    this.checksSinceRefresh++;

    // Kalau kena anti-bot → reload halaman (regenerate signature) & coba sekali lagi.
    if (result.json && result.json.error === ANTIBOT_ERROR) {
      console.warn("[browser] anti-bot hit, reloading & retrying...");
      await this.refresh();
      result = await this._callCheck(phone);
      this.checksSinceRefresh++;
    }

    return result;
  }
}

// ==================== Interpretasi hasil ====================
// Response check_account_exist pakai key numerik yang di-obfuscate.
// Contoh (saat anti-bot): {"5":false,"2":false,"0":2,"3":<err>,"error":<err>,...}
// FIELD MAPPING existence akan difinalisasi setelah dapat response BERSIH pertama
// (error === 0) dari VPS target — bandingkan nomor terdaftar vs tidak.
// Sementara: return raw + tebakan best-effort.
function interpret(json) {
  if (!json) return { registered: null, code: null };
  const code = typeof json.error === "number" ? json.error : null;
  if (code === ANTIBOT_ERROR) return { registered: null, code, blocked: true };
  if (code !== 0 && code !== null) return { registered: null, code };

  // TODO: kunci mapping setelah lihat response bersih pertama.
  // Kandidat field boolean existence: json["2"] atau json["5"].
  const guess =
    typeof json["2"] === "boolean" ? json["2"] :
    typeof json["5"] === "boolean" ? json["5"] : null;
  return { registered: guess, code };
}

// ==================== HTTP API ====================
const shopee = new ShopeeBrowser();

// Antrian serial — 1 page, 1 cek dalam satu waktu.
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function normalizePhone(raw) {
  let d = String(raw || "").replace(/[^0-9]/g, "");
  if (d.startsWith("0")) d = "62" + d.slice(1);
  if (d.startsWith("8")) d = "62" + d;
  return d;
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!API_KEY) return next(); // kalau API_KEY kosong (dev), skip auth
  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

app.get("/health", (req, res) => {
  res.json({ ok: true, ready: shopee.ready, checks: shopee.checksSinceRefresh });
});

app.get("/check", async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (phone.length < 9) {
    return res.status(400).json({ error: "Nomor tidak valid" });
  }
  try {
    const result = await enqueue(() => shopee.check(phone));
    const { registered, code, blocked } = interpret(result.json);
    res.json({
      phone,
      registered,
      code,
      blocked: !!blocked,
      httpStatus: result.status,
      raw: result.json ?? result.text,
    });
  } catch (err) {
    console.error("[check] error:", err.message);
    res.status(500).json({ error: "Gagal cek nomor", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[server] shopee-checker listening on :${PORT}`);
  // Warm-up browser di background.
  shopee.ensureReady().catch((e) => console.error("[server] warmup failed:", e.message));
});
