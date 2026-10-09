/**
 * CastV — TV protocol probe (diagnostic tool).
 *
 * Jalankan tool ini untuk mengumpulkan informasi yang dibutuhkan agar
 * AirPlay direct-mirroring bisa dikembangkan dengan benar:
 *
 *   node scripts/probe-tv.cjs                 # scan semua device, probe otomatis
 *   node scripts/probe-tv.cjs 192.168.1.97   # probe satu device
 *   node scripts/probe-tv.cjs 192.168.1.97 --raop   # plus tangkap RAOP UDP 5353
 *
 * Tool ini HANYA membaca /info dan mengirim RTSP OPTIONS/GET /info.
 * Tidak mengirim /play, tidak mengirim video, tidak mengubah apa pun.
 *
 * Keluarannya dipakai untuk menentukan langkah AirPlay mirroring yang tepat
 * untuk model TV tersebut.
 */

const net = require('node:net');
const dgram = require('node:dgram');
const os = require('node:os');
const bplistCreator = require('bplist-creator');
const { parseBuffer: parseBplist } = require('bplist-parser');

const BPLIST = 'application/x-apple-binary-plplist';
const RTSP_PORT = 7000;
const RAOP_PORT = 5353;

// ---------------------------------------------------------------- helpers

function decodeBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function parseFeatures(raw) {
  const f = decodeBigInt(raw);
  if (f === null) return null;
  const NAMES = [
    'Video', 'Photo', 'VideoFairPlay', 'VideoVolumeControl',
    'VideoHTTPLiveStreams', 'Slideshow', 'Screen (mirroring)', 'ScreenRotate',
    'Audio', 'AudioRedundant', 'FPSAPv2pt5_AES_GCM', 'FPSAPv2pt5_AES_CBC',
    'SystemPair', 'HKPair', 'PhotoCaching', 'Authentication_4',
  ];
  const out = [];
  for (let b = 0n; b < 64n; b += 1n) {
    if ((f >> b) & 1n) out.push({ bit: b.toString(), name: NAMES[Number(b)] || '(resERVED)' });
  }
  return { value: f, bits: out };
}

function rtspRequest(host, port, method, path, { headers = {}, timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let rx = Buffer.alloc(0);
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
    socket.on('connect', () => {
      const lines = [`${method} ${path} RTSP/1.0`, 'CSeq: 1', 'User-Agent: AirPlay/550.10'];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      rx = Buffer.concat([rx, chunk]);
      const end = rx.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = rx.subarray(0, end).toString('utf8');
      const lenMatch = /content-length:\s*(\d+)/i.exec(head);
      const length = lenMatch ? Number(lenMatch[1]) : 0;
      if (rx.length - (end + 4) < length) return;
      const body = rx.subarray(end + 4, end + 4 + length);
      clearTimeout(timer);
      const statusLine = head.split('\r\n')[0];
      finish({ ok: true, statusLine, head, body });
    });
    socket.on('error', (error) => { clearTimeout(timer); finish({ ok: false, error: error.message }); });
    socket.on('close', () => { clearTimeout(timer); finish({ ok: false, error: 'closed' }); });
  });
}

async function getInfo(host, port) {
  const res = await rtspRequest(host, port, 'GET', '/info', { headers: { 'Accept': BPLIST } });
  if (!res.ok) return { ok: false, error: res.error };
  const line = res.statusLine || '';
  const code = Number(/RTSP\/[\d.]+\s+(\d+)/.exec(line)?.[1] || 0);
  if (code !== 200) return { ok: false, statusCode: code, statusLine: line };
  let parsed = null;
  try { const v = parseBplist(res.body); parsed = Array.isArray(v) ? v[0] : v; } catch { /* ignore */ }
  return { ok: true, statusCode: code, info: parsed || {}, bytes: res.body.length };
}

// ---------------------------------------------------------------- RAOP sniffer

function listenRaop(host, seconds = 12) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const packets = [];
    socket.on('message', (msg) => {
      packets.push({
        at: new Date().toISOString().slice(11, 19),
        bytes: msg.length,
        hex: msg.subarray(0, Math.min(msg.length, 64)).toString('hex'),
      });
    });
    socket.on('error', () => resolve(packets));
    socket.bind(RAOP_PORT, () => {
      // Kirim satu probe RTPS 'ping' agar device membalas (meneg-trigger traffic).
      const ping = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      try { socket.send(ping, RAOP_PORT, host); } catch { /* ignore */ }
      setTimeout(() => { try { socket.close(); } catch { /* ignore */ } resolve(packets); }, seconds * 1000);
    });
  });
}

// ---------------------------------------------------------------- mDNS scan

