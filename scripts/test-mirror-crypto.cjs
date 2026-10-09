/**
 * Test enkripsi payload video AirPlay Mirroring.
 * Jalankan: node scripts/test-mirror-crypto.cjs
 * Tidak butuh TV - murni round-trip kriptografi.
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const {
  createVideoCipher,
  padToBlock,
  unpadFromBlock,
  deriveFrameKey,
  BLOCK_BYTES,
  SUPPORTED_MODES,
} = require('../electron/airplay/mirror-crypto.cjs');

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

console.log('AirPlay mirror crypto - test\n');

const key = crypto.randomBytes(16);
const iv = crypto.randomBytes(16);
const sample = crypto.randomBytes(5000);

// ------------------------------------------------------------------ validasi

test('key & IV salah panjang ditolak', () => {
  assert.throws(() => createVideoCipher({ sessionKey: Buffer.alloc(8), iv }), /16 byte/);
  assert.throws(() => createVideoCipher({ sessionKey: key, iv: Buffer.alloc(8) }), /16 byte/);
});

test('mode enkripsi tak didukung ditolak', () => {
  assert.throws(() => createVideoCipher({ sessionKey: key, iv, mode: 'gcm' }), /tidak didukung/);
});

// ------------------------------------------------------------------- padding

test('PKCS#7: panjang selalu kelipatan 16, bolak-balik 1..16 byte', () => {
  for (let n = 1; n <= 40; n += 1) {
    const data = crypto.randomBytes(n);
    const padded = padToBlock(data, 'pkcs7');
    assert.strictEqual(padded.length % BLOCK_BYTES, 0, `panjang ${n} harus kelipatan 16`);
    assert.deepStrictEqual(unpadFromBlock(padded), data, `data ${n} byte harus utuh`);
  }
});

test('PKCS#7: data kosong -> satu blok padding penuh', () => {
  const padded = padToBlock(Buffer.alloc(0), 'pkcs7');
  assert.strictEqual(padded.length, BLOCK_BYTES, 'harus 1 blok');
  assert.strictEqual(unpadFromBlock(padded).length, 0);
});

test('padding rusak ditolak (nilai & isian tidak konsisten)', () => {
  const a = padToBlock(Buffer.from([1, 2, 3]), 'pkcs7');
  // Nilai byte penanda lebih besar dari panjang blok -> tidak valid.
  const bad1 = Buffer.from(a); bad1[bad1.length - 1] = 0x7f;
  assert.throws(() => unpadFromBlock(bad1), /tidak valid/);
  // Nilai penanda masih 13 tapi salah satu byte padding lain dirusak.
  const bad2 = Buffer.from(a); bad2[5] ^= 0xff;
  assert.throws(() => unpadFromBlock(bad2), /tidak konsisten/);
  // Panjang bukan kelipatan blok -> tidak valid.
  assert.throws(() => unpadFromBlock(Buffer.alloc(17)), /tidak valid/);
});

// --------------------------------------------------------------- round-trip

for (const mode of SUPPORTED_MODES) {
  test(`ROUND-TRIP mode ${mode}: sample 5000 byte pulih utuh`, () => {
    const cipher = createVideoCipher({ sessionKey: key, iv, mode });
    const enc = cipher.encrypt(sample);
    assert.notDeepStrictEqual(enc, sample, 'harus berbeda dari plaintext');
    const dec = cipher.decrypt(enc);
    assert.deepStrictEqual(dec, sample, 'dekripsi harus mengembalikan sample asli persis');
  });
}

test('CBC: ciphertext kelipatan 16, CFB: panjang sama dengan input', () => {
  const cbc = createVideoCipher({ sessionKey: key, iv, mode: 'cbc' });
  const cfb = createVideoCipher({ sessionKey: key, iv, mode: 'cfb' });
  assert.strictEqual(cbc.encrypt(sample).length % BLOCK_BYTES, 0);
  assert.strictEqual(cfb.encrypt(sample).length, sample.length, 'CFB stream-oriented, panjang tetap');
});

test('SETIAP MODE memakai algoritme yang BENAR (regresi: cfb pernah jadi cbc)', () => {
  const cbc = createVideoCipher({ sessionKey: key, iv, mode: 'cbc' });
  const cfb = createVideoCipher({ sessionKey: key, iv, mode: 'cfb' });
  assert.strictEqual(cbc.algorithm, 'aes-128-cbc', 'mode cbc -> aes-128-cbc');
  assert.strictEqual(cfb.algorithm, 'aes-128-cfb', 'mode cfb -> aes-128-cfb');
  // Bukti tambahan: CFB adalah mode stream, jadi 15 byte TIDAK jadi kelipatan 16.
  assert.strictEqual(cfb.encrypt(Buffer.alloc(15)).length, 15, 'CFB tidak memaksa block');
  assert.strictEqual(cbc.encrypt(Buffer.alloc(15)).length % BLOCK_BYTES, 0, 'CBC memaksa block');
});

test('CFB: ciphertext CFB tidak bisa dibuka sebagai CBC (mode benar-benar beda)', () => {
  const cfb = createVideoCipher({ sessionKey: key, iv, mode: 'cfb' });
  const cbc = createVideoCipher({ sessionKey: key, iv, mode: 'cbc' });
  const data = Buffer.alloc(64, 7);
  assert.throws(() => cbc.decrypt(cfb.encrypt(data)), 'CBC tidak boleh bisa buka output CFB');
});

test('CFB: menerima panjang sembarang (tidak wajib kelipatan 16)', () => {
  const cfb = createVideoCipher({ sessionKey: key, iv, mode: 'cfb' });
  for (const n of [1, 7, 15, 17, 999, 5000]) {
    const data = crypto.randomBytes(n);
    const enc = cfb.encrypt(data);
    assert.strictEqual(enc.length, n, `panjang ${n} harus dipertahankan`);
    assert.deepStrictEqual(cfb.decrypt(enc), data, `data ${n} byte harus pulih utuh`);
  }
});

test('CFB: payload kosong aman, ciphertext rusak CBC ditolak', () => {
  const cfb = createVideoCipher({ sessionKey: key, iv, mode: 'cfb' });
  assert.strictEqual(cfb.decrypt(Buffer.alloc(0)).length, 0, 'kosong bukan error');
  // Hanya CBC yang mewajibkan kelipatan block pada ciphertext.
  const cbc = createVideoCipher({ sessionKey: key, iv, mode: 'cbc' });
  assert.throws(() => cbc.decrypt(Buffer.alloc(17)), /kelipatan 16/);
});

// --------------------------------------------- tiap frame berdiri sendiri

test('SETIAP FRAME MANDIRI: decrypt frame tanpa decrypt frame lain', () => {
  const cipher = createVideoCipher({ sessionKey: key, iv, mode: 'cbc' });
  // Simulasikan video: 60 access unit, sebagian kecil sebagian besar.
  const frames = Array.from({ length: 60 }, (_, i) => {
    const size = 200 + ((i * 137) % 4000);
    const plain = crypto.randomBytes(size);
    return { index: i, size, plain, enc: cipher.encrypt(plain) };
  });
  for (const f of frames) {
    assert.deepStrictEqual(cipher.decrypt(f.enc), f.plain, `frame ${f.index} harus bisa dibuka sendiri`);
  }
});

test('satu frame hilang TIDAK merusak frame lain (sifat inti desain)', () => {
  const cipher = createVideoCipher({ sessionKey: key, iv, mode: 'cbc' });
  const plains = Array.from({ length: 30 }, () => crypto.randomBytes(1500));
  const enc = plains.map((p) => cipher.encrypt(p));
  // TViram hanya yang diterima semua kecuali frame 12.
  for (let i = 0; i < enc.length; i += 1) {
    if (i === 12) continue;
    assert.deepStrictEqual(cipher.decrypt(enc[i]), plains[i], `frame ${i} tetap utuh`);
  }
});

test('frame acak dengan IV sama menghasilkan ciphertext sama (deterministik)', () => {
  // Receiver dapat menyalin frame broadcaster dari paket yang hilang,
  // jadi enkripsi per-frame harus bisa direproduksi, bukan acak.
  const cipher = createVideoCipher({ sessionKey: key, iv, mode: 'cbc' });
  const data = crypto.randomBytes(800);
  assert.deepStrictEqual(cipher.encrypt(data), cipher.encrypt(data), 'harus deterministik');
});

test('session key berbeda -> ciphertext berbeda (wajib)', () => {
  const a = createVideoCipher({ sessionKey: key, iv, mode: 'cbc' });
  const b = createVideoCipher({ sessionKey: crypto.randomBytes(16), iv, mode: 'cbc' });
  assert.notDeepStrictEqual(a.encrypt(sample), b.encrypt(sample));
});

test('deriveFrameKey: deterministik, lenyek, beda saat iv beda', () => {
  const k1 = deriveFrameKey(key, iv);
  const k2 = deriveFrameKey(key, iv);
  assert.deepStrictEqual(k1, k2, 'harus deterministik');
  assert.notDeepStrictEqual(k1, deriveFrameKey(key, crypto.randomBytes(16)), 'iv beda -> kunci beda');
  assert.strictEqual(k1.length, 16, 'panjang tetap 16');
  assert.ok(deriveFrameKey(key, Buffer.alloc(16, 0xff)).some((b, i) => b !== key[i]), 'harus benar-benar berubah');
});

// ------------------------------------------------------------ integritas

test('ciphertext diubah 1 byte -> plaintext rusak atau error', () => {
  const cipher = createVideoCipher({ sessionKey: key, iv, mode: 'cbc' });
  const enc = cipher.encrypt(sample);
  const tampered = Buffer.from(enc);
  tampered[Math.floor(tampered.length / 2)] ^= 0xff;
  // CBC: satu byte yang diubah merusak seluruh blok berikutnya, jadi
  // dekripsi hampir pasti gagal atau menghasilkan data yang berbeda.
  let differs = true;
  try {
    differs = !cipher.decrypt(tampered).equals(sample);
  } catch {
    differs = true;
  }
  assert.ok(differs, 'data harus berubah / gagal, tidak boleh sama dengan asli');
});

test('payload kosong aman (tidak error)', () => {
  const cipher = createVideoCipher({ sessionKey: key, iv, mode: 'cbc' });
  assert.strictEqual(cipher.encrypt(Buffer.alloc(0)).length, 0);
  assert.strictEqual(cipher.decrypt(Buffer.alloc(0)).length, 0);
});

test('performa: 30 frame 1 MB total dienkripsi < 50 ms', () => {
  const cipher = createVideoCipher({ sessionKey: key, iv, mode: 'cbc' });
  const frame = crypto.randomBytes(35 * 1024);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 30; i += 1) cipher.encrypt(frame);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`       (30 frame x 35 KB = ${(30 * 35 / 1024).toFixed(1)} MB dalam ${ms.toFixed(1)} ms)`);
  assert.ok(ms < 50, `terlalu lambat: ${ms.toFixed(1)} ms`);
});

console.log(`\n${passed} lulus, ${failed} gagal.`);
