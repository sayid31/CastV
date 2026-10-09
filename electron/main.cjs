const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session, shell } = require('electron');
const path = require('node:path');
const { createCastServer, getLanAddresses } = require('../server/index.cjs');
const { AirPlayV1Client } = require('./airplay-client.cjs');
const { CastDiscovery } = require('./cast-discovery.cjs');

const isDevelopment = Boolean(process.env.CASTV_DEV_SERVER_URL);
const port = Number(process.env.CASTV_PORT || 43117);
let mainWindow;
let castServer;
let castDiscovery;
let airplayClient;
let airplayWatchdog;
let airplayKeepAlive;
let airplayStallWatch;
let airplayLastFetchCount = 0;
let selectedSourceId = null;
let availableSourceIds = new Set();

function loadSenderWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#f4fafc',
    title: 'CastV',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // The site root is the public landing page; the desktop shell lives at /app.html.
  const appOrigin = isDevelopment
    ? process.env.CASTV_DEV_SERVER_URL
    : `http://127.0.0.1:${port}`;
  const senderUrl = `${appOrigin}/app.html`;

  mainWindow.loadURL(senderUrl);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Same-origin navigation stays inside the app; anything else opens externally.
    if (!url.startsWith(appOrigin)) {
      event.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function isTrustedRenderer(event) {
  return Boolean(mainWindow && event.sender === mainWindow.webContents);
}

async function listDisplaySources() {
  return desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  });
}

function getAirplayStreamHost(targetAddress = '') {
  const addresses = getLanAddresses();
  const targetParts = String(targetAddress).split('.').map(Number);
  if (targetParts.length === 4 && !Number.isNaN(targetParts[0])) {
    const sameSubnet = addresses.find((address) => {
      const parts = address.split('.').map(Number);
      return parts.length === 4 && parts.slice(0, 3).every((part, index) => part === targetParts[index]);
    });
    if (sameSubnet) return sameSubnet;
  }
  return addresses[0] || '127.0.0.1';
}

async function stopAirplayClient() {
  if (airplayWatchdog) clearTimeout(airplayWatchdog);
  airplayWatchdog = null;
  if (airplayKeepAlive) clearInterval(airplayKeepAlive);
  airplayKeepAlive = null;
  if (airplayStallWatch) clearInterval(airplayStallWatch);
  airplayStallWatch = null;
  if (!airplayClient) return;
  const client = airplayClient;
  airplayClient = null;
  try { await client.stop(); } catch { /* receiver may already be gone */ }
  client.close();
}

function clearAirplayTimers() {
  if (airplayWatchdog) clearTimeout(airplayWatchdog);
  airplayWatchdog = null;
  if (airplayKeepAlive) clearInterval(airplayKeepAlive);
  airplayKeepAlive = null;
  if (airplayStallWatch) clearInterval(airplayStallWatch);
  airplayStallWatch = null;
}

