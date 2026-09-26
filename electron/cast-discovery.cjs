const { EventEmitter } = require('node:events');
const os = require('node:os');
const { Bonjour } = require('bonjour-service');

const SERVICE_TYPES = [
  { type: 'airplay', protocol: 'airplay' },
  { type: 'googlecast', protocol: 'cast' },
];

function isUsableAddress(value) {
  return typeof value === 'string' && /^(\d{1,3}\.){3}\d{1,3}$/.test(value) && !value.startsWith('127.');
}

function getLocalAddresses() {
  return new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map((item) => item.address));
}

function normalizeName(value) {
  return String(value || 'TV').replaceAll('\\032', ' ').replaceAll('\\.', '.').trim().slice(0, 100) || 'TV';
}

function parseFeatures(value) {
  const match = /^0x([0-9a-f]{1,8})(?:,0x([0-9a-f]{1,8}))?$/i.exec(String(value || '').trim());
  if (!match) return 0n;
  const low = BigInt(`0x${match[1]}`);
  const high = match[2] ? BigInt(`0x${match[2]}`) : 0n;
  return (high << 32n) | low;
}

class CastDiscovery extends EventEmitter {
  constructor() {
    super();
    this.bonjour = new Bonjour({});
    this.browsers = [];
    this.targets = new Map();
    this.pruneTimer = null;
    this.refreshTimer = null;
  }

  start() {
    if (this.browsers.length) return;
    for (const service of SERVICE_TYPES) {
      const browser = this.bonjour.find({ type: service.type, protocol: 'tcp' }, (found) => {
        this.upsert(found, service.protocol);
      });
      browser.on('error', () => {});
      browser.start();
      this.browsers.push({ browser, protocol: service.protocol });
    }
    this.pruneTimer = setInterval(() => this.prune(), 10000);
    this.pruneTimer.unref?.();
    this.refreshTimer = setInterval(() => this.refresh(), 3000);
    this.refreshTimer.unref?.();
    setTimeout(() => this.refresh(), 500);
  }

  refresh() {
    for (const entry of this.browsers) {
      try {
        entry.browser.update();
        for (const service of entry.browser.services()) this.upsert(service, entry.protocol);
      } catch {
        // The interface may disappear while Windows changes networks.
      }
    }
  }

  rescan() {
    // bonjour-service can miss a late mDNS announcement on Windows when a
    // browser socket stays open across a network transition. Recreate the
    // resolver for an explicit rescan so Share Screen always gets a fresh view.
    this.stop();
    this.bonjour = new Bonjour({});
    this.start();
  }

  upsert(found, protocol) {
    const addresses = (found.addresses || []).filter(isUsableAddress);
    const localAddresses = getLocalAddresses();
    if (addresses.some((item) => localAddresses.has(item))) return;
    const address = addresses[0] || found.host || '';
    if (!address || !found.port) return;
    const txt = found.txt || {};
    const key = `${protocol}:${address}:${found.port}`;
    const features = parseFeatures(txt.features || txt.ft);
    const previous = this.targets.get(key);
    const target = {
      id: key,
      protocol,
      name: normalizeName(protocol === 'cast' ? (txt.fn || found.name) : found.name),
      host: found.host || address,
      address,
      addresses,
      port: found.port,
      model: txt.model || txt.md || '',
      features: txt.features || txt.ft || '',
      video: protocol === 'cast' ? ((Number(txt.ca || 0) & 1) !== 0 || !txt.ca) : (features & (1n << 7n)) !== 0n,
      pairingRequired: protocol === 'airplay' && (txt.pw === 'true' || (parseInt(txt.flags || txt.sf || '0', 16) & (0x8 | 0x80 | 0x200)) !== 0),
      lastSeen: Date.now(),
    };
    if (!previous || JSON.stringify({ ...previous, lastSeen: 0 }) !== JSON.stringify({ ...target, lastSeen: 0 })) {
      this.targets.set(key, target);
      this.emit('change', this.list());
    } else {
      previous.lastSeen = target.lastSeen;
    }
  }

  prune() {
    const cutoff = Date.now() - 30000;
    let changed = false;
    for (const [id, target] of this.targets) {
      if (target.lastSeen < cutoff) {
        this.targets.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('change', this.list());
  }

  list() {
    return [...this.targets.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  stop() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.pruneTimer = null;
    this.refreshTimer = null;
    for (const entry of this.browsers) {
      try { entry.browser.stop(); } catch { /* already stopped */ }
    }
    this.browsers = [];
    try { this.bonjour.destroy(); } catch { /* already destroyed */ }
  }
}

module.exports = { CastDiscovery };
