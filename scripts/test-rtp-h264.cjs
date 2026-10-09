/**
 * Test untuk packetisasi RTP H.264 (RFC 6184 + RFC 3550).
 * Jalankan: node scripts/test-rtp-h264.cjs
 * Tidak butuh perangkat TV - murni verifikasi bitstream.
 */

const assert = require('node:assert');
const {
  buildRtpHeader,
  parseRtpHeader,
  splitAnnexB,
  buildFuAHeader,
  packetizeFrame,
  CLOCK_RATE_HZ,
  RTP_HEADER_BYTES,
  FU_HEADER_BYTES,
  MTU_SAFE_BYTES,
} = require('../electron/airplay/rtp-h264.cjs');

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

console.log('RTP H.264 packetizer - test\n');

// ------------------------------------------------------------------ header

test('header RTP: 12 byte, V=2, P=0, X=0, CC=0', () => {
  const h = buildRtpHeader({ marker: false, payloadType: 96, sequence: 0x1234, timestamp: 0xdeadbeef, ssrc: 0xcafebabe });
  assert.strictEqual(h.length, RTP_HEADER_BYTES, 'header harus 12 byte');
  const f = parseRtpHeader(h);
  assert.strictEqual(f.version, 2, 'versi harus 2');
  assert.strictEqual(f.padding, 0, 'padding harus 0');
  assert.strictEqual(f.extension, 0, 'extension harus 0');
  assert.strictEqual(f.csrcCount, 0, 'CSRC count harus 0');
  assert.strictEqual(f.payloadType, 96, 'payload type harus 96');
  assert.strictEqual(f.sequence, 0x1234, 'sequence field');
  assert.strictEqual(f.timestamp >>> 0, 0xdeadbeef, 'timestamp field');
  assert.strictEqual(f.ssrc >>> 0, 0xcafebabe, 'ssrc field');
});

test('header RTP: bit M (marker) di byte 1 bit 7', () => {
  const on = buildRtpHeader({ marker: true, payloadType: 96, sequence: 1, timestamp: 0, ssrc: 1 });
  const off = buildRtpHeader({ marker: false, payloadType: 96, sequence: 1, timestamp: 0, ssrc: 1 });
  assert.strictEqual(parseRtpHeader(on).marker, 1, 'marker harus 1');
  assert.strictEqual(parseRtpHeader(off).marker, 0, 'marker harus 0');
  assert.strictEqual(parseRtpHeader(on).version, 2, 'versi tetap 2 saat marker=1');
});

test('header RTP: sequence wrap 16-bit, timestamp 32-bit', () => {
  const h = buildRtpHeader({ marker: false, payloadType: 96, sequence: 0x1ffff, timestamp: 0xffffffff, ssrc: 0 });
  const f = parseRtpHeader(h);
  assert.strictEqual(f.sequence, 0xffff, 'sequence harus wrap ke 16-bit');
  assert.strictEqual(f.timestamp, 0xffffffff, 'timestamp max 32-bit');
});

// ------------------------------------------------------------------ Annex-B

test('splitAnnexB: pisahkan NAL dari start code 3-byte dan 4-byte', () => {
  const stream = Buffer.concat([
    Buffer.from([0, 0, 0, 1]), Buffer.from([0x67, 0x42, 0x00]),   // SPS (4-byte SC)
    Buffer.from([0, 0, 1]), Buffer.from([0x68, 0xce]),             // PPS (3-byte SC)
    Buffer.from([0, 0, 0, 1]), Buffer.from([0x65, 0x88, 0x84]),   // IDR (4-byte SC)
  ]);
  const nals = splitAnnexB(stream);
  assert.strictEqual(nals.length, 3, `harus 3 NAL, dapat ${nals.length}`);
  assert.strictEqual(nals[0][0] & 0x1f, 7, 'pertama SPS (tipe 7)');
  assert.strictEqual(nals[1][0] & 0x1f, 8, 'kedua PPS (tipe 8)');
  assert.strictEqual(nals[2][0] & 0x1f, 5, 'ketiga IDR (tipe 5)');
});

test('splitAnnexB: tidak ada NAL kosong di antara start code', () => {
  const stream = Buffer.concat([
    Buffer.from([0, 0, 0, 1]), Buffer.from([0x67, 0x00]),
    Buffer.from([0, 0, 1]), Buffer.from([0x68, 0x00]),
  ]);
  const nals = splitAnnexB(stream);
  assert.strictEqual(nals.length, 2);
  assert.ok(nals.every((n) => n.length > 0), 'tidak boleh ada NAL kosong');
});

