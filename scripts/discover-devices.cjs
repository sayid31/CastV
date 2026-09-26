const net = require('node:net');
const { Bonjour } = require('bonjour-service');

const SERVICE_TYPES = [
  { type: 'airplay', label: 'AirPlay' },
  { type: 'raop', label: 'RAOP/AirPlay' },
  { type: 'googlecast', label: 'Google Cast' },
  { type: 'pdl-datastream', label: 'DLNA' },
];

const timeoutMs = Number(process.env.CASTV_DISCOVERY_TIMEOUT || 15000);
const probeAirPlay = process.argv.includes('--probe-airplay');
const bonjour = new Bonjour({});
const browsers = [];
const seen = new Set();

function privateIpv4(address) {
  return typeof address === 'string' && /^(\d{1,3}\.){3}\d{1,3}$/.test(address)
    && !address.startsWith('127.')
    && address !== '0.0.0.0';
}

function normalize(service, meta) {
  const addresses = (service.addresses || []).filter(privateIpv4);
  const address = addresses[0] || service.host || '';
  const key = `${meta.type}|${address}|${service.port}|${service.name}`;
  if (seen.has(key)) return;
  seen.add(key);
  return {
    protocol: meta.label,
    name: service.name,
    host: service.host,
    address,
    addresses,
    port: service.port,
    model: service.txt?.model || service.txt?.md || service.txt?.fn || '',
    id: service.txt?.id || '',
    features: service.txt?.features || service.txt?.ft || '',
    txt: service.txt || {},
  };
}

function probe(device) {
  if (!probeAirPlay || !device.address || !device.port) return;
  const socket = net.createConnection({ host: device.address, port: device.port });
  let response = '';
  socket.setTimeout(2500);
  socket.on('connect', () => {
    socket.write(`GET /info HTTP/1.1\r\nHost: ${device.address}\r\nConnection: close\r\n\r\n`);
  });
  socket.on('data', (chunk) => {
    response += chunk.toString('latin1');
    const headerEnd = response.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const server = /^Server:\s*(.+)$/im.exec(response.slice(0, headerEnd))?.[1]?.trim();
      if (server) console.log(`  probe: ${server}`);
      socket.destroy();
    }
  });
  socket.on('timeout', () => socket.destroy());
  socket.on('error', () => {});
}

console.log(`Scanning mDNS for ${Math.round(timeoutMs / 1000)} seconds…`);
for (const meta of SERVICE_TYPES) {
  const browser = bonjour.find({ type: meta.type, protocol: 'tcp' }, (service) => {
    const device = normalize(service, meta);
    if (!device) return;
    console.log(JSON.stringify(device));
    probe(device);
  });
  browser.on('error', (error) => console.error(`mDNS ${meta.type} error: ${error.message}`));
  browser.start();
  browsers.push(browser);
}

const timer = setTimeout(() => {
  for (const browser of browsers) browser.stop();
  bonjour.destroy();
}, timeoutMs);
timer.unref?.();

process.on('SIGINT', () => {
  clearTimeout(timer);
  for (const browser of browsers) browser.stop();
  bonjour.destroy();
  process.exit(0);
});
