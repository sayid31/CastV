/**
 * Enkripsi payload video untuk AirPlay Mirroring (AirPlay 1 / RAOP).
 *
 * Kunci session (16 byte) dan IV (16 byte) dihasilkan oleh fairplay-session.cjs
 * lalu dikirim ke receiver terenkripsi RSA di plist /setup.
 *
 * DESAIN PENTING - kenapa setiap frame dienkripsi sendiri:
 *
 *   Untuk presentasi, latensi lebih penting daripada rasio kompresi. Kalau
 *   seluruh stream dienkripsi sebagai satu rantai CBC, satu paket UDP yang
 *   hilang akan merusak SEMUA frame berikutnya dan TV harus menunggu I-frame
 *   berikutnya - terasa seperti lag persis seperti yang ingin kita hindari.
 *
 *   Jadi setiap access unit dienkripsi secara independen, dimulai dari IV.
 *   Konsekuensinya decoder boleh mulai dari frame mana pun yang punya kunci,
 *   dan satu frame yang rusak tidak menjatuhkan seluruh stream.
 *
 * Modul ini murni kriptografi - tidak menyentuh jaringan - sehingga round-trip
 * (encrypt -> decrypt) bisa diuji tanpa perangkat TV.
 */

const crypto = require('node:crypto');

const BLOCK_BYTES = 16; // AES block size

// Peta mode -> algoritme Node. PENTING: jangan reuse satu konstanta untuk
// semua mode - kekacauan seperti itu membuat "CFB" diam-diam berjalan dengan
// CBC dan menghasilkan ciphertext yang mustahil dibuka receiver.
const ALGORITHM_BY_MODE = {
  cbc: 'aes-128-cbc',
  cfb: 'aes-128-cfb',
};

const SUPPORTED_MODES = Object.keys(ALGORITHM_BY_MODE);

/**
 * Buat cipher streaming yang dipakai ulang untuk banyak access unit.
 *
 * @param {Buffer} sessionKey 16 byte dari createFairPlaySessionKey()
 * @param {Buffer} iv         16 byte dari createFairPlaySessionKey()
 * @param {string} mode       'cbc' atau 'cfb'
 */
function createVideoCipher({ sessionKey, iv, mode = 'cbc' } = {}) {
  if (!sessionKey || sessionKey.length !== BLOCK_BYTES) {
    throw new Error(`Session key harus ${BLOCK_BYTES} byte.`);
  }
  if (!iv || iv.length !== BLOCK_BYTES) {
    throw new Error(`IV harus ${BLOCK_BYTES} byte.`);
  }
  if (!SUPPORTED_MODES.includes(mode)) {
    throw new Error(`Mode enkripsi tidak didukung: ${mode}`);
  }
  const algorithm = ALGORITHM_BY_MODE[mode];

  // Node tidak punya API "reset", jadi cipher baru dibuat per access unit.
  // Ini disengaja: enkripsi tiap frame berdiri sendiri (lihat catatan di atas).
  //
  // Auto-padding bawaan Node DIMATIKAN karena dua alasan:
  //   1. Mode CFB harus stream-oriented - panjang ciphertext wajib sama
  //      dengan plaintext, tidak boleh ditambah blok PKCS#7.
  //   2. Padding ditangani eksplisit supaya batas frame di level RTP tetap
  //      jelas; padding diam-diam di dalam primitive crypto sulit diawasi.
  const newCipher = () => {
    const c = crypto.createCipheriv(algorithm, effectiveKey(), iv);
    c.setAutoPadding(false);
    return c;
  };

  const newDecipher = () => {
    const d = crypto.createDecipheriv(algorithm, effectiveKey(), iv);
    d.setAutoPadding(false);
    return d;
  };

  // Pada mode CBC tiap frame memakai kunci turunan agar keystream tiap frame
  // berbeda; mode CFB memakai session key apa adanya.
  const effectiveKey = () => (mode === 'cbc' ? deriveFrameKey(sessionKey, iv) : sessionKey);

  return {
    mode,
    algorithm,
    sessionKey,
    iv,
    /**
     * Enkripsi satu access unit.
     * @returns {Buffer} kelipatan 16 byte pada mode CBC, panjang identik
     *                   dengan plaintext pada mode CFB.
     */
    encrypt(plain) {
      if (!plain || plain.length === 0) return Buffer.alloc(0);
      // Hanya CBC yang butuh kelipatan block. CFB adalah mode stream: ia
      // memproses byte per byte dan sengaja dipakai untuk payload H.264 yang
      // panjangnya jarang sekali kelipatan 16.
      const source = mode === 'cbc' ? padToBlock(plain, 'pkcs7') : plain;
      const cipher = newCipher();
      return Buffer.concat([cipher.update(source), cipher.final()]);
    },
    /**
     * Dekripsi satu access unit.
     * Mode CBC melepas padding PKCS#7 di sini, jadi hasilnya langsung sama
     * dengan plaintext asli. Mode CFB mengembalikan apa adanya.
     */
    decrypt(cipherText) {
      if (!cipherText || cipherText.length === 0) return Buffer.alloc(0);
      if (mode === 'cbc' && cipherText.length % BLOCK_BYTES !== 0) {
        throw new Error(`Ciphertext CBC harus kelipatan ${BLOCK_BYTES} byte.`);
      }
      const decipher = newDecipher();
      const raw = Buffer.concat([decipher.update(cipherText), decipher.final()]);
      return mode === 'cbc' ? unpadFromBlock(raw) : raw;
    },
  };
}

