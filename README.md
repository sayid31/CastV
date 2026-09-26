# CastV

Aplikasi desktop untuk menampilkan layar PC ke TV AirPlay atau browser di jaringan lokal.

| | |
| --- | --- |
| **Repository** | https://github.com/sayid31/CastV |
| **Landing page** | https://castv.vercel.app |
| **Download** | https://github.com/sayid31/CastV/releases/latest |

## Struktur halaman

Build ini menghasilkan tiga halaman terpisah:

| Halaman | File | Dipakai siapa |
| --- | --- | --- |
| **Landing page** | `index.html` | Situs publik (deploy ke Vercel) — pengenalan + download |
| **Desktop app** | `app.html` | Jendela Electron di laptop — satu tombol **Share Screen** |
| **Web receiver** | `receiver.html` | HP, tablet, atau Android TV |

Desktop app sengaja dibuat satu layar: tidak ada menu, sidebar, atau halaman tambahan. Satu tombol **Share Screen** adalah satu-satunya aksi utama.

## Menjalankan di Windows

```bash
npm install
npm run dev
```

`npm run dev` akan menjalankan Vite dan membuka jendela CastV di `app.html`. Pastikan Windows Firewall mengizinkan aplikasi pada **Private network** saat diminta.

Alamat lokal saat development:

```text
http://127.0.0.1:5173/            → landing page
http://127.0.0.1:5173/app.html    → desktop app
http://127.0.0.1:5173/receiver.html → web receiver
```

### Share ke TV AirPlay

1. Pastikan TV menyala dan CastV berjalan di laptop.
2. Klik **Share Screen**.
3. Pilih TV AirPlay yang muncul otomatis di dialog perangkat.
4. Pilih layar atau window.
5. Tunggu status **Sedang streaming**.

Tidak ada URL, QR, atau aplikasi CastV yang perlu dibuka di TV. Jalur ini memakai HLS kompatibel dengan AirPlay 1 dan dapat memiliki delay beberapa detik.

### Share ke browser / HP

1. Klik **Share Screen** di CastV.
2. Di perangkat kedua, buka `http://<IP-LAN-PC>:43117/receiver.html`.
3. Browser akan muncul otomatis di dialog **Pilih perangkat receiver**.
4. Pilih device, lalu klik **Lanjut pilih layar**.

Browser receiver masih harus membuka halaman receiver terlebih dahulu agar dapat terlihat oleh CastV. Untuk TV AirPlay, CastV melakukan discovery langsung melalui mDNS.

## Deteksi receiver bawaan (AirPlay/Google Cast)

Untuk memeriksa TV yang tidak membutuhkan CastV receiver, jalankan:

```bash
npm run discover:cast
```

Scan mencari service mDNS `_airplay._tcp`, `_raop._tcp`, `_googlecast._tcp`, dan DLNA. Tambahkan `--probe-airplay` untuk melakukan probe `/info` pada device AirPlay:

```bash
node scripts/discover-devices.cjs --probe-airplay
```

Xiaomi TV yang mendukung AirPlay akan muncul sebagai `AirPlay`/`RAOP` bersama hostname, IP, dan port. Jalur ini tidak memerlukan URL, QR, atau aplikasi CastV di TV.

## Android TV receiver

Target utama berikutnya adalah Android TV / Google TV. Receiver native sekarang memakai UDP discovery di port `43118`, lalu membuka halaman receiver CastV secara internal—jadi tidak perlu lagi menyalin URL atau scan QR.

Build APK debug di Windows:

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
.\android-tv\gradlew.bat -p android-tv assembleDebug --no-daemon
```

APK hasil build:

```text
android-tv/app/build/outputs/apk/debug/app-debug.apk
```

Salinan APK siap pakai juga tersedia di:

```text
android-tv/CastV-TV-debug.apk
```

Pasang ke Android TV/ emulator dengan:

```powershell
adb install -r android-tv/app/build/outputs/apk/debug/app-debug.apk
```

Saat CastV berjalan di PC dan TV berada pada Wi-Fi yang sama, aplikasi TV akan mencari sender secara otomatis. Kolom IP manual tetap tersedia jika administrator jaringan memblokir broadcast UDP.

## Build installer Windows

Untuk membuat installer yang bisa dipakai laptop lain:

```bash
npm run dist
```

File hasil berada di:

```text
release/CastV-0.1.0-x64.exe
release/CastV-0.1.0-portable.exe
```

- File `x64.exe` adalah installer NSIS.
- File `portable.exe` bisa dijalankan tanpa instalasi.
- Untuk build tanpa installer, gunakan `npm run dist:dir`.

Installer sudah membawa Vite build, Electron main process, server lokal, dan dependency production. Pengguna laptop lain hanya perlu menjalankan CastV; tidak perlu clone repository atau `npm install`. Jalankan `CastV-0.1.0-x64.exe` untuk instalasi, atau `CastV-0.1.0-portable.exe` tanpa instalasi. Pastikan Windows Firewall mengizinkan CastV pada **Private network** saat pertama kali dibuka.

Karena installer MVP belum ditandatangani secara code-sign, Windows SmartScreen dapat menampilkan peringatan. Untuk penggunaan internal, pilih **More info → Run anyway**; untuk distribusi publik, tambahkan code-signing certificate.

## Landing page publik

Landing page ada di `index.html` dan di-build sebagai static site untuk Vercel. Config deploy sudah tersedia di `vercel.json` (build command `npm run build`, output `dist`).

### Konsep distribusi installer

Installer (`.exe`, ±107 MB) **tidak** di-host di Vercel karena limit static file upload Hobby hanya 100 MB. Sebagai gantinya:

```
Landing page (Vercel)  →  tombol download
        ↓
