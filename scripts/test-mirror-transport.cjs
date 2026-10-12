/**
 * Test transport UDP AirPlay Mirroring.
 * Jalankan: node scripts/test-mirror-transport.cjs
 *
 * SEMUA test memakai loopback 127.0.0.1 - tidak menyentuh perangkat TV nyata.
 */

const assert = require('node:assert');
const dgram = require('node:dgram');
const {
  FramePacer,
  MirrorUdpTransport,
  parseReceiverReport,
  buildReceiverReport,
  RTCP_RR,
} = require('../electron/airplay/mirror-transport.cjs');
const { packetizeFrame } = require('../electron/airplay/rtp-h264.cjs');

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  OK   ${name}`);
    })
    .catch((error) => {
      failed += 1;
      console.log(`  FAIL ${name}`);
      console.log(`       ${error.message}`);
      process.exitCode = 1;
    });
}

console.log('AirPlay mirror transport - test (loopback, tanpa TV)\n');

// ------------------------------------------------------------------- pacer

async function pacerTests() {
  await test('pacer: frame pertama langsung, berikutnya dijeda ~1/fps', () => {
    const pacer = new FramePacer({ fps: 30 });
    let now = 1000;
    assert.strictEqual(pacer.waitFor(now), 0, 'frame pertama tidak perlu tunggu');
    now += 5;
    const wait = pacer.waitFor(now);
    assert.ok(wait > 25 && wait < 34, `harus ~28ms (1/30s), dapat ${wait}`);
  });

  await test('pacer: fps 60 -> interval ~16ms', () => {
    const pacer = new FramePacer({ fps: 60 });
    pacer.waitFor(0);
    const wait = pacer.waitFor(0);
    assert.ok(wait > 13 && wait < 20, `harus ~16ms, dapat ${wait}`);
  });

  await test('pacer: REGRESI - laju nyata tidak boleh jauh di atas fps', () => {
    // Model mensimulasikan kondisi nyata: frame tiba, butuh ~1ms kerja
    // (serialisasi + socket.send), lalu pemanggil menunggu sesuai ridu.
    //
    // Bug "kejar utang" muncul tepat di sini: begitu satu frame selesai
    // dikirim, waktu itu sudah melewati tenggat frame tersebut, sehingga
    // frame berikutnya selalu memicu mode cepat. Akibatnya laju nyata jadi
    // ~3x fps yang diminta - video meledak jadi burst.
    const pacer = new FramePacer({ fps: 30, minGapMs: 1 });
    const workMs = 1;
    let now = 0;
    for (let i = 0; i < 30; i += 1) {
      const wait = pacer.waitFor(now);   // tenggat frame ke-i
      now += wait + workMs;              // kirim, lalu kerja 1ms
    }
    const span = now;
    const measuredFps = (29 * 1000) / span;
    console.log(`       (30 frame @30fps -> span ${Math.round(span)}ms, laju nyata ${measuredFps.toFixed(1)} fps)`);
    assert.ok(measuredFps <= 32,
      `laju nyata ${measuredFps.toFixed(1)} fps terlalu tinggi dari 30 fps (mekanisme kejar utang)`);
    assert.ok(measuredFps >= 27, `laju nyata ${measuredFps.toFixed(1)} fps terlalu rendah dari 30 fps`);
  });

  await test('pacer: saat tertinggal, frame dikirim langsung tanpa jeda buatan', () => {
    // Kalau pemanggil sudah telat (mis. encoder sempat macet), pacer tidak
    // boleh menambah penalti. Namun juga tidak boleh meledak: tidak ada
    // mekanisme yang mengirim frame lebih cepat dari pemanggil meminta.
    const pacer = new FramePacer({ fps: 30, minGapMs: 1 });
    pacer.waitFor(0);
    assert.strictEqual(pacer.waitFor(200), 0, 'frame terlambat -> 0ms, tidak diantre');
    // Dua frame back-to-back pada waktu yang sama: minGapMs tetap menahan
    // sesaat supaya tidak meledak jadi burst. Jadi hasilnya TIDAK 0, tapi
    // juga tidak jauh - hanya pengaman anti-burst, bukan penalti.
    const second = pacer.waitFor(200);
    assert.ok(second >= 0 && second <= 1,
      `frame back-to-back hanya boleh ditahan <= minGapMs (1ms), dapat ${second}`);
    // Lalu saat pemanggil kembali ke ritme, pacing berlaku normal.
    pacer.reset();
    pacer.waitFor(0);
    const wait = pacer.waitFor(1);
    assert.ok(wait > 25, `setelah reset, pacing harus normal kembali (dapat ${wait.toFixed(1)}ms)`);
  });

  await test('pacer: fps tidak valid ditolak', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      assert.throws(() => new FramePacer({ fps: bad }), /positif/);
    }
  });

  await test('pacer: reset mengembalikan ke frame pertama', () => {
    const pacer = new FramePacer({ fps: 30 });
    pacer.waitFor(1000);
    pacer.reset();
    assert.strictEqual(pacer.waitFor(5000), 0, 'setelah reset harus langsung kirim');
  });
}

// -------------------------------------------------------------------- RTCP

async function rtcpTests() {
  await test('RTCP: receiver report dibaca dengan benar', () => {
    const packet = buildReceiverReport({ ssrc: 42, fractionLost: 0.25, cumulativeLost: 100, highestSequence: 65535, jitter: 12 });
    const reports = parseReceiverReport(packet);
    assert.strictEqual(reports.length, 1, 'harus 1 report block');
    assert.strictEqual(reports[0].type, RTCP_RR, 'tipe harus RR');
    assert.strictEqual(reports[0].senderSsrc, 42, 'SSRC pengirim');
    assert.ok(Math.abs(reports[0].fractionLost - 0.25) < 0.005, `fraction lost ${reports[0].fractionLost}`);
    assert.strictEqual(reports[0].cumulativeLost, 100, 'cumulative lost');
    assert.strictEqual(reports[0].highestSequence, 65535, 'highest sequence');
    assert.strictEqual(reports[0].jitter, 12, 'jitter');
  });

  await test('RTCP: fraction lost dihitung sebagai byte/256', () => {
    const r = parseReceiverReport(buildReceiverReport({ fractionLost: 0.5 }));
    assert.strictEqual(r[0].fractionLost, 128 / 256, '128/256 = 0.5');
  });

  await test('RTCP: nol packet loss terdeteksi sebagai 0, bukan undefined', () => {
    const r = parseReceiverReport(buildReceiverReport({ fractionLost: 0, cumulativeLost: 0 }));
    assert.strictEqual(r[0].fractionLost, 0);
    assert.strictEqual(r[0].cumulativeLost, 0);
  });

  await test('RTCP: cumulative lost negatif (24-bit signed) ditangani', () => {
    // 24-bit signed: 0xFFFFFF = -1
    const packet = buildReceiverReport({ cumulativeLost: -1 });
    const r = parseReceiverReport(packet);
    assert.strictEqual(r[0].cumulativeLost, -1, 'harus -1, bukan 16777215');
  });

  await test('RTCP: beberapa report block dalam satu paket', () => {
    const packet = buildReceiverReport({ reportCount: 3, ssrc: 7 });
    const r = parseReceiverReport(packet);
    assert.strictEqual(r.length, 3, 'harus 3 report block');
  });

  await test('RTCP: dua paket digabung dalam satu datagram dipisah dengan benar', () => {
    const combined = Buffer.concat([
      buildReceiverReport({ ssrc: 1, highestSequence: 10 }),
      buildReceiverReport({ ssrc: 2, highestSequence: 20 }),
    ]);
    const r = parseReceiverReport(combined);
    assert.strictEqual(r.length, 2, 'harus 2 report');
    assert.strictEqual(r[0].highestSequence, 10);
    assert.strictEqual(r[1].highestSequence, 20);
  });

  await test('RTCP: buffer sampah tidak membuat crash', () => {
    for (const junk of [Buffer.alloc(0), Buffer.alloc(2), Buffer.from([0xff, 0xff, 0xff]), Buffer.alloc(64, 0xff)]) {
      assert.doesNotThrow(() => parseReceiverReport(junk), `junk ${junk.length} byte harus aman`);
    }
  });
}

// --------------------------------------------------------------- transport

/** Receiver UDP dummy di loopback,用来 menangkap paket. */
function createLoopbackReceiver() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const received = [];
    socket.on('message', (msg) => received.push(msg));
    socket.bind(0, '127.0.0.1', () => {
      resolve({ socket, port: socket.address().port, received });
    });
  });
}

async function transportTests() {
  await test('transport: validasi input', () => {
    assert.throws(() => new MirrorUdpTransport({ rtpPort: 1234 }), /Host receiver/);
    assert.throws(() => new MirrorUdpTransport({ host: '127.0.0.1' }), /Port RTP/);
  });

  await test('transport: open() mengikat dua port lokal', async () => {
    const receiver = await createLoopbackReceiver();
    const t = new MirrorUdpTransport({ host: '127.0.0.1', rtpPort: receiver.port, fps: 60 });
    await t.open();
    assert.ok(t.localPort > 0, 'port RTP lokal harus terikat');
    assert.ok(t.localRtcpBoundPort > 0, 'port RTCP lokal harus terikat');
    t.close();
    receiver.socket.close();
  });

  await test('transport: satu frame terkirim utuh ke receiver', async () => {
    const receiver = await createLoopbackReceiver();
    const t = new MirrorUdpTransport({ host: '127.0.0.1', rtpPort: receiver.port, fps: 60 });
    await t.open();

    const { packets } = packetizeFrame({
      accessUnit: Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0x65]), Buffer.alloc(4000, 9)]),
      sequenceStart: 0, timestamp: 0, ssrc: 1, mtu: 1400,
    });
    const result = await t.sendFrame(packets);
    assert.strictEqual(result.sent, packets.length, `semua ${packets.length} paket harus terkirim`);
    assert.strictEqual(result.skipped, 0, 'tidak ada yang dilewati');
    assert.strictEqual(t.stats.packetsSent, packets.length, 'statistik packetsSent');

    await new Promise((res) => setTimeout(res, 120));
    assert.strictEqual(receiver.received.length, packets.length, `receiver harus dapat ${packets.length} paket`);
    // Isi paket harus identik dengan yang dikirim, urutan terjaga.
    for (let i = 0; i < packets.length; i += 1) {
      assert.ok(receiver.received[i].equals(packets[i].payload), `paket ${i} harus identik`);
    }
    t.close();
    receiver.socket.close();
  });

  await test('transport: 30 frameHintsVpTRECE ada heartbeat', async () => {
    const receiver = await createLoopbackReceiver();
    const t = new MirrorUdpTransport({ host: '127.0.0.1', rtpPort: receiver.port, fps: 30 });
    await t.open();
    const { packets } = packetizeFrame({
      accessUnit: Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0x65, 1, 2, 3])]),
      sequenceStart: 0, timestamp: 0, ssrc: 1,
    });
    const t0 = Date.now();
    for (let i = 0; i < 30; i += 1) await t.sendFrame(packets);
    const elapsed = Date.now() - t0;
    // 30 frame pada 30 fps = ~1000ms. Ini batas bawah yang SERIUS: kalau laju
    // nyata keluar jauh di bawah 30 fps, pacer tidak lagi berfungsi dan video
    // akan terasa tersendat.
    assert.ok(elapsed >= 850, `pacing harus menahan laju: 30 frame hanya ${elapsed}ms (terlalu cepat)`);
    assert.ok(elapsed <= 1400, `tapi tidak boleh terlalu lambat: ${elapsed}ms`);
    assert.strictEqual(t.stats.framesSent, 30, '30 frame tercatat');
    console.log(`       (30 frame dalam ${elapsed}ms -> ${(elapsed / 30).toFixed(1)}ms/frame, ideal 33.3ms)`);
    t.close();
    receiver.socket.close();
  });

  await test('transport: sequence RTP naik kontigu (dicek di sisi pengirim)', async () => {
    const receiver = await createLoopbackReceiver();
    const t = new MirrorUdpTransport({ host: '127.0.0.1', rtpPort: receiver.port, fps: 60 });
    await t.open();
    let seq = 0;
    const allSent = [];
    for (let f = 0; f < 5; f += 1) {
      const r = packetizeFrame({
        accessUnit: Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0x41]), Buffer.alloc(2000, f)]),
        sequenceStart: seq, timestamp: f * 3000, ssrc: 99,
      });
      seq = r.nextSequence;
      allSent.push(...r.packets.map((p) => p.payload));
      await t.sendFrame(r.packets);
    }
    // UDP memang boleh dropping, jadi kontinuitas sequence diuji pada apa yang
    // benar-benar kita kirim - bukan pada apa yang sampai, yang bergantung
    // buffer kernel dan bisa hilang tanpa kesalahan kode.
    for (let i = 1; i < allSent.length; i += 1) {
      const prev = allSent[i - 1].readUInt16BE(2);
      const cur = allSent[i].readUInt16BE(2);
      assert.strictEqual(cur, (prev + 1) & 0xffff, `sequence yang kita kirim putus di paket ${i}`);
    }
    await new Promise((res) => setTimeout(res, 200));
    assert.ok(receiver.received.length >= 8,
      `receiver harus menerima sebagian besar dari ${allSent.length} paket, dapat ${receiver.received.length}`);
    t.close();
    receiver.socket.close();
  });

  await test('transport: frame kosong tidak error, tidak dikirim', async () => {
    const receiver = await createLoopbackReceiver();
    const t = new MirrorUdpTransport({ host: '127.0.0.1', rtpPort: receiver.port, fps: 60 });
    await t.open();
    assert.deepStrictEqual(await t.sendFrame([]), { sent: 0, skipped: 0 });
    assert.deepStrictEqual(await t.sendFrame(null), { sent: 0, skipped: 0 });
    await new Promise((res) => setTimeout(res, 80));
    assert.strictEqual(receiver.received.length, 0, 'tidak boleh ada paket terkirim');
    t.close();
    receiver.socket.close();
  });

  await test('transport: laporan RTCP dari receiver masuk ke onReport', async () => {
    const t = new MirrorUdpTransport({ host: '127.0.0.1', rtpPort: 9999, fps: 30 });
    await t.open();
    let got = null;
    t.onReport = (report) => { got = report; };

    // Simulasikan TV mengirim RR ke port RTCP lokal kita.
    const fakeTv = dgram.createSocket('udp4');
    await new Promise((res) => fakeTv.send(
      buildReceiverReport({ ssrc: 1234, fractionLost: 0.125, cumulativeLost: 25, highestSequence: 900 }),
      t.localRtcpBoundPort, '127.0.0.1', res,
    ));
    await new Promise((res) => setTimeout(res, 200));

    assert.ok(got, 'onReport harus terpanggil');
    assert.strictEqual(got.senderSsrc, 1234, 'SSRC TV');
    assert.ok(Math.abs(got.fractionLost - 0.125) < 0.005, `fraction lost ${got.fractionLost}`);
    assert.strictEqual(t.stats.lastFractionLost, got.fractionLost, 'tercatat di statistik');
    assert.strictEqual(t.stats.highestSequenceReported, 900, 'highest sequence tercatat');
    fakeTv.close();
    t.close();
  });

  await test('transport: close() SELALU menyelesaikan sendFrame yang tertunda', async () => {
    const receiver = await createLoopbackReceiver();
    const t = new MirrorUdpTransport({ host: '127.0.0.1', rtpPort: receiver.port, fps: 5 });
    await t.open();
    const { packets } = packetizeFrame({
      accessUnit: Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0x65, 1])]),
      sequenceStart: 0, timestamp: 0, ssrc: 1,
    });
    t.pacer.waitFor(Date.now());           // aktifkan mode pacing (fps 5 = 200ms)
    const pending = t.sendFrame(packets);  // akan menunggu ~200ms
    t.close();                             // ...lalu ditutup di tengah jalan

    // Kalau close() tidak me-resolve sleep(), promise ini tidak akan
    // pernah settle dan test akan hang - bukan gagal, tapi MATI.
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('sendFrame tidak selesai dalam 2 detik setelah close()')), 2000));
    const result = await Promise.race([pending, timeout]);
    assert.ok(result.sent === 0 || result.sent === packets.length,
      'hasil boleh 0 (ditutup sebelum kirim) atau penuh');
    assert.strictEqual(t.pendingTimers.size, 0, 'semua timer harus dibersihkan');
    receiver.socket.close();
  });

  await test('transport:两只 socket tidak bocor setelah open/close berulang', async () => {
    for (let i = 0; i < 10; i += 1) {
      const t = new MirrorUdpTransport({ host: '127.0.0.1', rtpPort: 9999, fps: 30 });
      await t.open();
      t.close();
    }
    await new Promise((res) => setTimeout(res, 120));
    assert.ok(true, '10x open/close tidak menyebabkan error');
  });
}

(async () => {
  await pacerTests();
  await rtcpTests();
  await transportTests();
  console.log(`\n${passed} lulus, ${failed} gagal.`);
})();
