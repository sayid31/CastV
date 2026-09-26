import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  createPeerConnection,
  createRoomCode,
  createViewerToken,
  getNetworkConfig,
  getSignalingUrl,
  makeDiscoveryUrl,
  makeReceiverUrl,
  sendCastMessage,
  stopStream,
  type CastMessage,
  type NetworkConfig,
} from '../lib/cast';
import { Icon } from './Icon';
import { AirplayVideoPipeline } from '../lib/airplay/pipeline';
import type { CastDisplaySource, CastTarget } from '../env';

type SessionStatus = 'idle' | 'creating' | 'waiting' | 'negotiating' | 'streaming' | 'error';

type NearbyDevice = {
  id: string;
  name: string;
  type: string;
  lastSeen: number;
};

type StatusView = {
  label: string;
  detail: string;
  tone: 'neutral' | 'blue' | 'green' | 'red';
};

const statusViews: Record<SessionStatus, StatusView> = {
  idle: { label: 'Siap dimulai', detail: 'Buat sesi untuk mendapatkan QR code.', tone: 'neutral' },
  creating: { label: 'Menyiapkan sesi', detail: 'Membuka koneksi lokal…', tone: 'blue' },
  waiting: { label: 'Menunggu receiver', detail: 'Pilih receiver nearby atau pindai QR code.', tone: 'blue' },
  negotiating: { label: 'Menghubungkan', detail: 'Menyiapkan stream terenkripsi…', tone: 'blue' },
  streaming: { label: 'Sedang streaming', detail: 'Layar sedang dikirim ke receiver.', tone: 'green' },
  error: { label: 'Perlu perhatian', detail: 'Periksa koneksi lalu coba lagi.', tone: 'red' },
};

function copyToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement('textarea');
  input.value = value;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.focus();
  input.select();
  document.execCommand('copy');
  input.remove();
  return Promise.resolve();
}

