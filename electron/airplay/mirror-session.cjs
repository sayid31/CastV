/**
 * Orkestrator AirPlay Mirroring (AirPlay 1 / RAOP).
 *
 * Menyatukan seluruh modul yang sudah ada menjadi satu alur:
 *
 *   1. /info        -> baca public key receiver (PUBLIK, tidak ada rahasia)
 *   2. FairPlay     -> session key + IV acak, dienkripsi dengan public key itu
 *   3. /setup       -> negosiasi; receiver membalas port-port UDP
 *   4. /play        -> beritahu receiver parameter video
 *   5. streaming    -> H.264 -> RTP -> enkripsi -> UDP, ber-paced
 *
 * Modul ini SENGAJA tidak mengintegrasikan encoder WebCodecs. Encoder berjalan
 * di renderer (browser) yang punya akses ke getDisplayMedia, sedangkan proses
 * Electron ini menjadi Transport + Negotiator. Antarmuka keduanya cukup
 * dua hal: start() dan sendFrame(accessUnit).
 *
 * Catatan jujur soal ketidakpastian: langkah 3-4 adalah bagian yang paling
 * mungkin meleset terhadap firmware tertentu. Semua parameter yang
 * bersifat firmware dikumpulkan di mirror-plist.cjs (MIRROR_DEFAULTS) supaya
 * penyesuaian cukup dilakukan di satu tempat.
 */

const crypto = require('node:crypto');
const { AirPlayV1Client } = require('../airplay-client.cjs');
const { createFairPlaySessionKey } = require('./fairplay-session.cjs');
const { packetizeFrame, CLOCK_RATE_HZ, RTP_PAYLOAD_TYPE } = require('./rtp-h264.cjs');
const { createVideoCipher } = require('./mirror-crypto.cjs');
const { MirrorUdpTransport } = require('./mirror-transport.cjs');
const {
  BPLIST,
  MIRROR_DEFAULTS,
  makeDeviceId,
  buildSetupPlist,
  buildPlayPlist,
  readPlist,
  readNegotiatedPorts,
  resolveMirrorOptions,
} = require('./mirror-plist.cjs');

class MirrorSession {
  constructor({ host, port = 7000, options = {}, onStateChange, onReport, onError } = {}) {
    if (!host) throw new Error('Host receiver wajib diisi');
    this.host = host;
    this.port = Number(port) || 7000;
    this.options = resolveMirrorOptions(options);
    this.onStateChange = typeof onStateChange === 'function' ? onStateChange : null;
    this.onReport = typeof onReport === 'function' ? onReport : null;
    this.onError = typeof onError === 'function' ? onError : null;

    this.client = new AirPlayV1Client({ host, port: this.port, onClose: () => this.emitState('receiver-closed') });
    this.transport = null;
    this.cipher = null;
    this.sessionKey = null;
    this.deviceId = makeDeviceId(crypto.randomBytes(16));
    this.sessionUuid = makeDeviceId(crypto.randomBytes(16));
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.sequence = crypto.randomInt(0, 0xffff);
    this.timestamp = crypto.randomInt(0, 0xffffffff);
    this.frameIndex = 0;
    this.started = false;
    this.stopped = false;
    this.negotiated = {};
    this.log = [];
  }

  emitState(state, detail) {
    this.log.push({ at: Date.now(), state, detail });
    if (this.onStateChange) {
      try { this.onStateChange(state, detail); } catch { /* never break the session */ }
    }
  }

  /** Catatan diagnostik singkat, dipakai UI dan log. */
  diagnostics() {
    return {
      started: this.started,
      stopped: this.stopped,
      deviceId: this.deviceId,
      frameIndex: this.frameIndex,
      transport: this.transport ? this.transport.stats : null,
      negotiated: this.negotiated,
      steps: this.log,
    };
  }

