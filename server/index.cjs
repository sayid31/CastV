const http = require('node:http');
const dgram = require('node:dgram');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const DEFAULT_PORT = Number(process.env.CASTV_PORT || 43117);
const DISCOVERY_PORT = Number(process.env.CASTV_DISCOVERY_PORT || 43118);
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const ROOM_PATTERN = /^[A-Z0-9-]{4,12}$/;
const ROOM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/iso.segment',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function getLanAddresses() {
  const candidates = [];
  for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
    for (const item of interfaces || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const address = item.address;
      const isVirtual = /loopback|virtual|vmware|vethernet|hyper-v|wsl|tailscale|zerotier|docker/i.test(name);
      if (isVirtual) continue;
      const isPrivate = address.startsWith('192.168.') || address.startsWith('10.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(address);
      candidates.push({ address, priority: isPrivate ? 0 : 1 });
    }
  }
  return [...new Map(candidates.sort((a, b) => a.priority - b.priority).map((item) => [item.address, item])).keys()];
}

function normalizeRoom(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12);
}

function safeName(value) {
  return String(value || 'Browser receiver').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80) || 'Browser receiver';
}

function createCastServer(options = {}) {
  const port = Number(options.port || DEFAULT_PORT);
  const staticDir = path.resolve(options.staticDir || path.join(__dirname, '..', 'dist'));
  const devServerUrl = options.devServerUrl || null;
  const rooms = new Map();
  const clients = new Map();
  const discoveryClients = new Map();
  const watchers = new Set();
  const discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let udpDiscoveryReady = false;
  const airplayStream = {
    id: randomUUID().replaceAll('-', ''),
    meta: null,
    initVersion: 0,
    inits: new Map(),
    segments: new Map(),
    fetches: new Map(),
  };

  function resetAirplayStream() {
    airplayStream.id = randomUUID().replaceAll('-', '');
    airplayStream.meta = null;
    airplayStream.initVersion = 0;
    airplayStream.inits.clear();
    airplayStream.segments.clear();
    airplayStream.fetches.clear();
  }

  function setAirplayMeta(meta) {
    airplayStream.meta = meta && typeof meta === 'object' ? meta : null;
    return airplayStream.meta;
  }

  function setAirplayInit(data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const version = ++airplayStream.initVersion;
    airplayStream.inits.set(version, buffer);
    airplayStream.segments.clear();
    return version;
  }

  function setAirplaySegment(data, info = {}) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const sequence = Number(info.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 0) return false;
    airplayStream.segments.set(sequence, {
      data: buffer,
      duration: Number(info.duration) || 1,
      initVersion: Number(info.initVersion) || airplayStream.initVersion,
    });
    const ordered = [...airplayStream.segments.keys()].sort((a, b) => a - b);
    while (ordered.length > 12) airplayStream.segments.delete(ordered.shift());
    return true;
  }

  function getAirplayFetchCount(address) {
    return airplayStream.fetches.get(String(address || '').replace(/^::ffff:/, '')) || 0;
  }

  function airplayPlaylist() {
    if (!airplayStream.initVersion || !airplayStream.segments.size) return null;
    const segments = [...airplayStream.segments.entries()].map(([sequence, item]) => ({ sequence, ...item }));
    if (!segments.length) return null;
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(Math.max(...segments.map((item) => item.duration))))}`,
      `#EXT-X-MEDIA-SEQUENCE:${segments[0].sequence}`,
      '#EXT-X-INDEPENDENT-SEGMENTS',
    ];
    let currentInit = -1;
    for (const item of segments) {
      if (item.initVersion !== currentInit) {
        lines.push(`#EXT-X-MAP:URI="init-${item.initVersion}.mp4"`);
        currentInit = item.initVersion;
      }
      lines.push(`#EXTINF:${item.duration.toFixed(3)},`, `seg-${item.sequence}.m4s`);
    }
    return `${lines.join('\n')}\n`;
  }

  discoverySocket.on('message', (message, remote) => {
    if (message.toString('utf8').trim() !== 'CASTV_DISCOVER') return;
    const response = Buffer.from(JSON.stringify({
      type: 'castv-server',
      service: 'castv',
      name: 'CastV',
      host: remote.address,
      httpPort: port,
      wsPort: port,
    }));
    discoverySocket.send(response, remote.port, remote.address, (error) => {
      if (error) console.warn(`CastV UDP discovery reply failed: ${error.message}`);
    });
  });
  discoverySocket.on('error', (error) => {
    console.warn(`CastV UDP discovery unavailable: ${error.message}`);
  });

  function send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  function makeRoom(code, viewerToken) {
    return { code, viewerToken, sender: null, receiver: null, createdAt: Date.now(), lastActivity: Date.now() };
  }

  function getRoom(code, viewerToken) {
    let room = rooms.get(code);
    if (room && Date.now() - room.lastActivity > ROOM_TTL_MS) {
      if (room.sender) clients.delete(room.sender);
      if (room.receiver) clients.delete(room.receiver);
      rooms.delete(code);
      room = null;
    }
    if (!room) {
      room = makeRoom(code, viewerToken);
      rooms.set(code, room);
    }
    room.lastActivity = Date.now();
    return room;
  }

  function nearbyDevices() {
    return [...discoveryClients.entries()].map(([ws, item]) => ({
      id: item.id,
      name: item.name,
      type: item.type || 'browser',
      lastSeen: item.lastSeen,
    }));
  }

  function sendNearby(ws) {
    send(ws, { type: 'nearby-update', devices: nearbyDevices() });
  }

  function broadcastNearby() {
    const message = { type: 'nearby-update', devices: nearbyDevices() };
    const recipients = new Set(watchers);
    for (const room of rooms.values()) if (room.sender) recipients.add(room.sender);
    for (const recipient of recipients) send(recipient, message);
  }

  function broadcastRoom(room, message, except) {
    if (!room) return;
    for (const client of [room.sender, room.receiver]) {
      if (client && client !== except) send(client, message);
    }
  }

  function leaveRoom(ws) {
    watchers.delete(ws);
    const discovered = discoveryClients.get(ws);
    if (discovered) {
      discoveryClients.delete(ws);
      broadcastNearby();
    }

    const client = clients.get(ws);
    if (!client) return;
    clients.delete(ws);
    const room = rooms.get(client.room);
    if (!room) return;
    if (room.sender === ws) room.sender = null;
    if (room.receiver === ws) room.receiver = null;
    if (!room.sender && !room.receiver) {
      rooms.delete(client.room);
    } else {
      broadcastRoom(room, { type: 'peer-left', role: client.role });
    }
  }

  function joinRoom(ws, code, role, token) {
    const normalized = normalizeRoom(code);
    const viewerToken = String(token || '');
    if (!ROOM_PATTERN.test(normalized)) {
      send(ws, { type: 'error', code: 'INVALID_ROOM', message: 'Kode sesi tidak valid.' });
      return false;
    }
    if (role !== 'sender' && role !== 'receiver') {
      send(ws, { type: 'error', code: 'INVALID_ROLE', message: 'Peran tidak valid.' });
      return false;
    }
    if (!ROOM_TOKEN_PATTERN.test(viewerToken)) {
      send(ws, { type: 'error', code: 'INVALID_TOKEN', message: 'Token sesi tidak valid.' });
      return false;
    }

    const existingClient = clients.get(ws);
    if (existingClient) leaveRoom(ws);

    const room = getRoom(normalized, viewerToken);
    if (room.viewerToken && room.viewerToken !== viewerToken) {
      send(ws, { type: 'error', code: 'TOKEN_MISMATCH', message: 'Sesi tidak ditemukan atau sudah berakhir.' });
      return false;
    }
    if (room[role] && room[role] !== ws) {
      send(ws, {
        type: 'error',
        code: 'ROLE_TAKEN',
        message: role === 'sender' ? 'Sesi sender sudah aktif.' : 'Sesi receiver sudah aktif.',
      });
      return false;
    }

    room[role] = ws;
    room.lastActivity = Date.now();
    clients.set(ws, { room: normalized, role });
    discoveryClients.delete(ws);
    send(ws, { type: 'joined', room: normalized, role, peerPresent: Boolean(room.sender && room.receiver) });
    broadcastRoom(room, { type: 'peer-ready', role }, ws);
    broadcastNearby();
    return true;
  }

  function addDiscoveryClient(ws, name) {
    const existing = discoveryClients.get(ws);
    if (existing) {
      existing.name = safeName(name || existing.name);
      existing.lastSeen = Date.now();
    } else {
      discoveryClients.set(ws, { id: randomUUID(), name: safeName(name), type: 'browser', lastSeen: Date.now() });
    }
    sendNearby(ws);
    broadcastNearby();
  }

  function claimNearbyReceiver(ws, deviceId) {
    const sender = clients.get(ws);
    if (!sender || sender.role !== 'sender') {
      send(ws, { type: 'error', code: 'SENDER_REQUIRED', message: 'Buat sesi sender terlebih dahulu.' });
      return;
    }
    const targetEntry = [...discoveryClients.entries()].find(([, item]) => item.id === deviceId);
    if (!targetEntry) {
      send(ws, { type: 'error', code: 'DEVICE_NOT_FOUND', message: 'Receiver tidak ditemukan.' });
      return;
    }
    const [target] = targetEntry;
    const room = rooms.get(sender.room);
    if (!room) {
      send(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Sesi sender tidak ditemukan.' });
      return;
    }
    if (room.receiver) {
      send(ws, { type: 'error', code: 'RECEIVER_TAKEN', message: 'Sesi ini sudah memiliki receiver.' });
      return;
    }
    send(target, { type: 'assigned', room: room.code, token: room.viewerToken, deviceId });
    send(ws, { type: 'receiver-claimed', deviceId, room: room.code });
  }

  function relay(ws, message) {
    const client = clients.get(ws);
    if (!client) return;
    const room = rooms.get(client.room);
    if (!room) return;
    const target = client.role === 'sender' ? room.receiver : room.sender;
    if (!target) {
      send(ws, { type: 'peer-missing', role: client.role === 'sender' ? 'receiver' : 'sender' });
      return;
    }
    if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice') {
      send(target, message);
    } else if (message.type === 'stop') {
      send(target, { type: 'stopped' });
      room.lastActivity = Date.now();
    }
  }

  function handleMessage(ws, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'Pesan tidak valid.' });
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'join') {
      joinRoom(ws, message.room, message.role, message.token);
      return;
    }
    if (message.type === 'discover') {
      addDiscoveryClient(ws, message.name);
      return;
    }
    if (message.type === 'watch') {
      watchers.add(ws);
      sendNearby(ws);
      return;
    }
    if (message.type === 'claim-receiver') {
      claimNearbyReceiver(ws, String(message.deviceId || ''));
      return;
    }
    if (message.type === 'ping') {
      send(ws, { type: 'pong' });
      return;
    }
    relay(ws, message);
  }

  function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  function sendJson(res, statusCode, value) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify(value));
  }

  function sendAirplayBuffer(res, body, contentType) {
    if (!body) {
      res.statusCode = 404;
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return;
    }
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (res.req.method === 'HEAD') res.end();
    else res.end(buffer);
  }

  function serveAirplayRoute(req, res, pathname) {
    if (pathname === '/api/airplay') {
      sendJson(res, 200, {
        ready: Boolean(airplayStream.initVersion && airplayStream.segments.size),
        id: airplayStream.id,
        meta: airplayStream.meta,
        segments: airplayStream.segments.size,
        initVersion: airplayStream.initVersion,
      });
      return true;
    }
    let routePath = pathname;
    if (pathname.startsWith('/airplay/')) {
      routePath = pathname.slice('/airplay/'.length);
      const slash = routePath.indexOf('/');
      if (slash > 0) {
        const requestedId = routePath.slice(0, slash);
        if (requestedId !== airplayStream.id) {
          sendAirplayBuffer(res, null, MIME_TYPES['.m3u8']);
          return true;
        }
        routePath = routePath.slice(slash + 1);
      }
    }
    const remoteAddress = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    airplayStream.fetches.set(remoteAddress, (airplayStream.fetches.get(remoteAddress) || 0) + 1);
    if (routePath === 'master.m3u8') {
      const playlist = airplayPlaylist();
      if (!playlist) {
        sendAirplayBuffer(res, null, MIME_TYPES['.m3u8']);
        return true;
      }
      const meta = airplayStream.meta || {};
      const codecs = meta.codecs || 'avc1.640028';
      const bandwidth = Math.max(500000, Number(meta.videoBitrate) || 4000000);
      const resolution = meta.width && meta.height ? `,RESOLUTION=${meta.width}x${meta.height}` : '';
      const frameRate = meta.frameRate ? `,FRAME-RATE=${Number(meta.frameRate).toFixed(3)}` : '';
      const body = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${resolution}${frameRate},CODECS="${codecs}"\nlive.m3u8\n`;
      sendAirplayBuffer(res, Buffer.from(body), MIME_TYPES['.m3u8']);
      return true;
    }
    if (routePath === 'live.m3u8') {
      sendAirplayBuffer(res, airplayPlaylist() ? Buffer.from(airplayPlaylist()) : null, MIME_TYPES['.m3u8']);
      return true;
    }
    const initMatch = /^init-(\d+)\.mp4$/.exec(routePath);
    if (initMatch) {
      sendAirplayBuffer(res, airplayStream.inits.get(Number(initMatch[1])), 'video/mp4');
      return true;
    }
    const segmentMatch = /^seg-(\d+)\.m4s$/.exec(routePath);
    if (segmentMatch) {
      sendAirplayBuffer(res, airplayStream.segments.get(Number(segmentMatch[1]))?.data, MIME_TYPES['.m4s']);
      return true;
    }
    return false;
  }

  async function serveStatic(req, res) {
    const rawPath = new URL(req.url || '/', 'http://castv.local').pathname;
    let pathname;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      res.statusCode = 400;
      res.end('Bad request');
      return;
    }

    let relative = pathname.replace(/^\/+/, '');
    if (!relative || relative.endsWith('/')) relative += 'index.html';
    if (pathname === '/receiver' || pathname === '/receiver/') relative = 'receiver.html';

    const root = path.resolve(staticDir);
    const candidate = path.resolve(root, relative);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    let filePath = candidate;
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) throw new Error('not file');
    } catch {
      if (pathname === '/receiver' || pathname === '/receiver/') filePath = path.join(root, 'receiver.html');
      else if (!path.extname(relative)) filePath = path.join(root, 'index.html');
    }

    try {
      const data = await fsp.readFile(filePath);
      res.statusCode = 200;
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none';");
      res.setHeader('Content-Type', MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Cache-Control', filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=3600');
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('CastV web assets are not built yet. Run `npm run build` first.');
    }
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      setCors(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    const requestUrl = new URL(req.url || '/', 'http://castv.local');
    if (requestUrl.pathname === '/api/health') {
      let version = '';
      try {
        version = require(path.join(__dirname, '..', 'package.json')).version || '';
      } catch { /* version is optional in packaged builds */ }
      sendJson(res, 200, { ok: true, service: 'castv-signaling', version, time: new Date().toISOString() });
      return;
    }
    if (requestUrl.pathname === '/api/network') {
      const addresses = getLanAddresses();
      sendJson(res, 200, {
        port,
        addresses,
        urls: addresses.map((address) => `http://${address}:${port}`),
        devServerUrl,
      });
      return;
    }
    if (serveAirplayRoute(req, res, requestUrl.pathname)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.end('Method not allowed');
      return;
    }
    await serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const requestUrl = new URL(req.url || '/', 'http://castv.local');
    if (requestUrl.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => handleMessage(ws, raw));
    ws.on('close', () => leaveRoom(ws));
    ws.on('error', () => leaveRoom(ws));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
      const discovered = discoveryClients.get(ws);
      if (discovered) discovered.lastSeen = Date.now();
    }

    const now = Date.now();
    for (const [ws, item] of discoveryClients) {
      if (now - item.lastSeen > DISCOVERY_TTL_MS) ws.close();
    }
    for (const [code, room] of rooms) {
      if (!room.sender && !room.receiver) rooms.delete(code);
      else if (now - room.lastActivity > ROOM_TTL_MS) {
        if (room.sender) clients.delete(room.sender);
        if (room.receiver) clients.delete(room.receiver);
        rooms.delete(code);
      }
    }
  }, 30000);
  heartbeat.unref?.();

  return {
    server,
    wss,
    rooms,
    clients,
    discoveryClients,
    watchers,
    discoveryPort: DISCOVERY_PORT,
    get udpDiscoveryReady() { return udpDiscoveryReady; },
    setAirplayMeta,
    setAirplayInit,
    setAirplaySegment,
    resetAirplayStream,
    getAirplayPlaylist: airplayPlaylist,
    getAirplayFetchCount,
    getAirplayStreamUrl: (host) => `http://${host}:${port}/airplay/${airplayStream.id}/master.m3u8`,
    listen: async () => {
      const address = await new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(server.address()); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '0.0.0.0');
      });
      await new Promise((resolve) => {
        const onError = () => { udpDiscoveryReady = false; resolve(); };
        discoverySocket.once('error', onError);
        discoverySocket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
          discoverySocket.off('error', onError);
          udpDiscoveryReady = true;
          resolve();
        });
      });
      return address;
    },
    close: () => new Promise((resolve) => {
      clearInterval(heartbeat);
      if (udpDiscoveryReady) {
        try { discoverySocket.close(); } catch { /* already closed */ }
        udpDiscoveryReady = false;
      }
      for (const ws of wss.clients) ws.close();
      wss.close(() => server.close(() => resolve()));
    }),
  };
}

async function main() {
  const service = createCastServer();
  const address = await service.listen();
  const addresses = getLanAddresses();
  console.log(`CastV signaling server listening on http://${address.address}:${address.port}`);
  console.log(`UDP discovery: ${service.udpDiscoveryReady ? `listening on ${service.discoveryPort}` : 'unavailable'}`);
  if (addresses.length) console.log(`LAN receiver: http://${addresses[0]}:${address.port}/receiver.html`);
  const shutdown = async () => { await service.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { createCastServer, getLanAddresses, normalizeRoom };
