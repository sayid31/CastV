/**
 * Test FairPlay session-key material (RSA).
 * Men証明 round-trip: encrypt dengan "public key", decrypt dengan "private key".
 * Tidak butuh TV - memakai pasangan RSA buatan sendiri.
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const {
  createFairPlaySessionKey,
  decryptFairPlaySessionKey,
  decodeReceiverPublicKey,
  exportPublicKeyBase64,
  SESSION_KEY_BYTES,
  SESSION_IV_BYTES,
} = require('../electron/airplay/fairplay-session.cjs');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  OK   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('FairPlay session key - test\n');

// Sepasang "TV test": public key dipublish, private key dirahasiakan.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkBase64 = exportPublicKeyBase64(publicKey);

test('public key receiver terbaca dari /info format base64 DER', () => {
  const key = decodeReceiverPublicKey(pkBase64);
  assert.strictEqual(key.asymmetricKeyType, 'rsa', 'harus RSA');
  assert.strictEqual(key.asymmetricKeyDetails.modulusLength, 2048, 'modulus 2048');
});

test('public key base64 tanpa padding tetap diterima', () => {
  const stripped = pkBase64.replace(/=+$/, '');
  const key = decodeReceiverPublicKey(stripped);
  assert.strictEqual(key.asymmetricKeyDetails.modulusLength, 2048, 'padding pulih otomatis');
});

test('public key rusak ditolak dengan pesan jelas', () => {
  assert.throws(() => decodeReceiverPublicKey(''), /tidak tersedia/i);
  assert.throws(() => decodeReceiverPublicKey('aGVsbG8='), /terlalu pendek/i);
});

test('session key + IV di-generate acak, panjang benar', () => {
  const s = createFairPlaySessionKey({ receiverPublicKeyBase64: pkBase64 });
  assert.strictEqual(s.sessionKey.length, SESSION_KEY_BYTES, 'session key 16 byte');
  assert.strictEqual(s.iv.length, SESSION_IV_BYTES, 'IV 16 byte');
  assert.strictEqual(s.encrypted.length, 256, 'ciphertext = modulus byte');
});

test('dua sesi menghasilkan key berbeda (acak, bukan statis)', () => {
  const a = createFairPlaySessionKey({ receiverPublicKeyBase64: pkBase64 });
  const b = createFairPlaySessionKey({ receiverPublicKeyBase64: pkBase64 });
  assert.notDeepStrictEqual(a.sessionKey, b.sessionKey, 'session key harus beda tiap sesi');
  assert.notDeepStrictEqual(a.encrypted, b.encrypted, 'ciphertext harus beda tiap sesi');
});

test('ROUND-TRIP: hanya private key yang bisa buka', () => {
  const s = createFairPlaySessionKey({ receiverPublicKeyBase64: pkBase64 });
  const opened = decryptFairPlaySessionKey({ encrypted: s.encrypted, receiverPrivateKey: privateKey });
  assert.deepStrictEqual(opened.sessionKey, s.sessionKey, 'session key pulih');
  assert.deepStrictEqual(opened.iv, s.iv, 'IV pulih');
});

test('public key lain tidak bisa membuka sesi', () => {
  const s = createFairPlaySessionKey({ receiverPublicKeyBase64: pkBase64 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.throws(() => decryptFairPlaySessionKey({ encrypted: s.encrypted, receiverPrivateKey: other }), 'harus gagal');
});

test('ciphertext diubah 1 byte -> gagal dibuka (integritas)', () => {
  const s = createFairPlaySessionKey({ receiverPublicKeyBase64: pkBase64 });
  const tampered = Buffer.from(s.encrypted);
  tampered[10] ^= 0xff;
  assert.throws(() => decryptFairPlaySessionKey({ encrypted: tampered, receiverPrivateKey: privateKey }));
});

test('PKCS1 v1.5 mode bisa enkripsi (Node tidak izinkan dekripsi mode ini)', () => {
  // Catatan: Node.js >= 18 menolak RSA_PKCS1_PADDING untuk private decrypt
  // demi keamanan. Jadi mode ini hanya bisa diverifikasi sampai tahap enkripsi;
  // kebenaran dekripsi harus dibuktikan oleh receiver sungguhan.
  const s = createFairPlaySessionKey({ receiverPublicKeyBase64: pkBase64, modulus: true });
  assert.strictEqual(s.encrypted.length, 256, 'ciphertext tetap 256 byte');
  assert.deepStrictEqual(s.sessionKey.length, SESSION_KEY_BYTES, 'session key tetap benar');
  let blocked = false;
  try {
    decryptFairPlaySessionKey({ encrypted: s.encrypted, receiverPrivateKey: privateKey, modulus: true });
  } catch (error) {
    blocked = /no longer supported/i.test(error.message);
  }
  assert.ok(blocked, 'Node harus menolak dekripsi PKCS1v15 (d Expectations kita)');
});

test('field plist key & iv berbentuk base64 yang valid', () => {
  const s = createFairPlaySessionKey({ receiverPublicKeyBase64: pkBase64 });
  assert.ok(/^[A-Za-z0-9+/]+=*$/.test(s.keyField), 'keyField harus base64');
  assert.ok(/^[A-Za-z0-9+/]+=*$/.test(s.ivField), 'ivField harus base64');
  const back = Buffer.from(s.keyField, 'base64');
  assert.deepStrictEqual(back, s.encrypted, 'base64 round-trip ciphertext');
});

console.log(`\n${passed} lulus, ${failed} gagal.`);