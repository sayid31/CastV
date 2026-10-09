/**
 * Packetisasi H.264 untuk AirPlay Mirroring (RFC 6184 - RTP Payload Format for H.264).
 *
 * Modul ini murni logika bitstream - TIDAK menyentuh jaringan, sehingga bisa
 * diuji tanpa perangkat TV. Bagian FairPlay dan transport RDP/RAOP dibangun
 * terpisah di modul lain.
 *
 * Rujukan: RFC 6184 (H.264 RTP payload), RFC 3550 (RTP header).
 */

const RTP_VERSION = 2;
const RTP_PAYLOAD_TYPE = 96; // dynamic payload type, dikomunikasikan ke receiver
const CLOCK_RATE_HZ = 90000; // 90 kHz, wajib untuk video H.264
const RTP_HEADER_BYTES = 12;
const FU_HEADER_BYTES = 2; // FU indicator + FU header
const MTU_SAFE_BYTES = 1400; // muat di LAN tanpa fragmentasi IP

/**
 * Header RTP 12 byte (RFC 3550 §5.1).
 *
 *  0                   1                   2                   3
 *  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 * |V=2|P|X|  CC   |M|     PT      |       sequence number         |
 * |                           timestamp                           |
 * |           synchronization source (SSRC)                       |
 */
function buildRtpHeader({ marker = false, payloadType = RTP_PAYLOAD_TYPE, sequence = 0, timestamp = 0, ssrc = 0 }) {
  const header = Buffer.alloc(RTP_HEADER_BYTES);
  // Byte 0: V(2) | P(1) | X(1) | CC(4). Padding & extension tidak dipakai.
  header[0] = (RTP_VERSION << 6) & 0xc0;
  // Byte 1: M(1) | PT(7).
  header[1] = (marker ? 0x80 : 0x00) | (payloadType & 0x7f);
  // Byte 2-3: sequence number (16 bit).
  header.writeUInt16BE(sequence & 0xffff, 2);
  // Byte 4-7: timestamp (32 bit unsigned).
  header.writeUInt32BE(timestamp >>> 0, 4);
  // Byte 8-11: SSRC.
  header.writeUInt32BE(ssrc >>> 0, 8);
  return header;
}

/** Baca field dari header RTP (dipakai test &Sx debug). */
function parseRtpHeader(buf) {
  if (!buf || buf.length < RTP_HEADER_BYTES) throw new Error('Header RTP terlalu pendek');
  return {
    version: (buf[0] >> 6) & 0x03,
    padding: (buf[0] >> 5) & 0x01,
    extension: (buf[0] >> 4) & 0x01,
    csrcCount: buf[0] & 0x0f,
    marker: (buf[1] >> 7) & 0x01,
    payloadType: buf[1] & 0x7f,
    sequence: buf.readUInt16BE(2),
    timestamp: buf.readUInt32BE(4),
    ssrc: buf.readUInt32BE(8),
  };
}

/** Bitstream H.264: pisahkan NAL unit dari Annex-B byte stream. */
function splitAnnexB(stream) {
  const buf = Buffer.isBuffer(stream) ? stream : Buffer.from(stream);
  const starts = [];
  let i = 0;
  while (i + 3 <= buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      starts.push({ scStart: i, dataStart: i + 3 });
      i += 3;
    } else if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) {
      starts.push({ scStart: i, dataStart: i + 4 });
      i += 4;
    } else {
      i += 1;
    }
  }
  const nals = [];
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k].dataStart;
    const to = k + 1 < starts.length ? starts[k + 1].scStart : buf.length;
    if (to <= from) continue;
    let end = to;
    // Annex-B: trailing_zero_8bits milik start code berikutnya, bukan NAL.
    while (end > from && buf[end - 1] === 0x00) end -= 1;
    if (end > from) nals.push(buf.subarray(from, end));
  }
  return nals;
}

/**
 * Dua byte header FU-A (RFC 6184 §5.8).
 *
 *  FU indicator : F(1)=0 | NRI(2) | Type(5)=28
 *  FU header    : S(1) | E(1) | R(1)=0 | Type(5) = tipe NAL asli
 */
function buildFuAHeader({ nalHeader, start, end }) {
  const indicator = (nalHeader & 0xe0) | 28; // F=0, NRI dari NAL asli, Type=28
  const fuHeader = ((start ? 1 : 0) << 7) | ((end ? 1 : 0) << 6) | (nalHeader & 0x1f);
  return Buffer.from([indicator & 0xff, fuHeader & 0xff]);
}

/**
 * Ubah satu access unit (Annex-B) menjadi paket RTP.
 *
 * NAL kecil <= MTU dikirim sebagai Single NAL Unit; NAL besar dipecah
 * menjadi Fragmenteation Unit (FU-A) dengan bit Start/End.
 */
function packetizeFrame({
  accessUnit,
  sequenceStart = 0,
  timestamp = 0,
  ssrc = 0,
  mtu = MTU_SAFE_BYTES,
  payloadType = RTP_PAYLOAD_TYPE,
}) {
  if (!accessUnit || accessUnit.length === 0) throw new Error('Access unit kosong');
  if (mtu <= RTP_HEADER_BYTES + FU_HEADER_BYTES) throw new Error('MTU terlalu kecil untuk H.264 RTP');

  const nals = Array.isArray(accessUnit) ? accessUnit : splitAnnexB(accessUnit);
  const packets = [];
  let sequence = sequenceStart & 0xffff;

  // Budget payload per pecahan FU-A: MTU - header RTP - header FU-A.
  const fuChunkSize = mtu - RTP_HEADER_BYTES - FU_HEADER_BYTES;

  nals.forEach((nal, nalIndex) => {
    const isLastNal = nalIndex === nals.length - 1;

    if (nal.length <= mtu - RTP_HEADER_BYTES) {
      // Single NAL Unit - payload langsung, tanpa header tambahan.
      const marker = isLastNal;
      packets.push({
        payload: Buffer.concat([
          buildRtpHeader({ marker, payloadType, sequence, timestamp, ssrc }),
          nal,
        ]),
        nalType: nal[0] & 0x1f,
        fuStart: false,
        fuEnd: false,
        marker,
      });
      sequence = (sequence + 1) & 0xffff;
      return;
    }

    // Fragmentation Unit.
    const nalHeader = nal[0];
    const body = nal.subarray(1);
    let offset = 0;
    let first = true;
    while (offset < body.length) {
      const end = offset + fuChunkSize >= body.length;
      const slice = body.subarray(offset, Math.min(offset + fuChunkSize, body.length));
      const marker = end && isLastNal;
      packets.push({
        payload: Buffer.concat([
          buildRtpHeader({ marker, payloadType, sequence, timestamp, ssrc }),
          buildFuAHeader({ nalHeader, start: first, end }),
          slice,
        ]),
        nalType: nalHeader & 0x1f,
        fuStart: first,
        fuEnd: end,
        marker,
      });
      sequence = (sequence + 1) & 0xffff;
      offset += fuChunkSize;
      first = false;
    }
  });

  return { packets, nextSequence: sequence & 0xffff };
}

module.exports = {
  RTP_VERSION,
  RTP_PAYLOAD_TYPE,
  CLOCK_RATE_HZ,
  RTP_HEADER_BYTES,
  FU_HEADER_BYTES,
  MTU_SAFE_BYTES,
  buildRtpHeader,
  parseRtpHeader,
  splitAnnexB,
  buildFuAHeader,
  packetizeFrame,
};