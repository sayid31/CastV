export type NetworkConfig = {
  port: number;
  addresses: string[];
  urls: string[];
  devServerUrl: string | null;
};

export type CastMessage = {
  type: string;
  room?: string;
  token?: string;
  role?: 'sender' | 'receiver';
  peerPresent?: boolean;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  code?: string;
  name?: string;
  deviceId?: string;
  message?: string;
};

const SIGNALING_PORT = 43117;

export function getSignalingUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const isDevPage = window.location.port === '5173';
  const port = isDevPage ? SIGNALING_PORT : (window.location.port || SIGNALING_PORT);
  return `${protocol}//${window.location.hostname}:${port}/ws`;
}

export async function getNetworkConfig(): Promise<NetworkConfig> {
  try {
    const localResponse = await fetch('/api/network', { headers: { Accept: 'application/json' } });
    if (localResponse.ok) return (await localResponse.json()) as NetworkConfig;
  } catch {
    // Development loads the sender from Vite, so the signaling API is on 43117.
  }
  const response = await fetch(`http://127.0.0.1:${SIGNALING_PORT}/api/network`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Signaling server tidak dapat dihubungi.');
  return (await response.json()) as NetworkConfig;
}

export function createRoomCode(length = 6): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

export function normalizeRoom(value: string | null | undefined): string {
  return (value || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12);
}

export function createViewerToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function makeReceiverBaseUrl(config: NetworkConfig): URL {
  const fallbackHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? (config.addresses[0] || '127.0.0.1')
    : window.location.hostname;
  const base = config.devServerUrl
    ? new URL(config.devServerUrl)
    : new URL(`http://${fallbackHost}:${config.port}`);
  base.hostname = fallbackHost;
  base.port = config.devServerUrl ? base.port : String(config.port);
  base.pathname = '/receiver.html';
  base.search = '';
  base.hash = '';
  return base;
}

export function makeReceiverUrl(config: NetworkConfig, room: string, token: string): string {
  const base = makeReceiverBaseUrl(config);
  base.hash = new URLSearchParams({ room, token }).toString();
  return base.toString();
}

export function makeDiscoveryUrl(config: NetworkConfig): string {
  const base = makeReceiverBaseUrl(config);
  base.searchParams.set('nearby', '1');
  return base.toString();
}

export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({
    // MVP relies on direct host candidates on the local network.
    // TURN can be added later for networks that block peer-to-peer traffic.
    iceServers: [],
    bundlePolicy: 'max-bundle',
  });
}

export function sendCastMessage(socket: WebSocket, message: CastMessage): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}
