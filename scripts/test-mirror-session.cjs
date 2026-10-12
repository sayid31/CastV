/**
 * Test alur AirPlay Mirroring lengkap memakai MOCK RECEIVER di loopback.
 * Jalankan: node scripts/test-mirror-session.cjs
 *
 * Mock TV di sini bukan sekadar stub: ia benar-benar memverifikasi apa yang
 * dikirim CastV - mulai dari apakah plist bisa dibaca, apakah kunci FairPlay
 * bisa dibuka RSA dengan private key miliknya sendiri, sampai apakah payload
 * RTP bisa didekripsi dan direkonstruksi kembali menjadi NAL H.264 asli.
 *
 * Semua berjalan di 127.0.0.1. Tidak ada perangkat nyata yang disentuh.
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const net = require('node:net');
const dgram = require('node:dgram');
const bplistCreator = require('bplist-creator');
const { parseBuffer: parseBplist } = require('bplist-parser');
const { MirrorSession } = require('../electron/airplay/mirror-session.cjs');
const {
  buildSetupPlist,
  buildPlayPlist,
  readPlist,
  readNegotiatedPorts,
  makeDeviceId,
  MIRROR_DEFAULTS,
  resolveMirrorOptions,
} = require('../electron/airplay/mirror-plist.cjs');
const { packetizeFrame, parseRtpHeader, splitAnnexB, RTP_HEADER_BYTES } = require('../electron/airplay/rtp-h264.cjs');
const { createVideoCipher, unpadFromBlock } = require('../electron/airplay/mirror-crypto.cjs');
const { decryptFairPlaySessionKey } = require('../electron/airplay/fairplay-session.cjs');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  OK   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('AirPlay mirror session - test (mock TV, tanpa perangkat nyata)\n');

// ============================================================ MOCK RECEIVER

/**
 * Receiver tiruan yang meniru perilaku AirPlay 1 secukupnya untuk menguji
 * alur CastV:
 *   - hummed ROS /info dengan public key RSA miliknya sendiri
 *   - hummed ROS /setup: membaca plist, membuka kunci FairPlay dengan private
 *     key-nya, lalu membalas port-port UDP
 *   - hummed ROS /play: mencatat parameter video
 *   - menerima paket RTP, mendekripsi payload, merekonstruksi NAL H.264
 */
function createMockReceiver({ cipherMode = 'cbc', announcePorts = true } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pkBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

  const state = {
    name: 'Mock TV',
    model: 'MockTV1,1',
    deviceID: '00:11:22:33:44:55',
    features: '0x527FFFF7,0x1E',
    pk: pkBase64,
  };

  const videoSockets = [];
  const received = {
    setupPlist: null,
    playPlist: null,
    decryptedKey: null,
    decryptedIv: null,
    rtpPackets: [],
    nalsRebuilt: [],
    requests: [],
  };

  let cipher = null;
  const server = net.createServer((socket) => {
    let rx = Buffer.alloc(0);
    socket.on('error', () => { /* client menutup - normal */ });
    socket.on('data', (data) => {
      rx = Buffer.concat([rx, data]);
      for (;;) {
        const end = rx.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = rx.subarray(0, end).toString('utf8');
        const lines = head.split('\r\n');
        const [method, target] = (lines.shift() || '').split(' ');
        const headers = {};
        for (const line of lines) {
          const i = line.indexOf(':');
          if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        const length = Number.parseInt(headers['content-length'] || '0', 10) || 0;
        if (rx.length < end + 4 + length) return;
        const body = rx.subarray(end + 4, end + 4 + length);
        rx = rx.subarray(end + 4 + length);
        received.requests.push(`${method} ${target}`);

        if (method === 'GET' && target === '/info') {
          const payload = bplistCreator(state);
          socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/x-apple-binary-plist\r\nContent-Length: ${payload.length}\r\n\r\n`);
          socket.write(payload);
        } else if (method === 'POST' && target === '/setup') {
          const plist = readPlist(body);
          received.setupPlist = plist;
          // Receiver membuka (key || iv) dengan private key-nya sendiri.
          try {
            const opened = decryptFairPlaySessionKey({
              encrypted: Buffer.from(plist.key || '', 'base64'),
              receiverPrivateKey: privateKey,
            });
            received.decryptedKey = opened.sessionKey;
            received.decryptedIv = opened.iv;
            cipher = createVideoCipher({
              sessionKey: opened.sessionKey, iv: opened.iv, mode: cipherMode,
            });
          } catch (error) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
            return;
          }
          const udp = dgram.createSocket('udp4');
          udp.bind(0, '127.0.0.1', () => {
            const videoPort = udp.address().port;
            videoSockets.push(udp);
            // Receiver Raid UDP: reconstruct NAL dari payload yang didekripsi.
            udp.on('message', (msg) => {
              try {
                const rtp = parseRtpHeader(msg);
                const payload = cipher.decrypt(msg.subarray(RTP_HEADER_BYTES));
                received.rtpPackets.push({
                  sequence: rtp.sequence, timestamp: rtp.timestamp,
                  marker: rtp.marker === 1, ssrc: rtp.ssrc, payload,
                });
              } catch (error) {
                received.rtpPackets.push({ error: error.message });
              }
            });
            const extra = announcePorts ? `EventPort: ${videoPort}\r\nTimingPort: ${videoPort}\r\n` : '';
            socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/x-apple-binary-plist\r\n${extra}Content-Length: 0\r\n\r\n`);
          });
        } else if (method === 'POST' && target === '/play') {
          received.playPlist = readPlist(body);
          socket.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
        } else if (method === 'POST' && target === '/stop') {
          socket.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
          socket.end();
        } else {
          socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
        }
      }
    });
  });

  const ready = new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      // Daikin socket UDP pasif supaya mock bisa menerima video.
      const sink = dgram.createSocket('udp4');
      sink.bind(0, '127.0.0.1', () => {
        resolve({
          port: server.address().port,
          pkBase64,
          privateKey,
          received,
          state,
          cleanup: () => {
            for (const s of videoSockets) { try { s.close(); } catch { /* ignore */ } }
            try { sink.close(); } catch { /* ignore */ }
            server.close();
          },
        });
      });
    });
  });
  return { ready, cleanup: () => server.close() };
}