GitHub Release         →  file CastV-x64.exe & CastV-portable.exe
```

Link download memakai pola stabil `releases/latest/download/<nama-file>` yang selalu menunjuk release terbaru, jadi tidak perlu diubah tiap versi. Repo & release harus **public** agar link bisa diakses orang banyak.

> Source code juga menjadi publik karena repo-nya public. Kalau nanti butuh kode tetap private, pindahkan file installer ke layanan file storage terpisah dan ganti `DOWNLOAD` di `src/landing.tsx`.

### Menerbitkan release baru

Nomor versi dibaca dari satu sumber: `package.json`. Workflow otomatis mengambilnya dari tag Git.

```bash
# 1. bump versi
npm version 0.2.0        # menulis package.json + package-lock.json

# 2. commit & push
git add -A
git commit -m "release: v0.2.0"
git push

# 3. buat tag -> memicu workflow Release otomatis
git tag v0.2.0
git push origin v0.2.0
```

GitHub Actions (`release.yml`) lalu otomatis:

1. Membaca versi dari tag (`v0.2.0` → `0.2.0`) dan menyinkronkan `package.json`
2. Build frontend + installer Windows (`npm run dist`)
3. Verifikasi kedua file `.exe` benar-benar ada
4. Membuat GitHub Release beserta asset-nya
5. Upload artifact ke workflow run

Karena versi ikut di-*inject* ke landing page saat build, nama file di release selalu cocok dengan link download — tidak ada yang perlu diedit manual.

> `npm version 0.2.0` sudah membuat commit **dan** tag secara otomatis,
> jadi cukup `git push && git push --follow-tags`.

### Workflow yang tersedia

| File | Trigger | Fungsi |
| --- | --- | --- |
| `.github/workflows/ci.yml` | push / pull request | Typecheck, build, dan package installer sebagai artifact |
| `.github/workflows/release.yml` | push tag `v*` | Build + publikasi GitHub Release |

### Code signing (opsional)

Installer MVP belum ditandatangani. Untuk menandatangani, tambahkan repository secrets:

| Secret | Isi |
| --- | --- |
| `CSC_LINK` | Path ke file `.pfx` (base64) atau URL ke sertifikat |
| `CSC_KEY_PASSWORD` | Password sertifikat |

Kalau secret tersebut belum diisi, build tetap berjalan dan menghasilkan installer unsigned.

### Deploy landing page ke Vercel

Dua cara:

1. **Git integration (disarankan, tanpa secret)** — connect repo `sayid31/CastV` di dashboard Vercel dengan branch `master`. Setiap push otomatis deploy.
2. **Vercel CLI dari lokal** — `vercel --prod --yes --name castv`

Config build sudah tersimpan di `vercel.json`, dan `.vercelignore` memastikan installer `.exe` tidak ikut ter-upload.

### Script sinkronisasi installer (opsional)

`npm run downloads:sync` menyalin installer dari `release/` ke `public/downloads/` untuk testing lokal landing page dengan file self-hosted. Folder ini tidak di-*commit* dan tidak ikut ke deployment Vercel maupun paket installer aplikasi.

## Menjalankan versi web saja

```bash
npm run web
```

Perintah ini membangun frontend dan menjalankan signaling/static server tanpa Electron. Untuk demo desktop, `npm run dev` adalah opsi yang lebih lengkap.

Untuk build produksi lokal:

```bash
npm start
```

## Arsitektur MVP

```text
Electron renderer
  ├─ getDisplayMedia() → WebRTC → browser receiver
  └─ getDisplayMedia() → H.264/fMP4 → local HLS → AirPlay TV

Electron main process
  ├─ local HTTP/WebSocket server (port 43117)
  ├─ mDNS AirPlay/Google Cast discovery
  └─ AirPlay /play client
```

- Room code acak 6 karakter.
- Token viewer acak 32 byte disimpan pada URL fragment, bukan query string.
- Satu sender dan satu receiver per room.
- ICE lokal tanpa STUN/TURN untuk MVP.
- Preview lokal tidak disimpan atau direkam.
- Desktop menampilkan source picker CastV sendiri dengan thumbnail layar/window, bukan dialog native Windows.

## Batasan yang diketahui

- Installer Windows tersedia melalui `npm run dist`, tetapi belum ditandatangani secara kriptografi (code-sign) dan belum dipublikasi ke storefront. Untuk MVP, jalankan installer atau build dari source.
- Mode ini memakai HTTP lokal. Untuk distribusi ke jaringan publik, tambahkan HTTPS/WSS dan certificate trust strategy.
- Jalur AirPlay HLS berada di atas HTTP lokal dan biasanya memiliki delay beberapa detik; ini bukan mirroring real-time.
- Jalur AirPlay saat ini mengirim video saja. Audio sistem belum ikut dimux ke HLS.
- Audio pada WebRTC/browser mengikuti Chromium, OS, dan sumber capture. Jika system audio tidak tersedia, video tetap dapat dikirim.
- Wi-Fi dengan client isolation, VPN, atau firewall ketat dapat menghalangi WebRTC. TURN/relay adalah tahap berikutnya.
- QR code dibuat langsung oleh CastV; gunakan kamera HP atau pemindai QR browser.

## Struktur

```text
electron/       Electron main process
server/         HTTP static server + WebSocket signaling + UDP discovery
src/            React sender and receiver pages
android-tv/     Native Android TV receiver (WebView + UDP discovery)
```
