/**
 * FairPlay session-key material untuk AirPlay Mirroring (AirPlay 1 / RAOP).
 *
 * Konsep kuncinya penting dan sering disalahpahami:
 *
 *   - TIDAK ADA "key TV" yang perlu diketahui/dicuri.
 *   - Receiver MEMBUKA (publish) public key RSA-nya lewat /info.
 *   - Sender membuat session key + IV secara ACAK untuk setiap sesi.
 *   - Sender mengenkripsi (key || iv) memakai public key receiver.
 *   - Receiver mendekripsi dengan private key miliknya sendiri.
 *
 * Artinya modul ini bisa diuji penuh tanpa perangkat TV: cukup buat
 * sepasang RSA test key, enkripsi pakai "public", dekripsi pakai "private".
 *
 * Rujukan protokol: AirPlay Mirroring / RAOP FairPlay session setup.
 */

const crypto = require('node:crypto');

const SESSION_KEY_BYTES = 16; // AES-128
const SESSION_IV_BYTES = 16;

/**
 * Public key receiver datang dari /info sebagai string base64 DER (SubjectPublicKeyInfo).
 * Beberapa firmware mengirimnya tanpa padding base64.
 */
function decodeReceiverPublicKey(publicKeyBase64) {
  if (!publicKeyBase64 || typeof publicKeyBase64 !== 'string') {
    throw new Error('Public key receiver tidak tersedia di /info.');
  }
  let normalized = publicKeyBase64.replace(/\s+/g, '');
  while (normalized.length % 4 !== 0) normalized += '='; // pulihkan padding base64
  const der = Buffer.from(normalized, 'base64');
  if (der.length < 64) throw new Error(`Public key terlalu pendek (${der.length} byte).`);

  const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  const details = key.asymmetricKeyDetails || {};
  if (details.modulusLength && details.modulusLength < 1024) {
    throw new Error(`Public key terlalu lemah untuk FairPlay (${details.modulusLength} bit).`);
  }
  return key;
}

/**
 * Buat session key + IV acak, lalu RSA-enkripsi keduanya untuk receiver.
 *
 * Payload yang dikirim di field `key` pada plist RTSP adalah
 * RSA-OAEP(sessionKey || iv). FairPlay memakai OAEP (PKCS#1 v1.5 tidak berlaku
 * di sini), jadi kita memakai OAEP dengan SHA-1 yang lazim dipakai receiver.
 */
function createFairPlaySessionKey({ receiverPublicKeyBase64, modulus = false } = {}) {
  const publicKey = decodeReceiverPublicKey(receiverPublicKeyBase64);

  const sessionKey = crypto.randomBytes(SESSION_KEY_BYTES);
  const iv = crypto.randomBytes(SESSION_IV_BYTES);
  const material = Buffer.concat([sessionKey, iv]); // 32 byte: key lalu IV

  // Sebagian firmware memakai OAEP-SHA1, sebagian PKCS1v15. Default OAEP-SHA1.
  const encrypted = crypto.publicEncrypt(
    { key: publicKey, padding: modulus ? crypto.constants.RSA_PKCS1_PADDING : crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    material,
  );

  return {
    sessionKey,
    iv,
    encrypted,
    // Field plist `key` dikirim sebagai base64.
    keyField: encrypted.toString('base64'),
    // Beberapa receiver meminta IV juga dalam bentuk base64 terpisah.
    ivField: iv.toString('base64'),
  };
}

/**
 * Hanya untuk pengujian: dekripsi balik dengan private key milik receiver.
 * Fungsi ini tidak dipakai di jalur produksi, hanya membuktikan formatnya benar.
 */
function decryptFairPlaySessionKey({ encrypted, receiverPrivateKey, modulus = false }) {
  const material = crypto.privateDecrypt(
    { key: receiverPrivateKey, padding: modulus ? crypto.constants.RSA_PKCS1_PADDING : crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    encrypted,
  );
  if (material.length !== SESSION_KEY_BYTES + SESSION_IV_BYTES) {
    throw new Error(`Panjang material tidak sesuai (${material.length}).`);
  }
  return {
    sessionKey: material.subarray(0, SESSION_KEY_BYTES),
    iv: material.subarray(SESSION_IV_BYTES),
  };
}

/** Base64 DER untuk public key (dipakai test & logging). */
function exportPublicKeyBase64(keyObject) {
  return keyObject.export({ format: 'der', type: 'spki' }).toString('base64');
}

module.exports = {
  SESSION_KEY_BYTES,
  SESSION_IV_BYTES,
  decodeReceiverPublicKey,
  createFairPlaySessionKey,
  decryptFairPlaySessionKey,
  exportPublicKeyBase64,
};