function configureIpc() {
  ipcMain.handle('castv:get-display-sources', async (event) => {
    if (!isTrustedRenderer(event)) return [];
    const sources = await listDisplaySources();
    availableSourceIds = new Set(sources.map((source) => source.id));
    return sources.map((source) => ({
      id: source.id,
      name: source.name || (source.id.startsWith('screen:') ? 'Layar' : 'Window'),
      type: source.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: source.thumbnail?.toDataURL?.() || '',
      appIcon: source.appIcon?.toDataURL?.() || '',
    }));
  });

  ipcMain.handle('castv:select-display-source', (event, sourceId) => {
    if (!isTrustedRenderer(event) || typeof sourceId !== 'string' || !availableSourceIds.has(sourceId)) return false;
    selectedSourceId = sourceId;
    return true;
  });

  ipcMain.handle('castv:get-cast-targets', (event) => {
    if (!isTrustedRenderer(event)) return [];
    castDiscovery?.start();
    return castDiscovery?.list() || [];
  });

  ipcMain.handle('castv:rescan-cast-targets', (event) => {
    if (!isTrustedRenderer(event)) return false;
    castDiscovery?.rescan();
    return true;
  });

  ipcMain.handle('castv:airplay-set-meta', (event, meta) => {
    if (!isTrustedRenderer(event) || !castServer) return null;
    return castServer.setAirplayMeta(meta);
  });

  ipcMain.handle('castv:airplay-set-init', (event, data) => {
    if (!isTrustedRenderer(event) || !castServer) return 0;
    return castServer.setAirplayInit(Buffer.from(data));
  });

  ipcMain.handle('castv:airplay-set-segment', (event, data, info) => {
    if (!isTrustedRenderer(event) || !castServer) return false;
    return castServer.setAirplaySegment(Buffer.from(data), info || {});
  });

  ipcMain.handle('castv:airplay-play', async (event, target) => {
    if (!isTrustedRenderer(event) || !castServer || !target || target.protocol !== 'airplay') {
      throw new Error('Target AirPlay tidak valid.');
    }
    await stopAirplayClient();
    const client = new AirPlayV1Client({
      host: target.address,
      port: target.port,
      name: target.name,
      senderName: 'CastV',
      onClose: () => {
        // TV menutup koneksi di tengah presentasi. Beri tahu renderer supaya
        // bisa menampilkan status "TV terputus" beserta tombol sambung ulang.
        if (airplayClient !== client) return;
        airplayClient = null;
        mainWindow?.webContents.send('castv:airplay-disconnected', {
          name: target.name,
          message: 'TV menutup koneksi AirPlay. TV mungkin sleep, ganti input, atau kehabisan memori.',
        });
      },
    });
    try {
      const info = await client.getInfo();
      if (target.pairingRequired) throw new Error('TV ini meminta pairing AirPlay. Pairing belum didukung pada MVP CastV.');
      const streamUrl = castServer.getAirplayStreamUrl(getAirplayStreamHost(target.address));
      const fetchBaseline = castServer.getAirplayFetchCount(target.address);
      await client.play(streamUrl);
      airplayClient = client;
      clearAirplayTimers();

      // Keepalive channel kontrol: receiver mengakhiri sesi bila RTSP/TCP
      // ini diam, terlepas dari playlist HLS yang masih tersaji. Tanpa ini
      // presentasi bisa berhenti sendiri setelah +/- 1 menit.
      airplayKeepAlive = setInterval(() => { void client.feedback(); }, 2000);

      // Deteksi TV berhenti mengambil segment. Hanya memberi peringatan dan
      // tombol ulangi - TIDAK mematikan stream otomatis.
      airplayLastFetchCount = castServer.getAirplayFetchCount(target.address);
      airplayStallWatch = setInterval(() => {
        if (airplayClient !== client) return;
        const current = castServer.getAirplayFetchCount(target.address);
        if (current > airplayLastFetchCount) {
          airplayLastFetchCount = current;
          return;
        }
        mainWindow?.webContents.send('castv:airplay-stalled', {
          name: target.name,
          message: 'TV berhenti mengambil stream. Layar di TV mungkin membeku. Klik "Bagikan lagi" untuk menyambung ulang.',
        });
      }, 15000);

      // Watchdog hanya memberi PERINGATAN, tidak lagi mematikan stream.
      // Sebelumnya stream dimatikan otomatis sebelum 1 menit hanya karena TV
      // butuh >12 detik untuk mulai mengambil segment.
      airplayWatchdog = setTimeout(() => {
        if (airplayClient !== client) return;
        if (castServer.getAirplayFetchCount(target.address) <= fetchBaseline) {
          mainWindow?.webContents.send('castv:airplay-warning', {
            name: target.name,
            message: 'TV belum mengambil stream. Kalau layar tetap kosong, periksa firewall Windows untuk jaringan Private.',
          });
        }
      }, 30000);
      return { ok: true, streamUrl, info: { name: info.name, model: info.model, sourceVersion: info.sourceVersion } };
    } catch (error) {
      client.close();
      throw error;
    }
  });

  ipcMain.handle('castv:airplay-stop', async (event) => {
    if (!isTrustedRenderer(event)) return false;
    await stopAirplayClient();
    castServer?.resetAirplayStream();
    return true;
  });
}

function configureDisplayMedia() {
  if (!session.defaultSession.setDisplayMediaRequestHandler) return;
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await listDisplaySources();
      if (!sources.length) {
        selectedSourceId = null;
        callback({});
        return;
      }
      const selectedSource = sources.find((source) => source.id === selectedSourceId) || sources[0];
      selectedSourceId = null;
      callback({
        video: selectedSource,
        // Chromium can request Windows loopback audio when the selected source
        // exposes it. Receivers fall back to video-only when it is absent.
        ...(process.platform === 'win32' && request.audioRequested ? { audio: 'loopback' } : {}),
      });
    } catch {
      selectedSourceId = null;
      callback({});
    }
  }, { useSystemPicker: false });

  // Chromium may issue a `media` permission check before it reaches the
  // display-media handler. The renderer is local and only requests screen
  // media, so allow both related permission names here.
  const allowedPermissions = new Set(['display-capture', 'media', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(allowedPermissions.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => allowedPermissions.has(permission));
}

app.setAppUserModelId('com.castv.screen-mirror');

app.whenReady().then(async () => {
  configureIpc();
  configureDisplayMedia();
  castDiscovery = new CastDiscovery();
  castDiscovery.on('change', (targets) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('castv:cast-targets-changed', targets);
  });
  castDiscovery.start();
  try {
    castServer = createCastServer({
      port,
      staticDir: path.join(__dirname, '..', 'dist'),
      devServerUrl: isDevelopment ? process.env.CASTV_DEV_SERVER_URL : null,
    });
    await castServer.listen();
    loadSenderWindow();
  } catch (error) {
    dialog.showErrorBox('CastV tidak dapat dimulai', `Server lokal gagal dibuka.\n\n${error.message}`);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && castServer) loadSenderWindow();
});

app.on('before-quit', async (event) => {
  castDiscovery?.stop();
  if (!castServer) {
    await stopAirplayClient();
    return;
  }
  event.preventDefault();
  await stopAirplayClient();
  await castServer.close();
  castServer = null;
  app.exit(0);
});
