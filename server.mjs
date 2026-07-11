// Shopee Account Checker — microservice terpisah.
//
// Strategi: Playwright buka halaman reset Shopee, JALANKAN UI-nya (ketik nomor,
// klik lanjut) supaya JS Shopee sendiri yang nembak `check_account_exist` DENGAN
// signature anti-bot valid. Kita cuma INTERCEPT response-nya.
//
// (Manggil endpoint langsung via fetch di page context TIDAK dapat signature →
//  ditolak 403 error_forbidden / 90309999. Makanya harus lewat UI.)

import express from "express";
import { chromium } from "playwright";

// ==================== Config ====================
const PORT = Number(process.env.PORT) || 4100;
const API_KEY = process.env.API_KEY || "";
const SHOPEE_URL =
  process.env.SHOPEE_URL || "https://shopee.co.id/buyer/reset?scenario=7";
const CHECK_PATH = "/api/v4/account/basic/check_account_exist";
const HEADLESS = process.env.HEADLESS !== "false";
const ANTIBOT_ERROR = 90309999;

// ==================== Browser manager ====================
class ShopeeBrowser {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.ready = false;
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
    await this.page.goto(SHOPEE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await this.page.waitForTimeout(3500);
  }

  async _teardown() {
    try { if (this.page && !this.page.isClosed()) await this.page.close(); } catch {}
    try { if (this.context) await this.context.close(); } catch {}
    try { if (this.browser) await this.browser.close(); } catch {}
    this.page = null; this.context = null; this.browser = null; this.ready = false;
  }

  /** DEBUG: dump semua input & button di halaman reset (buat nyari selector). */
  async inspect() {
    await this.ensureReady();
    await this._loadShopee();
    return this.page.evaluate(() => {
      const inputs = [...document.querySelectorAll("input")].map((el) => ({
        name: el.name || null,
        type: el.type || null,
        placeholder: el.placeholder || null,
        id: el.id || null,
        className: (el.className || "").slice(0, 80),
      }));
      const buttons = [...document.querySelectorAll("button")].map((el) => ({
        text: (el.textContent || "").trim().slice(0, 40),
        type: el.type || null,
        className: (el.className || "").slice(0, 80),
      }));
      return { url: location.href, title: document.title, inputs, buttons };
    });
  }

  /**
   * Cek nomor via UI: ketik nomor -> submit -> intercept response check_account_exist.
   * @param {string} phone  format 62xxxxxxxxxx
   */
  async check(phone) {
    await this.ensureReady();
    const page = this.page;

    // Reload biar form fresh.
    await this._loadShopee();

    // Format nomor untuk field: Shopee ID biasanya prefill +62, jadi ketik tanpa "62".
    const local = phone.replace(/^62/, "");

    // Pasang listener response SEBELUM submit.
    const respPromise = page
      .waitForResponse((r) => r.url().includes(CHECK_PATH), { timeout: 20000 })
      .catch(() => null);

    // Cari input nomor (field text/tel pertama yang visible).
    const input = await page.waitForSelector(
      'input[type="text"], input[type="tel"], input:not([type="hidden"])',
      { timeout: 15000 }
    );
    await input.click();
    await input.fill("");
    await input.type(local, { delay: 30 });
    await page.waitForTimeout(300);

    // Submit: coba Enter dulu, lalu klik tombol utama kalau ada.
    await page.keyboard.press("Enter");
    const btn = await page.$(
      'button[type="submit"], button.btn-solid-primary, button:has-text("BERIKUTNYA"), button:has-text("Berikutnya"), button:has-text("Next")'
    );
    if (btn) { try { await btn.click({ timeout: 3000 }); } catch {} }

    const resp = await respPromise;
    if (!resp) {
      return { status: 0, json: null, text: "check_account_exist tidak terpanggil (cek selector via /inspect)" };
    }
    let json = null, text = "";
    try { json = await resp.json(); } catch { try { text = await resp.text(); } catch {} }
    return { status: resp.status(), json, text };
  }
}

// ==================== Interpretasi hasil ====================
function interpret(json) {
  if (!json) return { registered: null, code: null };
  const code = typeof json.error === "number" ? json.error : null;
  if (code === ANTIBOT_ERROR) return { registered: null, code, blocked: true };
  if (code !== 0 && code !== null) return { registered: null, code };

  // TODO: kunci mapping setelah lihat response bersih (error:0) pertama.
  const guess =
    typeof json["2"] === "boolean" ? json["2"] :
    typeof json["5"] === "boolean" ? json["5"] : null;
  return { registered: guess, code };
}

// ==================== HTTP API ====================
const shopee = new ShopeeBrowser();

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
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

app.get("/health", (req, res) => {
  res.json({ ok: true, ready: shopee.ready });
});

// DEBUG: lihat struktur form reset (buat nyari selector).
app.get("/inspect", async (req, res) => {
  try {
    const info = await enqueue(() => shopee.inspect());
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/check", async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (phone.length < 9) return res.status(400).json({ error: "Nomor tidak valid" });
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
  shopee.ensureReady().catch((e) => console.error("[server] warmup failed:", e.message));
});
