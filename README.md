# Shopee Account Checker

Microservice terpisah buat cek status akun Shopee (terdaftar / tidak terdaftar) dari sebuah nomor HP.
Dipakai oleh web utama (KirimKode) lewat HTTP, **deploy di VPS sendiri** (bukan di VPS web utama).

## Kenapa terpisah?

Cek Shopee butuh signature anti-bot (`x-sap-sec` dkk) yang cuma bisa di-generate oleh JS SDK Shopee
di browser. Jadi service ini pakai **Playwright (headless Chromium)**: buka halaman Shopee, biarkan
SDK-nya init, lalu panggil `check_account_exist` dari dalam konteks halaman. Chromium makan RAM cukup
besar, makanya dipisah dari web utama.

## Cara kerja singkat

1. Playwright buka `https://shopee.co.id/buyer/reset?scenario=7`.
2. SDK Shopee generate token device + signature otomatis.
3. Service panggil `POST /api/v4/account/basic/check_account_exist` dari dalam page (`page.evaluate` +
   `fetch` dengan `credentials: include`) → Shopee nyuntik header anti-bot valid sendiri.
4. Kalau kena error anti-bot (`90309999`), halaman di-reload buat regenerate signature, lalu retry.

## Setup (di VPS checker)

```bash
npm install
npm run install-browser      # download chromium
npm run install-deps         # install lib OS buat chromium (butuh sudo di Ubuntu)
cp .env.example .env         # isi API_KEY
node server.mjs              # atau pakai pm2: pm2 start server.mjs --name shopee-checker
```

## API

### `GET /health`
Cek status service + browser.

### `GET /check?phone=628xxxxxxxxxx`
Header: `x-api-key: <API_KEY>`

Response:
```json
{
  "phone": "6281234567890",
  "registered": true,
  "code": 0,
  "blocked": false,
  "httpStatus": 200,
  "raw": { ... }
}
```

- `registered`: `true`/`false` = terdaftar / tidak. `null` = belum bisa dipastikan (lihat `blocked`/`code`).
- `blocked`: `true` kalau kena anti-bot Shopee (signature ditolak).
- `raw`: response mentah Shopee (buat debug + finalisasi mapping field).

## ⚠️ Yang MASIH perlu difinalisasi

Response Shopee pakai key numerik ter-obfuscate. Contoh saat ditolak anti-bot:
`{"5":false,"2":false,"0":2,"3":90309999,"error":90309999,...}`.

Field mana yang nunjukin "terdaftar/tidak" **belum dikunci** karena butuh response BERSIH
(`error: 0`) dari VPS asli. Setelah service jalan di VPS:

1. Cek satu nomor yang PASTI terdaftar dan satu yang PASTI belum.
2. Bandingkan `raw`-nya → lihat field boolean mana yang beda.
3. Update fungsi `interpret()` di `server.mjs` (lihat komentar `TODO`).

## Integrasi ke web utama

Di web utama, panggil service ini pas ada order layanan Shopee:
```
GET http://<IP_VPS_CHECKER>:4100/check?phone=<nomor>
Header: x-api-key: <API_KEY>
```
Simpan hasilnya di order, tampilkan di kartu order user.

## Pindah ke repo sendiri

Folder ini sengaja di-`.gitignore` dari repo web utama. Buat deploy:
```bash
# copy folder ini keluar, init repo baru
git init && git add -A && git commit -m "init shopee-checker"
```
