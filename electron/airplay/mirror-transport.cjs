/**
 * Transport UDP untuk AirPlay Mirroring: mengirim paket RTP video terenkripsi
 * ke receiver, sambil memantau laporan kehilangan paket (RTCP) dari TV.
 *
 * Dua tanggung jawab yang memang milik modul ini:
 *
 *  1. PACING. Satu access unit H.264 pada 1080p bisa jadi 30-60 KB, yang
 *     setelah packetisasi menjadi 25-45 paket UDP. Kalau semua dikirim dalam
 *     satu tick event loop, kernel akan meledak jadi burst,uli antrean pada
 *     TV, dan gambar akan "mengaterial" tiap beberapa frame. Jadi paket
 *     disebar pada interval frame, bukan dikirim sekaligus.
 *
 *  2. RTCP. TV periodically mengirim Receiver Report yang berisi persentase
 *     paket hilang. Ini satu-satunya cara nyata untuk tahu seberapa sehat
 *     stream di kabel - berguna besar saat PRESENTASI karena user bisa diberi
 *     tahu sebelum gambar benar-benar rusak.
 *
 * Modul ini tidak butuh TV untuk diuji: seluruh test memakai loopback
 * 127.0.0.1, dan RTCP diuji dengan paket buatan.
 */

const dgram = require('node:dgram');

const RTCP_RR = 201;
const RTCP_SR = 200;
const RTCP_HEADER_BYTES = 4;

/**
 * Penjadwal laju frame untuk streaming video langsung.
 *
 * DESAIN: tenggat frame ke-N = mulai + N x interval. Kalau waktu sekarang
 * sudah lewat tenggat, frame dikirim langsung. Tidak ada mekanisme "kejar
 * utang".
 *
 * Kejar utang sengaja TIDAK dipakai di sini. Untuk transcoder dari file
 * mungkin berguna, tapi CastV menerima frame langsung dari encoder - tidak
 * ada antrean yang perlu dikejar. Begitu satu frame selesai dikirim, waktu
 * kirimnya sedikit sudah melewati tenggat, dan mekanisme utang akan selalu
 * memicu mode "kejar" pada frame berikutnya. Akibatnya laju实际 menjadi jauh
 * di atas fps yang diminta - video meledak jadi burst, persis yang harus
 * dicegah modul ini.
 *
 * minGapMs tetap ada sebagai pengaman: untuk alasan apa pun dua frame tidak
 * boleh dikirim dengan jarak nol.
 */
class FramePacer {
  constructor({ fps = 30, minGapMs = 1 } = {}) {
    if (!Number.isFinite(fps) || fps <= 0) throw new Error('fps harus angka positif');
    this.frameIntervalMs = 1000 / fps;
    this.minGapMs = minGapMs;
    this.startAt = null;
    this.frameIndex = 0;
    this.lastSentAt = null;
  }

  reset() {
    this.startAt = null;
    this.frameIndex = 0;
    this.lastSentAt = null;
  }

  /**
   * @param {number} nowMs waktu sekarang (ms sejak epoch)
   * @returns {number} ms yang perlu ditunggu sebelum frame ini dikirim
   */
  waitFor(nowMs) {
    if (this.startAt === null) {
      this.startAt = nowMs;
      this.frameIndex = 0;
      this.lastSentAt = null;
    }
    const deadline = this.startAt + this.frameIndex * this.frameIntervalMs;
    this.frameIndex += 1;
    let wait = deadline - nowMs;
    if (this.lastSentAt !== null && nowMs - this.lastSentAt < this.minGapMs) {
      wait = Math.max(wait, this.minGapMs - (nowMs - this.lastSentAt));
    }
    this.lastSentAt = nowMs;
    return Math.max(0, wait);
  }
}

/**
 * Baca jumlah paket hilang dari laporan RTCP Receiver Report.
 *
 * Header RTCP 4 byte: V/P/RC | PT | length(16, dalam kata 32-bit)
 * Disusul SSRC pengirim (4 byte), lalu blok laporan 24 byte:
 *   fraction lost (1) | cumulative lost (24 bit) | ext. highest seq (4) |
 *   jitter (4) | last SR (4) | delay since last SR (4)
 */