// ------------------------------------------------------------------ FU-A

test('buildFuAHeader: indicator type 28 + FU header S/E/type', () => {
  const h = buildFuAHeader({ nalHeader: 0x65, start: true, end: false });
  assert.strictEqual(h[0] & 0x1f, 28, 'FU indicator type harus 28');
  assert.strictEqual(h[0] & 0x80, 0x00, 'FU indicator F harus 0');
  assert.strictEqual(h[0] & 0x60, 0x60, 'NRI harus dipertahankan (0x60)');
  assert.strictEqual(h[1] & 0x80, 0x80, 'bit S harus 1');
  assert.strictEqual(h[1] & 0x40, 0x00, 'bit E harus 0');
  assert.strictEqual(h[1] & 0x1f, 0x65 & 0x1f, 'FU header harus tipe NAL asli');
});

test('buildFuAHeader: S dan E benar untuk tengah & akhir', () => {
  const mid = buildFuAHeader({ nalHeader: 0x41, start: false, end: false });
  assert.strictEqual(mid[1] & 0xc0, 0x00, 'S dan E harus 0 di tengah');
  const end = buildFuAHeader({ nalHeader: 0x41, start: false, end: true });
  assert.strictEqual(end[1] & 0xc0, 0x40, 'E harus 1 di akhir');
  assert.strictEqual(end[1] & 0x1f, 0x01, 'tipe NAL asli (1)');
});

// ------------------------------------------------------------- packetisasi

test('packetizeFrame: NAL kecil jadi Single NAL Unit', () => {
  const nalBody = Buffer.from([0x65, 1, 2, 3]);
  const au = Buffer.concat([Buffer.from([0, 0, 0, 1]), nalBody]);
  const { packets, nextSequence } = packetizeFrame({ accessUnit: au, sequenceStart: 100, timestamp: 9000, ssrc: 42, mtu: 1400 });
  assert.strictEqual(packets.length, 1, 'harus 1 paket');
  assert.strictEqual(packets[0].fuStart, false, 'bukan FU-A');
  assert.strictEqual(packets[0].payload.length, RTP_HEADER_BYTES + nalBody.length, '12 header + NAL utuh');
  assert.deepStrictEqual(packets[0].payload.subarray(RTP_HEADER_BYTES), nalBody, 'NAL harus utuh');
  assert.strictEqual(packets[0].marker, true, 'paket tunggal = marker');
  assert.strictEqual(nextSequence, 101, 'sequence naik 1');
});

test('packetizeFrame: NAL besar dipecah FU-A, tidak melebihi MTU', () => {
  const big = Buffer.alloc(3000, 0xaa);
  const au = Buffer.concat([Buffer.from([0, 0, 0, 1]), big]);
  const { packets } = packetizeFrame({ accessUnit: au, sequenceStart: 0, timestamp: 0, ssrc: 1, mtu: MTU_SAFE_BYTES });
  assert.ok(packets.length >= 3, `harusnya >=3 pecahan, dapat ${packets.length}`);
  assert.strictEqual(packets[0].fuStart, true, 'pecahan pertama S=1');
  const last = packets[packets.length - 1];
  assert.strictEqual(last.fuEnd, true, 'pecahan terakhir E=1');
  assert.strictEqual(last.marker, true, 'pecahan terakhir marker');
  for (const p of packets) {
    assert.ok(p.payload.length <= MTU_SAFE_BYTES, `paket ${p.payload.length}B melebihi MTU ${MTU_SAFE_BYTES}B`);
  }
  const nri = packets.map((p) => p.payload[RTP_HEADER_BYTES] & 0x60);
  assert.ok(nri.every((n) => n === nri[0]), 'NRI konsisten antar pecahan');
});

