/**
 * Pembentuk & pembacaan plist untuk AirPlay Mirroring (AirPlay 1 / RAOP).
 *
 * Berbeda dari HLS yang hanya butuh POST /play, mirroring butuh negosiasi
 * dua tahap:
 *
 *   POST /setup  -> receiver membalas dengan port-port UDP yang harus dipakai
 *                   (eventPort, timingPort) sekaligus tetap hidup
 *   POST /play   -> receiver membuka parser video dan siap menerima RTP
 *
 * Semua detail protocol yang BERGANTUNG pada firmware dikumpulkan di satu
 * tempat (MIRROR_DEFAULTS) supaya kalau ternyata receiver menolak, yang
 * perlu diubah adalah konstanta - bukan logika di seluruh modul.
 *
 * Modul ini murni membangun/membaca byte - tidak menyentuh socket, sehingga
 * seluruh struktur bisa diuji tanpa perangkat.
 */

const bplistCreator = require('bplist-creator');
const { parseBuffer: parseBplist } = require('bplist-parser');

const BPLIST = 'application/x-apple-binary-plist';

/**
 * Nilai default untuk negosiasi mirroring.
 *
 * CATATAN KEAKHLIAN: angka-angka ini adalah titik yang paling mungkin meleset
 * terhadap firmware tertentu. Semuanya sengaja dikumpulkan di sini agar
 * penyesuaian cukup dilakukan di satu blok, bukan di beberapa file.
 */
const MIRROR_DEFAULTS = {
  // Ukuran layar yang dikirim ke receiver. Receiver memakai ini untuk
  // menyiapkan decoder-nya, bukan untuk membatasi dpi.
  width: 1920,
  height: 1080,
  fps: 30,

  // 'timing' diaktifkan agar receiver menyinkronkan clock ke pengirim lewat
  // kanal timing. Tanpa ini, video bisa terlihat "kaku" dan audio/visual
  // tidak sinkron.
  timing: true,

  // Mode enkripsi payload. 'cbc' dan 'cfb' keduanya didukung; mana yang
  // dipakai receiver harus dipastikan lewat uji perangkat.
  cipherMode: 'cbc',

  // Pemb.padding FairPlay (PKCS#1 v1.5) dipakai sebagian firmware lama.
  // Dimatikan secara default karena OAEP-SHA1 lebih umum pada AirPlay modern.
  rsaPkcs1Padding: false,
};

/** UUID v4 dalam format yang diminta AirPlay (8-4-4-4-12 huruf besar). */
function makeDeviceId(randomBytes) {
  const b = randomBytes;
  const hex = (start, len) => b.subarray(start, start + len).toString('hex').toUpperCase();
  return `${hex(0, 4)}-${hex(4, 2)}-${hex(6, 2)}-${hex(8, 2)}-${hex(10, 6)}`;
}

/** Bangun binary plist dari objek biasa. */
function buildPlist(dictionary) {
  return bplistCreator(dictionary);
}

/** Baca binary plist; selalu mengembalikan objek (tidak pernah melempar). */
function readPlist(buffer) {
  if (!buffer || !buffer.length) return {};
  try {
    const parsed = parseBplist(buffer);
    return Array.isArray(parsed) ? parsed[0] || {} : parsed || {};
  } catch {
    return {};
  }
}

/**
 * Body untuk POST /setup.
 *
 * Field kunci:
 *   deviceID    - identitas sender, dipakai receiver untuk pencatatan log
 *   sessionUUID- unik per sesi mirroring
 *   timing     - aktifkan kanal sinkronisasi waktu
 *   key        - (key || iv) terenkripsi RSA untuk public key receiver
 */
function buildSetupPlist({ deviceId, sessionUuid, sessionKey, timing = true }) {
  if (!deviceId) throw new Error('deviceId wajib diisi');
  if (!sessionUuid) throw new Error('sessionUuid wajib diisi');
  if (!sessionKey) throw new Error('sessionKey wajib diisi (hasil createFairPlaySessionKey)');

  const plist = {
    deviceID: deviceId,
    sessionUUID: sessionUuid,
    timing: timing ? 1 : 0,
    // Base64 dari RSA(sessionKey || iv). Receiver membukanya dengan private
    // key-nya sendiri lalu memakainya untuk mendekripsi payload video.
    key: sessionKey.keyField,
  };
  return buildPlist(plist);
}

/**
 * Body untuk POST /play.
 *
 * Mirror berbeda dari HLS: tidak ada Content-Location. Alih-alih, receiver
 * diberi tahu parameter video lalu HANYA menunggu paket UDP yang kita kirim
 * ke port-port yang dikembalikan /setup.
 */
function buildPlayPlist({
  deviceId,
  sessionUuid,
  width = MIRROR_DEFAULTS.width,
  height = MIRROR_DEFAULTS.height,
  fps = MIRROR_DEFAULTS.fps,
  timing = MIRROR_DEFAULTS.timing,
} = {}) {
  if (!deviceId) throw new Error('deviceId wajib diisi');
  if (!sessionUuid) throw new Error('sessionUuid wajib diisi');

  return buildPlist({
    deviceID: deviceId,
    sessionUUID: sessionUuid,
    timing: timing ? 1 : 0,
    fps: String(fps),
    width: String(width),
    height: String(height),
  });
}

/**
 * Baca header balasan /setup untuk menemukan port-port yang diminta receiver.
 *
 * Receiver AirPlay 1 biasanya membalas dengan:
 *   EventPort   - tempat kita mengirim event ke receiver
 *   TimingPort  - kanal sinkronisasi waktu
 *   atau beberapa header X-Apple-* untuk berbagai varian firmware.
 *
 * Fungsi ini sengaja defensif: nama header berubah antar firmware, jadi
 * semua kunci dinormalisasi (huruf kecil, '-' dan '_' diseragamkan) sebelum
 * dicocokkan, dan port yang hilang tidak dianggap error fatal - pemanggil
 * yang memutuskan fallback-nya.
 */
function readNegotiatedPorts(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase().replace(/[-_]/g, '')] = value;
  }
  const pick = (...candidates) => {
    for (const name of candidates) {
      const value = normalized[name.toLowerCase().replace(/[-_]/g, '')];
      if (value !== undefined && value !== '' && Number.isFinite(Number(value))) {
        return Number(value);
      }
    }
    return null;
  };

  return {
    eventPort: pick('eventPort', 'Event-Port', 'x-apple-eventport'),
    timingPort: pick('timingPort', 'Timing-Port', 'x-apple-timingport'),
    controlPort: pick('controlPort', 'Control-Port'),
  };
}

/** Gabungkan opsi pengguna dengan default modul. */
function resolveMirrorOptions(options = {}) {
  return { ...MIRROR_DEFAULTS, ...options };
}

module.exports = {
  BPLIST,
  MIRROR_DEFAULTS,
  makeDeviceId,
  buildPlist,
  readPlist,
  buildSetupPlist,
  buildPlayPlist,
  readNegotiatedPorts,
  resolveMirrorOptions,
};