function scan() {
  return new Promise((resolve) => {
    let bonjour;
    try { bonjour = require('bonjour-service'); } catch { resolve([]); return; }
    const found = new Map();
    const browser = new bonjour.Browser();
    const types = ['_airplay._tcp', '_raop._tcp'];
    browser.on('serviceUp', (service) => {
      if (!types.includes(service.type)) return;
      found.set(service.fqdn, {
        name: service.name,
        type: service.type,
        host: service.host,
        addresses: service.addresses || [],
        port: service.port,
      });
    });
    browser.start({ type: 'tcp', protocol: 'tcp' });
    setTimeout(() => { try { browser.stop(); } catch { /* ignore */ } resolve([...found.values()]); }, 6000);
  });
}

// ---------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const wantRaop = args.includes('--raop');
  const target = args.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));

  console.log('='.repeat(64));
  console.log('CastV — TV protocol probe');
  console.log('Hanya membaca /info dan OPTIONS. Tidak mengirim video.');
  console.log('='.repeat(64));

  let hosts = [];
  if (target) {
    hosts = [target];
  } else {
    console.log('\n[1] Scan mDNS (_airplay._tcp / _raop._tcp)...');
    const found = await scan();
    if (!found.length) { console.log('    Tidak ada device ditemukan.'); }
    for (const f of found) {
      console.log(`    ${f.name}`);
      console.log(`      type=${f.type} ${f.host}:${f.port}`);
    }
    hosts = found.flatMap((f) => (f.addresses || []).map((a) => ({ host: a, port: f.type === '_raop._tcp' ? RAOP_PORT : f.port })));
    if (!hosts.length) { console.log('\nTidak ada alamat IP untuk diprobe.'); return; }
    console.log('\n[2] Membaca /info tiap device...');
  }

  for (const entry of hosts) {
    const host = typeof entry === 'string' ? entry : entry.host;
    const port = typeof entry === 'string' ? RTSP_PORT : entry.port;
    console.log(`\n${'-'.repeat(64)}`);
    console.log(`TARGET ${host}:${port}`);
    console.log('-'.repeat(64));

    // RTSP OPTIONS — kemampuan server
    const opt = await rtspRequest(host, port, 'OPTIONS', '/');
    console.log(`\n  OPTIONS /`);
    console.log(`    ${opt.ok ? opt.statusLine : `error: ${opt.error}`}`);
    if (opt.ok) {
      for (const line of opt.head.split('\r\n').slice(1)) {
        if (/public|server|allow|x-apple/i.test(line)) console.log(`    ${line}`);
      }
    }

    const info = await getInfo(host, port);
    console.log(`\n  GET /info`);
    if (!info.ok) {
      console.log(`    gagal: ${info.error || info.statusLine}`);
      continue;
    }
    const i = info.info || {};
    const interesting = [
      'name', 'model', 'deviceID', 'srcvers', 'vv', 'features', 'flags',
      'pk', 'pi', 'deviceid', 'mac', 'sourceVersion',
    ];
    for (const key of interesting) {
      if (i[key] === undefined) continue;
      let value = i[key];
      if (typeof value === 'bigint') value = value.toString();
      if (typeof value === 'string' && value.length > 90) value = `${value.slice(0, 90)}… (${value.length} char)`;
      console.log(`    ${key.padEnd(14)} = ${value}`);
    }
    const feat = parseFeatures(i.features);
    if (feat) {
      console.log(`\n    features = 0x${feat.value.toString(16)}`);
      const has = (n) => feat.bits.some((b) => b.name === n);
      console.log(`      Screen/mirroring : ${has('Screen (mirroring)') ? 'YA' : 'TIDAK'}`);
      console.log(`      VideoFairPlay    : ${has('VideoFairPlay') ? 'YA' : 'TIDAK'}`);
      console.log(`      ScreenRotate     : ${has('ScreenRotate') ? 'YA' : 'TIDAK'}`);
      const v2 = ((feat.value & ((1n << 48n) | (1n << 46n) | (1n << 43n) | (1n << 49n))) !== 0n);
      console.log(`      versi AirPlay    : ${v2 ? '2 (HAP pairing)' : '1 (AirTunes, tanpa pairing)'}`);
    }
    console.log(`\n    (${Object.keys(i).length} total key di /info)`);

    if (wantRaop) {
      console.log(`\n  RAOP UDP ${RAOP_PORT} — menyimak ${12} detik...`);
      const packets = await listenRaop(host, 12);
      if (!packets.length) console.log('    tidak ada paket UDP dari device');
      for (const p of packets) console.log(`    ${p.at}  ${p.bytes}B  ${p.hex}`);
    }
  }

  console.log(`\n${'='.repeat(64)}`);
  console.log('Selesai. Kirim output ini ke penguin develop CastV.');
  if (wantRaop) console.log('Jalankan juga dengan --raop saat TV sedang dalam sesi AirPlay.');
  console.log('='.repeat(64));
}

main().catch((error) => {
  console.error('probe gagal:', error);
  process.exitCode = 1;
});