/**
 * Kunci per-frame untuk mode CBC.
 *
 * Session key hanya 16 byte, jadi tidak bisa langsung digabung dengan IV.
 * Yang dilakukan adalah XOR session key dengan byte pertama IV - murah,
 * deterministik, dan cukup membuat tiap frame memakai keystream berbeda.
 */
function deriveFrameKey(sessionKey, iv) {
  const out = Buffer.from(sessionKey);
  for (let i = 0; i < out.length && i < iv.length; i += 1) {
    out[i] ^= iv[i];
  }
  return out;
}

/**
 * Padding helper: pastikan payload kelipatan 16 agar AES tidak menambah
 * byte sendiri dan receiver bisa memotong tepat di batas frame.
 *
 * Mode 'none' tidak menambahkan apa pun; pemanggil harus memastikan panjang
 * sudah kelipatan 16 (dipakai mode CFB yang stream-oriented).
 */
function padToBlock(data, mode = 'pkcs7') {
  if (mode === 'none') {
    if (data.length % BLOCK_BYTES !== 0) {
      throw new Error(`Payload harus kelipatan ${BLOCK_BYTES} byte untuk mode tanpa padding.`);
    }
    return data;
  }
  const padLength = BLOCK_BYTES - (data.length % BLOCK_BYTES);
  return Buffer.concat([data, Buffer.alloc(padLength, padLength)]);
}

/** Kebalikan dari padToBlock - dipakai test. */
function unpadFromBlock(data) {
  if (data.length === 0 || data.length % BLOCK_BYTES !== 0) {
    throw new Error('Payload terpadat tidak valid.');
  }
  const padLength = data[data.length - 1];
  if (padLength < 1 || padLength > BLOCK_BYTES || padLength > data.length) {
    throw new Error(`Nilai padding tidak valid: ${padLength}`);
  }
  // Verifikasi semua byte padding sama.
  for (let i = data.length - padLength; i < data.length; i += 1) {
    if (data[i] !== padLength) throw new Error('Padding tidak konsisten.');
  }
  return data.subarray(0, data.length - padLength);
}

module.exports = {
  BLOCK_BYTES,
  ALGORITHM_BY_MODE,
  SUPPORTED_MODES,
  createVideoCipher,
  deriveFrameKey,
  padToBlock,
  unpadFromBlock,
};