test('packetizeFrame: payload FU-A bisa direkonstruksi jadi NAL asli', () => {
  const nal = Buffer.concat([Buffer.from([0x65]), Buffer.alloc(2500, 0x5a)]);
  const au = Buffer.concat([Buffer.from([0, 0, 0, 1]), nal]);
  const { packets } = packetizeFrame({ accessUnit: au, sequenceStart: 0, timestamp: 0, ssrc: 1, mtu: MTU_SAFE_BYTES });
  assert.ok(packets.length >= 2, 'NAL besar harus jadi FU-A');

  // Rekonstruksi: FU indicator + FU header memuat NRI dan tipe NAL asli,
  // jadi header NAL harus dibangun ulang dari FU-A sebelum body digabung.
  const first = packets[0].payload;
  const indicator = first[RTP_HEADER_BYTES];
  const fuHeader = first[RTP_HEADER_BYTES + 1];
  const nalHeaderByte = (indicator & 0x60) | (fuHeader & 0x1f);
  const chunks = [first.subarray(RTP_HEADER_BYTES + FU_HEADER_BYTES)];
  for (let i = 1; i < packets.length; i += 1) {
    chunks.push(packets[i].payload.subarray(RTP_HEADER_BYTES + FU_HEADER_BYTES));
  }
  const out = Buffer.concat([Buffer.from([nalHeaderByte]), ...chunks]);
  assert.strictEqual(out.length, nal.length, `ukuran harus sama (${out.length} vs ${nal.length})`);
  assert.deepStrictEqual(out, nal, 'isi harus identik -> tidak ada data hilang');
});

test('packetizeFrame: multi-NAL, tepat satu marker di akhir', () => {
  const au = Buffer.concat([
    Buffer.from([0, 0, 0, 1]), Buffer.from([0x67, 0x01, 0x02]),
    Buffer.from([0, 0, 1]), Buffer.from([0x68, 0x03]),
    Buffer.from([0, 0, 1]), Buffer.from([0x65, 0x04, 0x05]),
  ]);
  const { packets } = packetizeFrame({ accessUnit: au, sequenceStart: 0, timestamp: 0, ssrc: 7, mtu: MTU_SAFE_BYTES });
  assert.strictEqual(packets.length, 3, '3 NAL = 3 paket');
  assert.strictEqual(packets.filter((p) => p.marker).length, 1, 'tepat satu marker');
  assert.strictEqual(packets[2].marker, true, 'marker di paket terakhir');
});

test('packetizeFrame: sequence kontigu & wrap di 65535', () => {
  const big = Buffer.alloc(4000, 0xbb);
  const au = Buffer.concat([Buffer.from([0, 0, 0, 1]), big]);
  const { packets } = packetizeFrame({ accessUnit: au, sequenceStart: 65533, timestamp: 0, ssrc: 1, mtu: MTU_SAFE_BYTES });
  assert.ok(packets.length >= 3, 'perlu >=3 paket untuk uji wrap');
  for (let i = 1; i < packets.length; i += 1) {
    const prev = parseRtpHeader(packets[i - 1].payload).sequence;
    const cur = parseRtpHeader(packets[i].payload).sequence;
    assert.strictEqual(cur, (prev + 1) & 0xffff, `sequence harus kontigu di paket ${i}`);
  }
  assert.ok(parseRtpHeader(packets[0].payload).sequence >= 65533, 'memulai dari 65533');
});

test('packetizeFrame: timestamp identik untuk semua paket satu frame', () => {
  const big = Buffer.alloc(3000, 0xcc);
  const au = Buffer.concat([Buffer.from([0, 0, 0, 1]), big]);
  const ts = 45000;
  const { packets } = packetizeFrame({ accessUnit: au, sequenceStart: 0, timestamp: ts, ssrc: 1, mtu: MTU_SAFE_BYTES });
  for (const p of packets) {
    assert.strictEqual(parseRtpHeader(p.payload).timestamp, ts, 'timestamp harus konsisten');
  }
});

test('packetizeFrame: SSRC konsisten antar frame', () => {
  const ssrc = 0x11223344;
  for (const start of [0, 500]) {
    const au = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0x65, 1, 2, 3])]);
    const { packets } = packetizeFrame({ accessUnit: au, sequenceStart: start, timestamp: 0, ssrc, mtu: MTU_SAFE_BYTES });
    assert.strictEqual(parseRtpHeader(packets[0].payload).ssrc, ssrc, 'SSRC harus sama');
  }
});

test('clock rate: 90 kHz', () => {
  assert.strictEqual(CLOCK_RATE_HZ, 90000);
  assert.strictEqual(CLOCK_RATE_HZ / 30, 3000, '30 fps = 3000 tick/frame');
  assert.strictEqual(CLOCK_RATE_HZ / 60, 1500, '60 fps = 1500 tick/frame');
});

console.log(`\n${passed} lulus, ${failed} gagal.`);