  /**
   * Jalankan negosiasi penuh dan buka kanal UDP.
   * @returns {Promise<object>} ringkasan hasil
   */
  async start() {
    if (this.started) return this.diagnostics();
    this.emitState('starting');

    // 1. /info - public key receiver.
    const info = await this.client.getInfo();
    if (!info || !info.pk) {
      throw new Error('Receiver tidak mempublikasikan public key (pk) di /info - mirroring tidak didukung.');
    }
    this.emitState('info-received', { model: info.model, name: info.name });

    // 2. FairPlay session key. PUBLIC key receiver dibaca dari /info; tidak
    //    ada data rahasia TV yang dibutuhkan.
    this.sessionKey = createFairPlaySessionKey({
      receiverPublicKeyBase64: info.pk,
      modulus: this.options.rsaPkcs1Padding,
    });
    this.cipher = createVideoCipher({
      sessionKey: this.sessionKey.sessionKey,
      iv: this.sessionKey.iv,
      mode: this.options.cipherMode,
    });
    this.emitState('fairplay-key-ready', { cipherMode: this.options.cipherMode });

    // 3. /setup - negosiasi port.
    const setupBody = buildSetupPlist({
      deviceId: this.deviceId,
      sessionUuid: this.sessionUuid,
      sessionKey: this.sessionKey,
      timing: this.options.timing,
    });
    const setupResponse = await this.client.request('POST', '/setup', {
      headers: {
        'User-Agent': 'AirPlay/550.10',
        'Content-Type': BPLIST,
        'X-Apple-Session-ID': this.sessionUuid,
      },
      body: setupBody,
      timeoutMs: 10000,
    });
    this.negotiated = {
      ...readNegotiatedPorts(setupResponse.headers),
      setupStatus: setupResponse.code,
    };
    const setupEcho = readPlist(setupResponse.body);
    if (setupEcho && Object.keys(setupEcho).length) this.negotiated.setupBody = setupEcho;
    this.emitState('setup-complete', this.negotiated);

    // 4. Buka kanal UDP. Fallback ke RTSP port+1 jika receiver tidak
    //    menyebutkan port khusus - beberapa firmware lama begitu.
    const rtpPort = this.negotiated.timingPort || this.negotiated.eventPort || this.port + 1;
    this.transport = new MirrorUdpTransport({
      host: this.host,
      rtpPort,
      rtcpPort: rtpPort + 1,
      fps: this.options.fps,
      onReport: this.onReport,
      onError: this.onError,
    });
    await this.transport.open();
    this.negotiated.rtpPortUsed = rtpPort;
    this.negotiated.localRtpPort = this.transport.localPort;
    this.emitState('transport-open', {
      rtpPortUsed: rtpPort,
      localRtpPort: this.transport.localPort,
      localRtcpPort: this.transport.localRtcpBoundPort,
    });

    // 5. /play - beritahu receiver agar siap menerima video.
    const playBody = buildPlayPlist({
      deviceId: this.deviceId,
      sessionUuid: this.sessionUuid,
      width: this.options.width,
      height: this.options.height,
      fps: this.options.fps,
      timing: this.options.timing,
    });
    await this.client.request('POST', '/play', {
      headers: {
        'User-Agent': 'AirPlay/550.10',
        'Content-Type': BPLIST,
        'X-Apple-Session-ID': this.sessionUuid,
      },
      body: playBody,
      timeoutMs: 10000,
    });
    this.started = true;
    this.emitState('playing', {
      fps: this.options.fps,
      width: this.options.width,
      height: this.options.height,
      clockRate: CLOCK_RATE_HZ,
    });

    return this.diagnostics();
  }

  /**
   * Kirim satu access unit H.264 (Annex-B).
   *
   * Urutannya penting dan tidak boleh dibalik:
   *   NAL -> paket RTP -> enkripsi payload -> UDP
   *
   * Header RTP 12 byte TIDAK dienkripsi; yang dienkripsi adalah payload
   * H.264 di dalamnya, karena receiver perlu membaca header RTP dulu untuk
   * tahu urutan paket dan mana yang penanda akhir frame.
   *
   * @param {Buffer|Buffer[]} accessUnit H.264 Annex-B atau daftar NAL
   * @returns {Promise<{sent: number, packets: number}>}
   */
  async sendFrame(accessUnit) {
    if (!this.started || this.stopped) return { sent: 0, packets: 0 };
    if (!this.transport) throw new Error('Kanal UDP belum dibuka');

    const nals = Array.isArray(accessUnit) ? accessUnit : null;
    const { packets, nextSequence } = packetizeFrame({
      accessUnit: nals || accessUnit,
      sequenceStart: this.sequence,
      timestamp: this.timestamp,
      ssrc: this.ssrc,
      payloadType: RTP_PAYLOAD_TYPE,
    });
    this.sequence = nextSequence;
    // Clock video 90 kHz: maju 3000 tick per frame pada 30 fps.
    this.timestamp = (this.timestamp + (CLOCK_RATE_HZ / this.options.fps)) >>> 0;
    this.frameIndex += 1;

    // Enkripsi payload setiap paket. Header RTP 12 byte dibiarkan utuh.
    const encryptedPackets = packets.map((packet) => {
      const header = packet.payload.subarray(0, 12);
      const payload = packet.payload.subarray(12);
      const ciphered = this.cipher.encrypt(payload);
      return { payload: Buffer.concat([header, ciphered]), nalType: packet.nalType, marker: packet.marker };
    });

    const result = await this.transport.sendFrame(encryptedPackets);
    return { sent: result.sent, packets: encryptedPackets.length };
  }

  /** Hentikan sesi dan semua sumber daya. Selalu aman dipanggil dua kali. */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    try { this.transport?.close(); } catch { /* ignore */ }
    this.transport = null;
    try { await this.client.stop(); } catch { /* ignore */ }
    try { this.client.close(); } catch { /* ignore */ }
    this.emitState('stopped');
  }
}

module.exports = { MirrorSession, MIRROR_DEFAULTS };