// ================================================================ TEST PLIST

async function plistTests() {
  await test('makeDeviceId: format UUID 8-4-4-4-12 huruf besar', () => {
    const id = makeDeviceId(crypto.randomBytes(16));
    assert.ok(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(id), `bentuk salah: ${id}`);
    assert.notStrictEqual(id, makeDeviceId(crypto.randomBytes(16)), 'harus acak per panggilan');
  });

  await test('plist: /setup memuat deviceID, sessionUUID, timing, key', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const { createFairPlaySessionKey } = require('../electron/airplay/fairplay-session.cjs');
    const sessionKey = createFairPlaySessionKey({
      receiverPublicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    });
    const body = buildSetupPlist({
      deviceId: makeDeviceId(crypto.randomBytes(16)),
      sessionUuid: makeDeviceId(crypto.randomBytes(16)),
      sessionKey,
      timing: true,
    });
    const parsed = parseBplist(body)[0];
    for (const field of ['deviceID', 'sessionUUID', 'timing', 'key']) {
      assert.ok(parsed[field] !== undefined, `field ${field} harus ada`);
    }
    assert.strictEqual(parsed.timing, 1, 'timing aktif = 1');
    // Receiver harus bisa membukanya dengan private key-nya.
    const opened = decryptFairPlaySessionKey({
      encrypted: Buffer.from(parsed.key, 'base64'), receiverPrivateKey: privateKey,
    });
    assert.deepStrictEqual(opened.sessionKey, sessionKey.sessionKey, 'session key sampai ke receiver utuh');
    assert.deepStrictEqual(opened.iv, sessionKey.iv, 'IV sampai ke receiver utuh');
  });

  await test('plist: /play memuat fps, width, height sebagai string', () => {
    const body = buildPlayPlist({
      deviceId: 'AA', sessionUuid: 'BB', width: 1280, height: 720, fps: 60,
    });
    const parsed = parseBplist(body)[0];
    assert.strictEqual(parsed.fps, '60', 'fps harus string');
    assert.strictEqual(parsed.width, '1280');
    assert.strictEqual(parsed.height, '720');
    assert.strictEqual(parsed.deviceID, 'AA');
  });

  await test('plist: /play tidak boleh punya Content-Location (itu HLS)', () => {
    const parsed = parseBplist(buildPlayPlist({ deviceId: 'AA', sessionUuid: 'BB' }))[0];
    assert.strictEqual(parsed['Content-Location'], undefined,
      'mirroring mengirim lewat UDP, bukan URL HLS');
  });

  await test('plist: field wajib kosong ditolak lebih awal', () => {
    assert.throws(() => buildSetupPlist({ sessionUuid: 'X', sessionKey: { keyField: 'k' } }), /deviceId/);
    assert.throws(() => buildSetupPlist({ deviceId: 'X', sessionKey: { keyField: 'k' } }), /sessionUuid/);
    assert.throws(() => buildSetupPlist({ deviceId: 'X', sessionUuid: 'Y' }), /sessionKey/);
    assert.throws(() => buildPlayPlist({ sessionUuid: 'Y' }), /deviceId/);
  });

  await test('readPlist: buffer rusak tidak melempar, hanya kosong', () => {
    for (const junk of [Buffer.alloc(0), Buffer.from([1, 2, 3]), Buffer.alloc(50, 0xab)]) {
      assert.doesNotThrow(() => readPlist(junk));
      assert.deepStrictEqual(readPlist(junk), {});
    }
  });

  await test('readNegotiatedPorts:=ejak various ejaan header firmware', () => {
    assert.deepStrictEqual(readNegotiatedPorts({ EventPort: '6000' }), { eventPort: 6000, timingPort: null, controlPort: null });
    assert.strictEqual(readNegotiatedPorts({ 'Event-Port': '6001' }).eventPort, 6001, 'ejaan dengan strip');
    assert.strictEqual(readNegotiatedPorts({ eventport: '6002' }).eventPort, 6002, 'huruf kecil');
    assert.strictEqual(readNegotiatedPorts({ 'x-apple-eventport': '6003' }).eventPort, 6003, 'varian x-apple');
    assert.strictEqual(readNegotiatedPorts({ TimingPort: '7000' }).timingPort, 7000);
  });

  await test('readNegotiatedPorts: header hilang = null, bukan 0 atau error', () => {
    assert.deepStrictEqual(readNegotiatedPorts({}), { eventPort: null, timingPort: null, controlPort: null });
    assert.strictEqual(readNegotiatedPorts({ EventPort: '' }).eventPort, null, 'string kosong bukan port 0');
    assert.strictEqual(readNegotiatedPorts({ EventPort: 'abc' }).eventPort, null, 'bukan angka diabaikan');
  });

  await test('resolveMirrorOptions: default lalu ditimpa user', () => {
    assert.strictEqual(resolveMirrorOptions().fps, MIRROR_DEFAULTS.fps, 'default dipakai');
    assert.strictEqual(resolveMirrorOptions({ fps: 60 }).fps, 60, 'user menimpa');
    assert.strictEqual(resolveMirrorOptions({ fps: 60 }).cipherMode, MIRROR_DEFAULTS.cipherMode, 'yang lain tetap default');
  });
}