function parseReceiverReport(buffer) {
  if (!buffer || buffer.length < RTCP_HEADER_BYTES + 4) return [];
  const reports = [];
  let offset = 0;
  while (offset + RTCP_HEADER_BYTES <= buffer.length) {
    const first = buffer[offset];
    const version = (first >> 6) & 0x03;
    if (version !== 2) break;
    const reportCount = first & 0x1f;
    const packetType = buffer[offset + 1];
    const lengthWords = buffer.readUInt16BE(offset + 2);
    const totalBytes = (lengthWords + 1) * 4;
    if (packetType === RTCP_RR || packetType === RTCP_SR) {
      // Body minimum: SSRC(4) + reportCount*24
      const bodyStart = offset + RTCP_HEADER_BYTES;
      if (bodyStart + 4 + reportCount * 24 <= buffer.length) {
        const senderSsrc = buffer.readUInt32BE(bodyStart);
        for (let i = 0; i < reportCount; i += 1) {
          const p = bodyStart + 4 + i * 24;
          const fractionLostByte = buffer[p];
          const cumulativeLost = ((buffer[p + 1] << 16) | (buffer[p + 2] << 8) | buffer[p + 3]) << 8 >> 8;
          reports.push({
            type: packetType,
            senderSsrc,
            fractionLost: fractionLostByte / 256,
            cumulativeLost,
            highestSequence: buffer.readUInt32BE(p + 4),
            jitter: buffer.readUInt32BE(p + 8),
          });
        }
      }
    }
    if (totalBytes <= 0) break;
    offset += totalBytes;
  }
  return reports;
}

/** Bangun Receiver Report palsu - hanya untuk test. */
function buildReceiverReport({ ssrc = 1, fractionLost = 0, cumulativeLost = 0, highestSequence = 0, jitter = 0, reportCount = 1 } = {}) {
  const size = RTCP_HEADER_BYTES + 4 + reportCount * 24;
  const buf = Buffer.alloc(size);
  buf[0] = (2 << 6) | reportCount; // V=2, RC=reportCount
  buf[1] = RTCP_RR;
  buf.writeUInt16BE(size / 4 - 1, 2); // length dalam kata 32-bit
  buf.writeUInt32BE(ssrc, 4);
  for (let i = 0; i < reportCount; i += 1) {
    const p = 8 + i * 24;
    buf[p] = Math.round(fractionLost * 256) & 0xff;
    buf[p + 1] = (cumulativeLost >> 16) & 0xff;
    buf[p + 2] = (cumulativeLost >> 8) & 0xff;
    buf[p + 3] = cumulativeLost & 0xff;
    buf.writeUInt32BE(highestSequence, p + 4);
    buf.writeUInt32BE(jitter, p + 8);
  }
  return buf;
}

class MirrorUdpTransport {
  /**
   * @param {object} options
   * @param {string} options.host        alamat IP receiver
   * @param {number} options.rtpPort     port tujuan untuk video RTP
   * @param {number} [options.rtcpPort]  port tujuan untuk RTCP
   * @param {number} [options.localRtcpPort] port lokal tempat kita menerima RR
   * @param {number} [options.fps]
   */
  constructor({ host, rtpPort, rtcpPort, localRtcpPort = 0, fps = 30 } = {}) {
    if (!host) throw new Error('Host receiver wajib diisi');
    if (!rtpPort) throw new Error('Port RTP receiver wajib diisi');
    this.host = host;
    this.rtpPort = Number(rtpPort);
    this.rtcpPort = Number(rtcpPort) || Number(rtpPort) + 1;
    this.fps = fps;
    this.localRtcpPort = Number(localRtcpPort) || 0;
    this.ssrc = 0;
    this.pacer = new FramePacer({ fps });
    this.socket = null;
    this.rtcpSocket = null;
    this.closed = false;
    this.stats = {
      framesSent: 0,
      packetsSent: 0,
      bytesSent: 0,
      droppedPackets: 0,
      lastReports: [],
      lastFractionLost: 0,
      lastCumulativeLost: 0,
      highestSequenceReported: 0,
    };
    this.onReport = null;
    this.onError = null;
    this.pendingTimers = new Set();
  }

