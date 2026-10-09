const net = require('node:net');
const { randomBytes } = require('node:crypto');
const bplistCreator = require('bplist-creator');
const { parseBuffer: parseBplist } = require('bplist-parser');

const BPLIST = 'application/x-apple-binary-plist';

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(String(value || ''), 'utf8');
}

class AirPlayV1Client {
  constructor({ host, port, name = 'CastV', senderName = 'CastV', onClose } = {}) {
    this.host = host;
    this.port = Number(port) || 7000;
    this.name = name;
    this.senderName = senderName;
    this.onClose = typeof onClose === 'function' ? onClose : null;
    this.sessionId = randomBytes(16).toString('hex').toUpperCase();
    this.socket = null;
    this.rx = Buffer.alloc(0);
    this.queue = [];
    this.closed = false;
    this.intentionalClose = false;
  }

  connect(timeoutMs = 7000) {
    if (this.socket && !this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => socket.destroy(new Error('AirPlay connection timeout')), timeoutMs);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 10000);
      socket.once('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });
      socket.on('data', (data) => this.onData(data));
      socket.on('error', (error) => {
        clearTimeout(timer);
        if (!this.socket) reject(error);
        this.fail(error);
      });
      socket.on('close', () => {
        this.closed = true;
        this.fail(new Error('AirPlay connection closed'));
        // TV yang menutup koneksi berarti playback sudah berhenti. Laporkan
        // ke renderer supaya user melihat "TV terputus" dan bisa menyambung
        // lagi, bukan diam-diam_recv dan juga tidak langsung error.
        if (!this.intentionalClose && this.onClose) {
          try { this.onClose(); } catch { /* never let a callback break teardown */ }
        }
      });
    });
  }

  request(method, requestPath, { headers = {}, body, timeoutMs = 12000 } = {}) {
    if (!this.socket || this.closed) return Promise.reject(new Error('AirPlay is not connected'));
    const payload = body === undefined ? Buffer.alloc(0) : toBuffer(body);
    const lines = [`${method} ${requestPath} HTTP/1.1`];
    const allHeaders = { ...headers };
    if (payload.length || method === 'POST' || method === 'PUT') allHeaders['Content-Length'] = payload.length;
    for (const [key, value] of Object.entries(allHeaders)) lines.push(`${key}: ${value}`);
    const packet = Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8'), payload]);
    return new Promise((resolve, reject) => {
      const pending = { method, requestPath, resolve, reject, timer: null };
      pending.timer = setTimeout(() => {
        const index = this.queue.indexOf(pending);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error(`${method} ${requestPath} timed out`));
      }, timeoutMs);
      this.queue.push(pending);
      this.socket.write(packet);
    });
  }

  onData(data) {
    this.rx = Buffer.concat([this.rx, data]);
    for (;;) {
      const headerEnd = this.rx.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const headerText = this.rx.subarray(0, headerEnd).toString('utf8');
      const lines = headerText.split('\r\n');
      const first = lines.shift() || '';
      const headers = {};
      for (const line of lines) {
        const index = line.indexOf(':');
        if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
      }
      const length = Number.parseInt(headers['content-length'] || '0', 10) || 0;
      const total = headerEnd + 4 + length;
      if (this.rx.length < total) return;
      const body = Buffer.from(this.rx.subarray(headerEnd + 4, total));
      this.rx = this.rx.subarray(total);
      const response = /^(HTTP|RTSP)\/([0-9.]+)\s+(\d{3})(?:\s+(.*))?$/.exec(first);
      if (response) {
        const pending = this.queue.shift();
        if (!pending) continue;
        clearTimeout(pending.timer);
        const result = { code: Number(response[3]), message: response[4] || '', headers, body };
        if (result.code >= 400) pending.reject(new Error(`${pending.method} ${pending.requestPath} failed: ${result.code} ${result.message}`));
        else pending.resolve(result);
        continue;
      }
      // AirPlay receivers can send an event/request on the reverse channel.
      if (/^(GET|POST|PUT|DELETE|RTSP)\s+/i.test(first)) {
        const protocol = /RTSP/i.test(first) ? 'RTSP/1.0' : 'HTTP/1.1';
        const cseq = headers.cseq ? `CSeq: ${headers.cseq}\r\n` : '';
        this.socket.write(`${protocol} 200 OK\r\n${cseq}Content-Length: 0\r\n\r\n`);
      }
    }
  }

  fail(error) {
    const pending = this.queue.splice(0);
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(error);
    }
  }

  async getInfo() {
    await this.connect();
    const response = await this.request('GET', '/info', {
      headers: { 'User-Agent': 'AirPlay/550.10', 'Content-Type': BPLIST },
      timeoutMs: 7000,
    });
    if (!response.body.length) return {};
    try {
      const parsed = parseBplist(response.body);
      return Array.isArray(parsed) ? parsed[0] : parsed;
    } catch {
      return {};
    }
  }

  async play(url) {
    await this.connect();
    const body = bplistCreator({
      'Content-Location': url,
      'Start-Position': new bplistCreator.Real(0),
      'X-Apple-Session-ID': this.sessionId,
    });
    const response = await this.request('POST', '/play', {
      headers: {
        'User-Agent': 'MediaControl/1.0',
        'Content-Type': BPLIST,
        'X-Apple-Session-ID': this.sessionId,
      },
      body,
      timeoutMs: 15000,
    });
    return response;
  }

  async stop() {
    if (!this.socket || this.closed) return;
    try {
      await this.request('POST', '/stop', {
        headers: { 'User-Agent': 'MediaControl/1.0', 'X-Apple-Session-ID': this.sessionId },
        timeoutMs: 3000,
      });
    } catch {
      // The receiver may close the connection as soon as playback stops.
    }
  }

  /**
   * Keepalive pada channel kontrol AirPlay.
   *
   * Receiver seperti Xiaomi TV mengakhiri sesi bila channel RTSP/TCP ini
   * diam terlalu lama, walaupun playlist HLS masih aktif. `/feedback`
   * dikirim secara berkala supaya sesi terus hidup selama presentasi.
   */
  async feedback() {
    if (!this.socket || this.closed) return;
    this.request('POST', '/feedback', {
      headers: {
        'User-Agent': 'MediaControl/1.0',
        'Content-Type': 'text/parameters',
        'X-Apple-Session-ID': this.sessionId,
      },
      timeoutMs: 3000,
    }).catch(() => {
      // Feedback bersifat best-effort. Kalau TV sedang sibuk, coba lagi
      // pada tick berikutnya.
    });
  }

  close() {
    this.intentionalClose = true;
    this.closed = true;
    this.socket?.destroy();
    this.socket = null;
  }
}

module.exports = { AirPlayV1Client };