// ========================================================= TEST SESSI UTAMA

async function sessionTests() {
  for (const cipherMode of ['cbc', 'cfb']) {
    await test(`SESI LENGKAP mode ${cipherMode}: setup -> play -> video sampai ke receiver`, async () => {
      const mock = await createMockReceiver({ cipherMode }).ready;
      const states = [];
      const session = new MirrorSession({
        host: '127.0.0.1',
        port: mock.port,
        options: { fps: 60, cipherMode },
        onStateChange: (s) => states.push(s),
      });

      const diag = await session.start();
      assert.ok(session.started, 'sesi harus aktif setelah start()');

      // Receiver harus melihat urutan request yang benar.
      assert.ok(mock.received.requests.includes('GET /info'), 'harus baca /info');
      assert.ok(mock.received.requests.includes('POST /setup'), 'harus kirim /setup');
      assert.ok(mock.received.requests.includes('POST /play'), 'harus kirim /play');

      // Kunci FairPlay HARUS bisa dibuka receiver dengan private key-nya.
      assert.ok(mock.received.decryptedKey, 'receiver harus berhasil membuka session key');
      assert.strictEqual(mock.received.decryptedKey.length, 16, 'session key 16 byte');
      assert.strictEqual(mock.received.decryptedIv.length, 16, 'IV 16 byte');

      // Parameter video harus sampai benar.
      assert.strictEqual(mock.received.playPlist.fps, '60', 'fps sampai');
      assert.strictEqual(mock.received.playPlist.width, '1920');

      // Negotiate port harus terdeteksi dari balasan /setup.
      assert.ok(diag.negotiated.eventPort > 0, 'event port terdeteksi');

      // Sekarang kirim 3 frame H.264 sungguhan.
      const nalPayload = Buffer.concat([Buffer.from([0x65]), Buffer.alloc(2500, 0x7a)]);
      const accessUnit = Buffer.concat([Buffer.from([0, 0, 0, 1]), nalPayload]);
      for (let i = 0; i < 3; i += 1) {
        const r = await session.sendFrame(accessUnit);
        assert.ok(r.packets >= 2, `frame ${i} harus jadi beberapa paket FU-A`);
      }
      await new Promise((res) => setTimeout(res, 250));

      // Receiver harus menerima paket, dan payload-nya harus bisa dibuka.
      const good = mock.received.rtpPackets.filter((p) => !p.error);
      assert.ok(good.length >= 6, `receiver harus dapat >=6 paket, dapat ${good.length}`);
      assert.strictEqual(mock.received.rtpPackets.filter((p) => p.error).length, 0,
        'tidak boleh ada payload yang gagal didekripsi');

      // Header RTP harus tetap utuh (tidak dienkripsi) & timestamp naik.
      const stamps = good.map((p) => p.timestamp);
      assert.strictEqual(stamps[0], good[0].timestamp);
      for (let i = 1; i < stamps.length; i += 1) {
        assert.ok(stamps[i] === stamps[i - 1] || stamps[i] > stamps[i - 1], 'timestamp tidak boleh mundur');
      }
      // Hanya satu marker di akhir tiap frame.
      const markers = good.filter((p) => p.marker).length;
      assert.strictEqual(markers, 3, `harus tepat 3 marker (satu per frame), dapat ${markers}`);

      await session.stop();
      assert.ok(states.includes('playing'), 'state playing harus tercatat');
      assert.ok(states.includes('setup-complete'), 'state setup harus tercatat');
      mock.cleanup();
    });
  }

  await test('SESI: NAL bisa direkonstruksi utuh setelah enkripsi + RTP', async () => {
    const mock = await createMockReceiver({ cipherMode: 'cbc' }).ready;
    const session = new MirrorSession({ host: '127.0.0.1', port: mock.port, options: { fps: 30, cipherMode: 'cbc' } });
    await session.start();

    const original = Buffer.concat([Buffer.from([0x67]), Buffer.alloc(200, 0xab)]);  // SPS
    const accessUnit = Buffer.concat([Buffer.from([0, 0, 0, 1]), original]);
    await session.sendFrame(accessUnit);
    await new Promise((res) => setTimeout(res, 200));

    const packets = mock.received.rtpPackets.filter((p) => !p.error);
    assert.ok(packets.length >= 1, 'paket harus sampai');
    // Receiver harus bisa membedakan dua bentuk payload:
    //   Single NAL Unit - NAL kecil, payload langsung tanpa header tambahan
    //   FU-A            - NAL besar, ada 2 byte header (indicator + FU header)
    const first = packets[0].payload;
    const isFragmented = (first[0] & 0x1f) === 28;
    let rebuilt;
    if (isFragmented) {
      const nalHeader = (first[0] & 0x60) | (first[1] & 0x1f);
      const parts = [Buffer.from([nalHeader]), first.subarray(2)];
      for (let i = 1; i < packets.length; i += 1) parts.push(packets[i].payload.subarray(2));
      rebuilt = Buffer.concat(parts);
    } else {
      // Single NAL Unit: payload sudah NAL itu sendiri, tanpa transformasi.
      assert.strictEqual(packets.length, 1, 'NAL tunggal harus jadi tepat satu paket');
      rebuilt = first;
    }
    assert.strictEqual(rebuilt.length, original.length, `ukuran harus sama (${rebuilt.length} vs ${original.length})`);
    assert.deepStrictEqual(rebuilt, original, 'NAL asli harus pulih byte-per-byte');

    await session.stop();
    mock.cleanup();
  });

  await test('SESI: 30 frame menahan laju ~30 fps', async () => {
    const mock = await createMockReceiver({ cipherMode: 'cfb' }).ready;
    const session = new MirrorSession({ host: '127.0.0.1', port: mock.port, options: { fps: 30, cipherMode: 'cfb' } });
    await session.start();
    const accessUnit = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0x41, 1, 2, 3])]);
    const t0 = Date.now();
    for (let i = 0; i < 30; i += 1) await session.sendFrame(accessUnit);
    const elapsed = Date.now() - t0;
    console.log(`       (30 frame dalam ${elapsed}ms -> ${(elapsed / 30).toFixed(1)}ms/frame)`);
    assert.ok(elapsed >= 700, `laju harus ~30fps, hanya ${elapsed}ms (terlalu cepat = burst)`);
    assert.ok(elapsed <= 1500, `terlalu lambat: ${elapsed}ms`);
    await session.stop();
    mock.cleanup();
  });

  await test('SESI: receiver tanpa public key ditolak dengan pesan jelas', async () => {
    const server = net.createServer((socket) => {
      socket.on('error', () => { /* ignore */ });
      socket.on('data', () => {
        const payload = bplistCreator({ name: 'Tanpa PK', model: 'X', deviceID: 'a' });
        socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/x-apple-binary-plist\r\nContent-Length: ${payload.length}\r\n\r\n`);
        socket.write(payload);
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const session = new MirrorSession({ host: '127.0.0.1', port: server.address().port });
    await assert.rejects(() => session.start(), /public key|mirroring tidak didukung/i,
      'harus gagal dengan pesan yang bisa dibaca user');
    await session.stop();
    server.close();
  });

  await test('SESI: kunci FairPlay ditolak receiver diteruskan sebagai error', async () => {
    // Simulasi receiver yang MEMBUKA public key berbeda dari private key yang
    // dimilikinya: CastV mengenkripsi ke kunci yang salah, jadi receiver tidak
    // bisa membukanya dan harus menolak sesi.
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const mock = await createMockReceiver({ cipherMode: 'cbc' }).ready;
    // Ganti public key yang diumumkan /info, TETAP private key internally.
    mock.state.pk = other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

    const session = new MirrorSession({ host: '127.0.0.1', port: mock.port });
    await assert.rejects(() => session.start(), /401|Unauthorized|failed/i,
      'error dari receiver harus diteruskan, bukan ditelan');
    await session.stop();
    mock.cleanup();
  });

  await test('SESI: receiver tidak menyebut port -> fallback tidak crash', async () => {
    const mock = await createMockReceiver({ announcePorts: false }).ready;
    const session = new MirrorSession({ host: '127.0.0.1', port: mock.port, options: { fps: 30 } });
    await session.start();
    assert.ok(session.started, 'harus tetap jalan dengan fallback port');
    await session.stop();
    mock.cleanup();
  });

  await test('SESI: stop() dua kali aman (idempoten)', async () => {
    const mock = await createMockReceiver().ready;
    const session = new MirrorSession({ host: '127.0.0.1', port: mock.port });
    await session.start();
    await session.stop();
    await assert.doesNotReject(() => session.stop(), 'panggil stop kedua tidak boleh error');
    mock.cleanup();
  });

  await test('SESI: sendFrame setelah stop tidak melempar, mengembalikan 0', async () => {
    const mock = await createMockReceiver().ready;
    const session = new MirrorSession({ host: '127.0.0.1', port: mock.port });
    await session.start();
    await session.stop();
    const r = await session.sendFrame(Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0x65])]));
    assert.deepStrictEqual(r, { sent: 0, packets: 0 }, 'harus diam, bukan crash');
    mock.cleanup();
  });

  await test('SESI: start() dua kali tidak menegosiasikan ulang', async () => {
    const mock = await createMockReceiver().ready;
    const session = new MirrorSession({ host: '127.0.0.1', port: mock.port });
    await session.start();
    const before = mock.received.requests.filter((r) => r === 'POST /play').length;
    await session.start();
    const after = mock.received.requests.filter((r) => r === 'POST /play').length;
    assert.strictEqual(after, before, 'start() kedua tidak boleh kirim /play lagi');
    await session.stop();
    mock.cleanup();
  });

  await test('SESI: timestamp RTP naik sesuai clock 90 kHz', async () => {
    const mock = await createMockReceiver({ cipherMode: 'cfb' }).ready;
    const session = new MirrorSession({ host: '127.0.0.1', port: mock.port, options: { fps: 30, cipherMode: 'cfb' } });
    await session.start();
    const accessUnit = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0x41, 9, 9])]);
    await session.sendFrame(accessUnit);
    await session.sendFrame(accessUnit);
    await new Promise((res) => setTimeout(res, 200));
    const stamps = mock.received.rtpPackets.filter((p) => !p.error).map((p) => p.timestamp);
    assert.strictEqual(stamps.length, 2, '2 frame');
    const delta = (stamps[1] - stamps[0]) >>> 0;
    assert.strictEqual(delta, 90000 / 30, `harus maju 3000 tick per frame pada 30fps, dapat ${delta}`);
    await session.stop();
    mock.cleanup();
  });
}

(async () => {
  await plistTests();
  await sessionTests();
  console.log(`\n${passed} lulus, ${failed} gagal.`);
  // Server mock & socket UDP menahan event loop tetap hidup; proses memang
  // sudah selesai jadi keluar eksplisit.
  process.exit(failed > 0 ? 1 : 0);
})();