  async open() {
    if (this.socket) return this;
    await new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const onError = (error) => {
        socket.removeListener('error', onError);
        try { socket.close(); } catch { /* ignore */ }
        reject(error);
      };
      socket.once('error', onError);
      socket.bind(0, () => {
        socket.removeListener('error', onError);
        this.socket = socket;
        socket.on('error', (error) => {
          if (this.onError) this.onError(error);
        });
        resolve();
      });
    });

    // Socket terpisah untuk RTCP supaya laporan TV tidak.antre di belakang
    // video yang kita kirim.
    await new Promise((resolve) => {
      const rtcp = dgram.createSocket('udp4');
      rtcp.on('error', (error) => {
        if (this.onError) this.onError(error);
      });
      rtcp.on('message', (message) => {
        const reports = parseReceiverReport(message);
        if (!reports.length) return;
        this.stats.lastReports = reports;
        const latest = reports[reports.length - 1];
        this.stats.lastFractionLost = latest.fractionLost;
        this.stats.lastCumulativeLost = latest.cumulativeLost;
        this.stats.highestSequenceReported = Math.max(this.stats.highestSequenceReported, latest.highestSequence);
        if (this.onReport) this.onReport(latest, this.stats);
      });
      rtcp.bind(this.localRtcpPort, () => {
        try {
          this.rtcpSocket = rtcp;
          this.localRtcpAddress = rtcp.address();
        } catch { /* ignore */ }
        resolve();
      });
    });

    return this;
  }

  get localPort() {
    return this.socket ? this.socket.address().port : 0;
  }

  get localRtcpBoundPort() {
    return this.localRtcpAddress ? this.localRtcpAddress.port : 0;
  }

  /**
   * Kirim satu access unit.
   * @param {{payload: Buffer}[]} packets hasil packetizeFrame()
   * @returns {Promise<{sent: number, skipped: number}>}
   */
  async sendFrame(packets) {
    if (this.closed || !this.socket || !packets || !packets.length) {
      return { sent: 0, skipped: packets ? packets.length : 0 };
    }

    const wait = this.pacer.waitFor(Date.now());
    if (wait > 0) await this.sleep(wait);
    if (this.closed || !this.socket) return { sent: 0, skipped: packets.length };

    let sent = 0;
    for (const packet of packets) {
      if (this.closed || !this.socket) break;
      try {
        this.socket.send(packet.payload, this.rtpPort, this.host);
        sent += 1;
        this.stats.packetsSent += 1;
        this.stats.bytesSent += packet.payload.length;
      } catch (error) {
        // Satu paket gagal (buffer penuh sesaat) tidak boleh menghentikan frame.
        this.stats.droppedPackets += 1;
        if (this.onError) this.onError(error);
      }
    }
    this.stats.framesSent += 1;
    return { sent, skipped: packets.length - sent };
  }

  /** Kirim satu pesan RTCP sederhana dari sender ke receiver (jika diminta). */
  sendRtcp(buffer) {
    if (this.closed || !this.rtcpSocket) return;
    try {
      this.rtcpSocket.send(buffer, this.rtcpPort, this.host);
    } catch (error) {
      if (this.onError) this.onError(error);
    }
  }

  sleep(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      // Resolver ikut disimpan, bukan hanya timer. Kalau close() hanya
      // clearTimeout tanpa memanggil resolve, setiap sendFrame() yang sedang
      // menunggu akan menggantung selamanya dan pipeline sharing macet total
      // saat pengguna menekan Stop.
      const entry = { timer: null, resolve };
      entry.timer = setTimeout(() => {
        this.pendingTimers.delete(entry);
        resolve();
      }, ms);
      this.pendingTimers.add(entry);
    });
  }

  close() {
    this.closed = true;
    // Selesaikan dulu semua yang menunggu, baru buang timer-nya.
    for (const entry of this.pendingTimers) {
      clearTimeout(entry.timer);
      try { entry.resolve(); } catch { /* ignore */ }
    }
    this.pendingTimers.clear();
    try { this.socket?.close(); } catch { /* ignore */ }
    try { this.rtcpSocket?.close(); } catch { /* ignore */ }
    this.socket = null;
    this.rtcpSocket = null;
  }
}

module.exports = {
  RTCP_RR,
  RTCP_SR,
  FramePacer,
  MirrorUdpTransport,
  parseReceiverReport,
  buildReceiverReport,
};