export function SenderConsole() {
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [roomCode, setRoomCode] = useState('');
  const [receiverUrl, setReceiverUrl] = useState('');
  const [qrCode, setQrCode] = useState('');
  const [config, setConfig] = useState<NetworkConfig | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<'code' | 'url' | null>(null);
  const [hasStream, setHasStream] = useState(false);
  const [receiverReady, setReceiverReady] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [receiverPickerOpen, setReceiverPickerOpen] = useState(false);
  const [selectedNearbyId, setSelectedNearbyId] = useState('');
  const [displaySources, setDisplaySources] = useState<CastDisplaySource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [nearbyDevices, setNearbyDevices] = useState<NearbyDevice[]>([]);
  const [nearbyError, setNearbyError] = useState('');
  const [nearbyConnectingId, setNearbyConnectingId] = useState('');
  const [nearbyEntryUrl, setNearbyEntryUrl] = useState('');
  const [castTargets, setCastTargets] = useState<CastTarget[]>([]);
  const [selectedCastTarget, setSelectedCastTarget] = useState<CastTarget | null>(null);
  const [activeAirplayTarget, setActiveAirplayTarget] = useState<CastTarget | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const nearbySocketRef = useRef<WebSocket | null>(null);
  const pendingNearbyClaimRef = useRef('');
  const autoOpenSourceAfterNearbyRef = useRef(false);
  const airplayTargetRef = useRef<CastTarget | null>(null);
  const airplayPipelineRef = useRef<AirplayVideoPipeline | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const roomCodeRef = useRef('');
  const tokenRef = useRef('');
  const configRef = useRef<NetworkConfig | null>(null);
  const peerReadyRef = useRef(false);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const previewRef = useRef<HTMLVideoElement | null>(null);

  const view = statusViews[status];

  const closePeer = () => {
    peerRef.current?.close();
    peerRef.current = null;
    pendingCandidatesRef.current = [];
  };

  const closeSocket = () => {
    if (socketRef.current) {
      socketRef.current.onclose = null;
      socketRef.current.close();
      socketRef.current = null;
    }
  };

  const stopAirplayPipeline = () => {
    const pipeline = airplayPipelineRef.current;
    airplayPipelineRef.current = null;
    if (pipeline) void pipeline.stop();
    const target = airplayTargetRef.current;
    airplayTargetRef.current = null;
    if (target && window.castv?.stopAirplay) void window.castv.stopAirplay();
    setActiveAirplayTarget(null);
  };

  const stopCurrentStream = () => {
    stopAirplayPipeline();
    stopStream(streamRef.current);
    streamRef.current = null;
    setHasStream(false);
    if (previewRef.current) previewRef.current.srcObject = null;
  };

  const endSession = (notifyPeer = true) => {
    if (notifyPeer && socketRef.current?.readyState === WebSocket.OPEN) {
      sendCastMessage(socketRef.current, { type: 'stop' });
    }
    closePeer();
    stopCurrentStream();
    closeSocket();
    setRoomCode('');
    roomCodeRef.current = '';
    tokenRef.current = '';
    setReceiverUrl('');
    setQrCode('');
    setSourcePickerOpen(false);
    setDisplaySources([]);
    setSelectedSourceId('');
    setSourceError('');
    setNearbyConnectingId('');
    pendingNearbyClaimRef.current = '';
    autoOpenSourceAfterNearbyRef.current = false;
    setReceiverPickerOpen(false);
    setSelectedNearbyId('');
    setSelectedCastTarget(null);
    setReceiverReady(false);
    peerReadyRef.current = false;
    setStatus('idle');
    setError('');
  };

  const stopSharing = () => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      sendCastMessage(socketRef.current, { type: 'stop' });
    }
    closePeer();
    stopCurrentStream();
    setSelectedCastTarget(null);
    setStatus('waiting');
  };

  useEffect(() => {
    getNetworkConfig()
      .then((nextConfig) => {
        configRef.current = nextConfig;
        setConfig(nextConfig);
        setNearbyEntryUrl(makeDiscoveryUrl(nextConfig));
      })
      .catch(() => {
        // The sender can still attempt to create a room; the error is shown later
        // if the signaling server is not available.
      });

    return () => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        sendCastMessage(socketRef.current, { type: 'stop' });
      }
      closePeer();
      stopCurrentStream();
      closeSocket();
    };
    // The console owns the long-lived session for the lifetime of the app window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const api = window.castv;
    if (!api?.getCastTargets) return;
    let disposed = false;
    const updateTargets = (targets: CastTarget[]) => {
      if (!disposed) setCastTargets(targets.filter((target) => target.protocol === 'airplay' && target.video && !target.pairingRequired));
    };
    const unsubscribe = api.onCastTargets(updateTargets);
    void api.getCastTargets().then(updateTargets).catch(() => undefined);
    const rescanTimer = window.setInterval(() => { void api.rescanCastTargets(); }, 10000);
    return () => {
      disposed = true;
      window.clearInterval(rescanTimer);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const api = window.castv;
    if (!api?.onAirplayError) return;
    return api.onAirplayError((message) => {
      setError(message);
      setStatus('error');
      const pipeline = airplayPipelineRef.current;
      airplayPipelineRef.current = null;
      if (pipeline) void pipeline.stop();
      void api.stopAirplay();
      setActiveAirplayTarget(null);
    });
  }, []);

  useEffect(() => {
    const socket = new WebSocket(getSignalingUrl());
    nearbySocketRef.current = socket;
    socket.onopen = () => {
      sendCastMessage(socket, { type: 'watch' });
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as CastMessage & { devices?: NearbyDevice[] };
        if (message.type === 'nearby-update') setNearbyDevices(message.devices || []);
        if (message.type === 'error') setNearbyError(message.message || 'Nearby discovery tidak dapat digunakan.');
      } catch {
        // Ignore malformed watcher messages.
      }
    };
    socket.onerror = () => setNearbyError('Nearby discovery belum terhubung.');
    return () => {
      socket.onclose = null;
      socket.close();
      if (nearbySocketRef.current === socket) nearbySocketRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (previewRef.current && streamRef.current) previewRef.current.srcObject = streamRef.current;
  }, [hasStream]);

  const handleSocketMessage = (event: MessageEvent<string>) => {
    let message: CastMessage;
    try {
      message = JSON.parse(event.data) as CastMessage;
    } catch {
      return;
    }

    if (message.type === 'joined') {
      setStatus(streamRef.current ? 'negotiating' : 'waiting');
      setError('');
      if (pendingNearbyClaimRef.current && socketRef.current?.readyState === WebSocket.OPEN) {
        sendCastMessage(socketRef.current, { type: 'claim-receiver', deviceId: pendingNearbyClaimRef.current });
        pendingNearbyClaimRef.current = '';
      }
      if (message.peerPresent) {
        peerReadyRef.current = true;
        setReceiverReady(true);
        if (streamRef.current) void createOffer();
      }
    }
    if (message.type === 'nearby-update') {
      const devices = (message as CastMessage & { devices?: NearbyDevice[] }).devices || [];
      setNearbyDevices(devices);
    }
    if (message.type === 'receiver-claimed') {
      setNearbyConnectingId('');
      setNearbyError('');
    }
    if (message.type === 'peer-ready' && message.role === 'receiver') {
      peerReadyRef.current = true;
      setReceiverReady(true);
      setNearbyConnectingId('');
      if (streamRef.current) void createOffer();
    }
    if (message.type === 'answer' && message.sdp && peerRef.current) {
      void peerRef.current.setRemoteDescription(message.sdp).then(async () => {
        for (const candidate of pendingCandidatesRef.current.splice(0)) {
          await peerRef.current?.addIceCandidate(candidate);
        }
        setStatus('streaming');
      }).catch(() => setStatus('error'));
    }
    if (message.type === 'ice' && message.candidate && peerRef.current) {
      if (peerRef.current.remoteDescription) {
        void peerRef.current.addIceCandidate(message.candidate);
      } else {
        pendingCandidatesRef.current.push(message.candidate);
      }
    }
    if (message.type === 'peer-left' && message.role === 'receiver') {
      peerReadyRef.current = false;
      setReceiverReady(false);
      setNearbyConnectingId('');
      autoOpenSourceAfterNearbyRef.current = false;
      setStatus(streamRef.current ? 'waiting' : 'waiting');
    }
    if (message.type === 'stopped') {
      closePeer();
      setReceiverReady(false);
      peerReadyRef.current = false;
      setStatus('waiting');
    }
    if (message.type === 'error') {
      setNearbyConnectingId('');
      autoOpenSourceAfterNearbyRef.current = false;
      setError(message.message || 'Sesi tidak dapat dibuka.');
      setNearbyError(message.message || 'Sesi tidak dapat dibuka.');
      setStatus('error');
    }
  };

  const connectSocket = (code: string) => {
    closeSocket();
    const socket = new WebSocket(getSignalingUrl());
    socketRef.current = socket;
    socket.onopen = () => {
      sendCastMessage(socket, { type: 'join', room: code, role: 'sender', token: tokenRef.current });
    };
    socket.onmessage = handleSocketMessage;
    socket.onerror = () => {
      setError('Tidak dapat menghubungi signaling server.');
      setStatus('error');
    };
    socket.onclose = () => {
      if (status === 'streaming' || status === 'negotiating') setStatus('waiting');
    };
  };

  const createOffer = async () => {
    if (!streamRef.current || !socketRef.current || !peerReadyRef.current) return;
    setStatus('negotiating');
    closePeer();
    try {
      const peer = createPeerConnection();
      peerRef.current = peer;
      peer.onicecandidate = (event) => {
        if (event.candidate) {
          sendCastMessage(socketRef.current!, { type: 'ice', candidate: event.candidate.toJSON() });
        }
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'connected') setStatus('streaming');
        if (peer.connectionState === 'failed') setStatus('error');
        if (peer.connectionState === 'disconnected') setStatus('negotiating');
      };
      for (const track of streamRef.current.getTracks()) {
        if (track.kind === 'video' && 'contentHint' in track) track.contentHint = 'detail';
        peer.addTrack(track, streamRef.current);
      }
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (peer.localDescription) {
        sendCastMessage(socketRef.current, { type: 'offer', sdp: peer.localDescription });
      }
    } catch {
      closePeer();
      setError('Browser tidak dapat menyiapkan stream. Coba mulai sharing kembali.');
      setStatus('error');
    }
  };

  const createSession = async (): Promise<string | null> => {
    if (roomCodeRef.current) return roomCodeRef.current;
    setStatus('creating');
    setError('');
    const code = createRoomCode();
    const token = createViewerToken();
    const networkConfig = configRef.current || await getNetworkConfig().catch(() => null);
    if (!networkConfig) {
      setError('Signaling server belum aktif. Jalankan CastV dari aplikasi desktop.');
      setStatus('error');
      return null;
    }
    configRef.current = networkConfig;
    setConfig(networkConfig);
    const url = makeReceiverUrl(networkConfig, code, token);
    setRoomCode(code);
    roomCodeRef.current = code;
    tokenRef.current = token;
    setReceiverUrl(url);
    setQrCode(await QRCode.toDataURL(url, { width: 260, margin: 2, color: { dark: '#102330', light: '#ffffff' } }));
    connectSocket(code);
    setStatus('waiting');
    return code;
  };

  const startCapture = async (sourceId?: string, airplayTarget?: CastTarget | null) => {
    const isAirplay = airplayTarget?.protocol === 'airplay';
    if (!isAirplay) {
      const code = await createSession();
      if (!code) return;
    }
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Browser ini tidak mendukung screen sharing.');
      if (sourceId && window.castv?.selectDisplaySource) {
        const selected = await window.castv.selectDisplaySource(sourceId);
        if (!selected) throw new Error('Sumber layar sudah tidak tersedia. Silakan pilih ulang.');
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: true,
      });
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = stream;
      setHasStream(true);
      const [firstVideoTrack] = stream.getVideoTracks();
      firstVideoTrack?.addEventListener('ended', () => {
        if (streamRef.current === stream) stopSharing();
      });

      if (isAirplay && airplayTarget) {
        if (!window.castv?.playAirplay) throw new Error('AirPlay hanya tersedia pada CastV desktop.');
        setStatus('negotiating');
        setError('');
        setNearbyConnectingId(airplayTarget.id);
        airplayTargetRef.current = airplayTarget;
        setActiveAirplayTarget(airplayTarget);
        const pipeline = new AirplayVideoPipeline({
          onMeta: (meta) => window.castv!.setAirplayMeta(meta),
          onInit: (data) => window.castv!.setAirplayInit(data),
          onSegment: (segment) => window.castv!.setAirplaySegment(segment.data, {
            sequence: segment.sequence,
            duration: segment.durationSec,
            initVersion: segment.initVersion,
          }),
          onError: (pipelineError) => setError(pipelineError.message),
        });
        airplayPipelineRef.current = pipeline;
        await pipeline.start(stream);
        await pipeline.waitUntilReady();
        const result = await window.castv.playAirplay(airplayTarget);
        if (!result.ok) throw new Error('AirPlay receiver tidak menerima stream.');
        peerReadyRef.current = true;
        setReceiverReady(true);
        setNearbyConnectingId('');
        setSelectedCastTarget(airplayTarget);
        setStatus('streaming');
      } else if (peerReadyRef.current) {
        await createOffer();
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Izin screen sharing ditolak.';
      const permissionDenied = message.toLowerCase().includes('permission denied') || (caught instanceof DOMException && caught.name === 'NotAllowedError');
      if (isAirplay) {
        stopCurrentStream();
        setNearbyConnectingId('');
      }
      if (!message.toLowerCase().includes('dibatalkan') && !message.toLowerCase().includes('canceled')) {
        setError(permissionDenied
          ? 'Izin capture layar ditolak. Klik Mulai berbagi lagi dan izinkan CastV memilih layar.'
          : message);
        setStatus('error');
      }
    }
  };

  const openShareFlow = async () => {
    setSelectedNearbyId('');
    setSelectedCastTarget(null);
    setNearbyError('');
    if (window.castv?.getCastTargets) {
      try {
        const targets = await window.castv.getCastTargets();
        setCastTargets(targets.filter((target) => target.protocol === 'airplay' && target.video && !target.pairingRequired));
        void window.castv.rescanCastTargets();
      } catch {
        // Browser receiver discovery remains available when mDNS is unavailable.
      }
    }
    setReceiverPickerOpen(true);
  };

  const openSourcePicker = async (airplayTarget?: CastTarget | null) => {
    if (!airplayTarget) {
      const code = await createSession();
      if (!code) return;
    }
    if (!window.castv?.getDisplaySources) {
      await startCapture(undefined, airplayTarget);
      return;
    }

    setSourcePickerOpen(true);
    setSourceLoading(true);
    setSourceError('');
    setSelectedSourceId('');
    try {
      const sources = await window.castv.getDisplaySources();
      setDisplaySources(sources);
      if (!sources.length) setSourceError('Tidak ada layar atau window yang bisa dibagikan.');
    } catch {
      setSourceError('Gagal membaca daftar layar. Tutup aplikasi lalu coba lagi.');
    } finally {
      setSourceLoading(false);
    }
  };

  const confirmSource = async () => {
    if (!selectedSourceId) {
      setSourceError('Pilih satu layar atau window terlebih dahulu.');
      return;
    }
    setSourcePickerOpen(false);
    await startCapture(selectedSourceId, selectedCastTarget);
  };

  useEffect(() => {
    if (autoOpenSourceAfterNearbyRef.current && receiverReady && !nearbyConnectingId && !hasStream && !sourcePickerOpen) {
      autoOpenSourceAfterNearbyRef.current = false;
      setReceiverPickerOpen(false);
      void openSourcePicker();
    }
  }, [receiverReady, nearbyConnectingId, hasStream, sourcePickerOpen]);

  useEffect(() => {
    const handleOpenShare = () => { void openShareFlow(); };
    window.addEventListener('castv:open-share', handleOpenShare);
    return () => window.removeEventListener('castv:open-share', handleOpenShare);
    // The handler uses refs for the long-lived session and is safe to mount once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectAirplay = async (target: CastTarget) => {
    setNearbyConnectingId(target.id);
    setNearbyError('');
    airplayTargetRef.current = target;
    setSelectedCastTarget(target);
    setSelectedNearbyId('');
    setReceiverPickerOpen(false);
    setNearbyConnectingId('');
    await openSourcePicker(target);
  };

  const connectNearby = async (deviceId: string, continueToSource = false) => {
    setNearbyConnectingId(deviceId);
    setNearbyError('');
    autoOpenSourceAfterNearbyRef.current = continueToSource;
    const code = await createSession();
    if (!code) {
      setNearbyConnectingId('');
      autoOpenSourceAfterNearbyRef.current = false;
      return;
    }
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      sendCastMessage(socketRef.current, { type: 'claim-receiver', deviceId });
    } else {
      pendingNearbyClaimRef.current = deviceId;
    }
  };

  const copyValue = async (kind: 'code' | 'url', value: string) => {
    await copyToClipboard(value);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1600);
  };

  const lanLabel = useMemo(() => config?.addresses[0] || 'alamat local belum terdeteksi', [config]);
  const airplayTargets = castTargets.filter((target) => target.protocol === 'airplay' && target.video && !target.pairingRequired);
  const receiverCount = nearbyDevices.length + airplayTargets.length;
  const hasSelectedReceiver = Boolean(selectedNearbyId || selectedCastTarget);

  return (
    <section className="sender-console" id="sender-console" aria-labelledby="sender-console-title">
      <div className="console-heading">
        <div>
          <span className="section-kicker">Sender console</span>
          <h2 id="sender-console-title">Kirim layar PC dalam beberapa klik.</h2>
          <p>Klik Share Screen, pilih receiver nearby, lalu pilih jendela atau seluruh layar yang ingin dibagikan.</p>
        </div>
        <div className={`status-pill status-${view.tone}`} title={view.detail} aria-live="polite">
          <span className="status-dot" />
          <span>{view.label}</span>
        </div>
      </div>

      <div className="console-grid">
        <div className="console-main-card">
          <div className="card-topline">
            <div>
              <span className="mini-label">Sesi aktif</span>
              <div className="room-code-row">
                <strong>{roomCode || (activeAirplayTarget ? 'AIRPLAY' : '— — — — — —')}</strong>
                {roomCode && (
                  <button className="icon-button" onClick={() => copyValue('code', roomCode)} aria-label="Salin kode sesi" title="Salin kode sesi">
                    <Icon name={copied === 'code' ? 'check' : 'copy'} size={17} />
                  </button>
                )}
              </div>
            </div>
            <div className="console-live-indicator">
              <span className="mini-label">Koneksi</span>
              <strong>{receiverReady ? 'Receiver siap' : roomCode || activeAirplayTarget ? 'Menunggu' : 'Belum aktif'}</strong>
            </div>
          </div>

          <div className="console-divider" />

          {activeAirplayTarget ? (
            <div className="console-connected-grid">
              <div className="qr-frame airplay-frame"><Icon name="monitor" size={34} /><span>AirPlay</span></div>
              <div className="session-instructions">
                <span className="mini-label">TV terdeteksi</span>
                <ol>
                  <li><span>1</span><p>{activeAirplayTarget.name} terdeteksi lewat mDNS.</p></li>
                  <li><span>2</span><p>CastV mengirim H.264 melalui AirPlay lokal.</p></li>
                  <li><span>3</span><p>TV tidak membutuhkan aplikasi atau URL tambahan.</p></li>
                </ol>
                <button className="text-button" onClick={() => setShowDetails((value) => !value)}>
                  {showDetails ? 'Sembunyikan detail' : 'Lihat detail koneksi'} <Icon name="arrow-right" size={15} />
                </button>
              </div>
            </div>
          ) : roomCode ? (
            <div className="console-connected-grid">
              <div className="qr-frame">
                {qrCode ? <img src={qrCode} alt="QR code untuk membuka CastV receiver" /> : <div className="qr-loading" />}
                <span className="qr-corner qr-corner-a" />
                <span className="qr-corner qr-corner-b" />
                <span className="qr-corner qr-corner-c" />
                <span className="qr-corner qr-corner-d" />
              </div>
              <div className="session-instructions">
                <span className="mini-label">Cara menghubungkan</span>
                <ol>
                  <li><span>1</span><p>Buka browser receiver di perangkat kedua.</p></li>
                  <li><span>2</span><p>Pilih device nearby, atau pindai QR code sebagai fallback.</p></li>
                  <li><span>3</span><p>Klik <strong>Lanjut pilih layar</strong> dan pilih layar PC.</p></li>
                </ol>
                <button className="text-button" onClick={() => setShowDetails((value) => !value)}>
                  {showDetails ? 'Sembunyikan detail' : 'Lihat detail koneksi'} <Icon name="arrow-right" size={15} />
                </button>
              </div>
            </div>
          ) : (
            <div className="console-empty">
              <div className="cast-scene" aria-hidden="true">
                <span className="cast-glow" />
                <span className="cast-ring" />
                <span className="cast-ring" />
                <span className="cast-ring" />
                <span className="cast-device">
                  <span className="cast-screen">
                    <span className="cast-bars"><i /><i /><i /></span>
                  </span>
                  <span className="cast-stand" />
                </span>
              </div>
              <strong>Belum ada sesi mirroring</strong>
              <p>Klik Share Screen untuk memindai perangkat di sekitar, lalu pilih layar yang ingin dikirim.</p>
            </div>
          )}

          {showDetails && config && (
            <div className="connection-details">
              <div><span>Alamat jaringan</span><code>{lanLabel}</code></div>
              <div><span>Receiver URL</span><code>{receiverUrl}</code></div>
              <p><Icon name={activeAirplayTarget ? 'wifi' : 'lock'} size={14} /> {activeAirplayTarget ? 'AirPlay HLS · koneksi lokal (delay beberapa detik).' : 'Stream memakai koneksi WebRTC terenkripsi antar browser.'}</p>
            </div>
          )}

          {error && <div className="inline-error"><Icon name="x" size={15} /> {error}</div>}

          <div className="console-actions">
            {!hasStream ? (
              <button className="primary-button" onClick={() => void openShareFlow()}>
                <Icon name="monitor-up" size={18} /> Share Screen
              </button>
            ) : (
              <button className="danger-button" onClick={stopSharing}>
                <Icon name="stop" size={16} /> Hentikan share
              </button>
            )}
            {(roomCode || activeAirplayTarget) && <button className="secondary-button" onClick={() => endSession(true)}>Akhiri sesi</button>}
            <span className="action-hint"><Icon name="wifi" size={15} /> Pastikan kedua perangkat satu Wi-Fi</span>
          </div>
        </div>

        <aside className="preview-card">
          <div className="preview-header">
            <span className="mini-label">Preview lokal</span>
            <span className="preview-secure"><Icon name="lock" size={13} /> private</span>
          </div>
          <div className={`preview-screen ${hasStream ? 'has-stream' : ''}`}>
            <video ref={previewRef} autoPlay muted playsInline />
            {!hasStream && (
              <div className="preview-placeholder">
                <div className="preview-icon"><Icon name="monitor" size={24} /></div>
                <strong>Preview akan muncul di sini</strong>
                <span>Screen sharing tidak direkam atau disimpan.</span>
              </div>
            )}
            {hasStream && <div className="preview-overlay"><span className="recording-dot" /> LIVE PREVIEW</div>}
          </div>
          <div className="preview-footer">
            <span><span className="tiny-dot" />{hasStream ? 'Kamera siap' : 'Menunggu izin'}</span>
            <span>{activeAirplayTarget ? 'AirPlay · HLS' : 'WebRTC · LAN'}</span>
          </div>
        </aside>
      </div>

      {receiverPickerOpen && (
        <div className="receiver-picker-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setReceiverPickerOpen(false);
        }}>
          <div className="receiver-picker-modal" role="dialog" aria-modal="true" aria-labelledby="receiver-picker-title">
            <div className="receiver-picker-head">
              <div><span className="section-kicker">Share screen</span><h3 id="receiver-picker-title">Pilih perangkat receiver</h3><p>CastV menemukan TV AirPlay dan browser yang aktif di Wi-Fi yang sama.</p></div>
              <button className="source-picker-close" onClick={() => setReceiverPickerOpen(false)} aria-label="Tutup daftar perangkat"><Icon name="x" size={18} /></button>
            </div>
            <div className="receiver-picker-flow"><span className="flow-step active">1</span><span>Pilih receiver</span><i /><span className="flow-step">2</span><span>Pilih layar</span></div>
            {nearbyError && <div className="nearby-error"><Icon name="x" size={14} /> {nearbyError}</div>}
            {receiverCount > 0 ? (
              <div className="receiver-picker-devices">
                {airplayTargets.map((target) => (
                  <button type="button" key={target.id} className={`receiver-device-option ${selectedCastTarget?.id === target.id ? 'is-selected' : ''}`} onClick={() => { setSelectedCastTarget(target); setSelectedNearbyId(''); setNearbyError(''); }}>
                    <span className="receiver-device-icon receiver-device-icon-tv"><Icon name="monitor" size={19} /></span>
                    <span className="receiver-device-text"><strong>{target.name}</strong><small>AirPlay TV · {target.address}:{target.port}</small></span>
                    <span className="receiver-device-radio">{selectedCastTarget?.id === target.id && <Icon name="check" size={13} />}</span>
                  </button>
                ))}
                {nearbyDevices.map((device) => (
                  <button type="button" key={device.id} className={`receiver-device-option ${selectedNearbyId === device.id ? 'is-selected' : ''}`} onClick={() => { setSelectedNearbyId(device.id); setSelectedCastTarget(null); setNearbyError(''); }}>
                    <span className="receiver-device-icon"><Icon name="globe" size={19} /></span>
                    <span className="receiver-device-text"><strong>{device.name}</strong><small>Browser receiver · Wi-Fi lokal</small></span>
                    <span className="receiver-device-radio">{selectedNearbyId === device.id && <Icon name="check" size={13} />}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="receiver-picker-empty"><div className="receiver-empty-orb"><Icon name="wifi" size={23} /></div><strong>Belum ada receiver nearby</strong><p>TV AirPlay atau browser receiver akan muncul di sini secara otomatis.</p><code>{nearbyEntryUrl || 'Memuat alamat jaringan…'}</code></div>
            )}
            <div className="receiver-picker-qr"><div className="qr-mini-icon"><Icon name="qr" size={19} /></div><div><strong>Belum menemukan perangkat?</strong><span>QR code tetap bisa dipakai sebagai metode alternatif.</span></div><button className="text-button" onClick={() => setReceiverPickerOpen(false)}>Pakai QR <Icon name="arrow-right" size={14} /></button></div>
            <div className="receiver-picker-footer"><span><Icon name="lock" size={14} /> Koneksi tetap private</span><button className="primary-button" disabled={!hasSelectedReceiver || Boolean(nearbyConnectingId)} onClick={() => { if (selectedCastTarget) void connectAirplay(selectedCastTarget); else if (selectedNearbyId) void connectNearby(selectedNearbyId, true); }}>{nearbyConnectingId ? 'Menghubungkan…' : 'Lanjut pilih layar'} <Icon name="arrow-right" size={16} /></button></div>
          </div>
        </div>
      )}

      {sourcePickerOpen && (
        <div className="source-picker-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSourcePickerOpen(false);
        }}>
          <div className="source-picker-modal" role="dialog" aria-modal="true" aria-labelledby="source-picker-title">
            <div className="source-picker-head">
              <div>
                <span className="section-kicker">Pilih sumber</span>
                <h3 id="source-picker-title">Apa yang ingin kamu bagikan?</h3>
                <p>Pilih layar penuh atau satu jendela aplikasi.</p>
              </div>
              <button className="source-picker-close" onClick={() => setSourcePickerOpen(false)} aria-label="Tutup pilihan sumber">
                <Icon name="x" size={18} />
              </button>
            </div>

            {sourceLoading ? (
              <div className="source-picker-loading"><span className="source-loader" /><strong>Memuat layar dan window…</strong><small>CastV sedang membaca sumber dari PC.</small></div>
            ) : (
              <>
                {sourceError && <div className="source-picker-error"><Icon name="x" size={15} /> {sourceError}</div>}
                <div className="source-grid">
                  {displaySources.map((source) => (
                    <button
                      type="button"
                      key={source.id}
                      className={`source-card ${selectedSourceId === source.id ? 'is-selected' : ''}`}
                      onClick={() => { setSelectedSourceId(source.id); setSourceError(''); }}
                    >
                      <span className="source-thumb">
                        {source.thumbnail ? <img src={source.thumbnail} alt="" /> : <Icon name={source.type === 'screen' ? 'monitor' : 'globe'} size={23} />}
                      </span>
                      <span className="source-card-copy"><strong>{source.name}</strong><small>{source.type === 'screen' ? 'Layar' : 'Window aplikasi'}</small></span>
                      {selectedSourceId === source.id && <span className="source-card-check"><Icon name="check" size={15} /></span>}
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="source-picker-footer">
              <span><Icon name="lock" size={14} /> Sesi tetap terenkripsi</span>
              <div><button className="secondary-button" onClick={() => setSourcePickerOpen(false)}>Batal</button><button className="primary-button" disabled={!selectedSourceId || sourceLoading} onClick={() => void confirmSource()}>Lanjutkan <Icon name="arrow-right" size={16} /></button></div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
