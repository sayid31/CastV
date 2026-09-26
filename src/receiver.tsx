import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createPeerConnection,
  getSignalingUrl,
  normalizeRoom,
  sendCastMessage,
  type CastMessage,
} from './lib/cast';
import { Icon } from './components/Icon';
import './styles.css';
import './receiver-theme.css';

type ReceiverStatus = 'connecting' | 'waiting' | 'negotiating' | 'connected' | 'error' | 'ended';

const statusText: Record<ReceiverStatus, string> = {
  connecting: 'Menghubungkan…',
  waiting: 'Menunggu sender…',
  negotiating: 'Menyiapkan stream…',
  connected: 'Layar sedang diterima',
  error: 'Koneksi terputus',
  ended: 'Sesi berakhir',
};

function getReceiverName(): string {
  const requestedName = new URLSearchParams(window.location.search).get('name');
  if (requestedName) return requestedName.slice(0, 80);
  const userAgent = navigator.userAgent;
  if (/Android/i.test(userAgent)) return 'Android browser';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'iPhone / iPad browser';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'Mac browser';
  if (/Windows/i.test(userAgent)) return 'Windows browser';
  return 'Browser receiver';
}

function ReceiverApp() {
  const [room, setRoom] = useState(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    return normalizeRoom(hash.get('room') || new URLSearchParams(window.location.search).get('room'));
  });
  const [token, setToken] = useState(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    return hash.get('token') || new URLSearchParams(window.location.search).get('token') || '';
  });
  const [status, setStatus] = useState<ReceiverStatus>('connecting');
  const [error, setError] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [hasStream, setHasStream] = useState(false);
  const [startedViewing, setStartedViewing] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const discoveryMode = !room || !token;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  const clearRemoteStream = () => {
    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setHasStream(false);
  };

  const closePeer = () => {
    peerRef.current?.close();
    peerRef.current = null;
    pendingCandidatesRef.current = [];
  };

  const send = (message: CastMessage) => {
    if (socketRef.current) sendCastMessage(socketRef.current, message);
  };

  const attachStream = (stream: MediaStream) => {
    remoteStreamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.muted = !soundEnabled;
      void videoRef.current.play().catch(() => undefined);
    }
    setHasStream(true);
    setStatus('connected');
  };

  const createPeer = () => {
    if (peerRef.current) return peerRef.current;
    const peer = createPeerConnection();
    peerRef.current = peer;
    peer.onicecandidate = (event) => {
      if (event.candidate) send({ type: 'ice', candidate: event.candidate.toJSON() });
    };
    peer.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      attachStream(stream);
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') setStatus('connected');
      if (peer.connectionState === 'failed') {
        setError('Tidak dapat membuat jalur video. Pastikan Wi-Fi tidak mengisolasi perangkat.');
        setStatus('error');
      }
      if (peer.connectionState === 'disconnected') setStatus('negotiating');
    };
    return peer;
  };

  const handleMessage = async (event: MessageEvent<string>) => {
    let message: CastMessage;
    try {
      message = JSON.parse(event.data) as CastMessage;
    } catch {
      return;
    }

    if (message.type === 'assigned' && message.room && message.token) {
      const assignedRoom = normalizeRoom(message.room);
      setRoom(assignedRoom);
      setToken(message.token);
      setError('');
      setStatus('connecting');
      send({ type: 'join', room: assignedRoom, role: 'receiver', token: message.token });
    }
    if (message.type === 'joined') {
      setStatus('waiting');
      setError('');
    }
    if (message.type === 'peer-ready' && message.role === 'sender') {
      setStatus('waiting');
    }
    if (message.type === 'offer' && message.sdp) {
      setStatus('negotiating');
      try {
        const peer = createPeer();
        await peer.setRemoteDescription(message.sdp);
        for (const candidate of pendingCandidatesRef.current.splice(0)) await peer.addIceCandidate(candidate);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        if (peer.localDescription) send({ type: 'answer', sdp: peer.localDescription });
      } catch {
        setError('Browser tidak dapat membuat jawaban streaming.');
        setStatus('error');
      }
    }
    if (message.type === 'ice' && message.candidate) {
      if (peerRef.current?.remoteDescription) {
        void peerRef.current.addIceCandidate(message.candidate);
      } else {
        pendingCandidatesRef.current.push(message.candidate);
      }
    }
    if (message.type === 'peer-left' && message.role === 'sender') {
      clearRemoteStream();
      setStatus('waiting');
    }
    if (message.type === 'stopped' || message.type === 'room-closed') {
      closePeer();
      clearRemoteStream();
      setStatus('ended');
    }
    if (message.type === 'error') {
      setError(message.message || 'Sesi tidak dapat dibuka.');
      setStatus('error');
    }
  };

  useEffect(() => {
    const initialRoom = room;
    const initialToken = token;
    let disposed = false;
    const socket = new WebSocket(getSignalingUrl());
    socketRef.current = socket;
    socket.onopen = () => {
      if (initialRoom && initialToken) {
        sendCastMessage(socket, { type: 'join', room: initialRoom, role: 'receiver', token: initialToken });
      } else {
        sendCastMessage(socket, { type: 'discover', name: getReceiverName() });
      }
    };
    socket.onmessage = (event) => { void handleMessage(event); };
    socket.onerror = () => {
      if (!disposed) {
        setError('Tidak dapat menghubungi sender. Pastikan CastV masih terbuka.');
        setStatus('error');
      }
    };
    socket.onclose = () => {
      if (!disposed) setStatus('ended');
    };

    return () => {
      disposed = true;
      socket.close();
      closePeer();
      clearRemoteStream();
    };
    // A receiver page represents one short-lived connection. When it is in
    // nearby mode, an `assigned` message keeps the same socket and joins the room.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startViewing = async () => {
    if (!videoRef.current) return;
    videoRef.current.muted = false;
    setSoundEnabled(true);
    try {
      await videoRef.current.play();
      setStartedViewing(true);
    } catch {
      setError('Ketuk sekali lagi untuk memulai playback.');
    }
  };

  const toggleFullscreen = async () => {
    if (!videoRef.current) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await videoRef.current.parentElement?.requestFullscreen();
  };

  const statusLabel = useMemo(() => discoveryMode && status === 'connecting' ? 'Mencari sender…' : statusText[status], [discoveryMode, status]);

  return (
    <div className="receiver-shell">
      <header className="receiver-header">
        <a className="receiver-brand" href="/" aria-label="Kembali ke CastV"><span className="brand-mark"><span /><span /><span /></span><span>cast<span className="brand-accent">V</span></span></a>
        <div className="receiver-header-right"><span className="receiver-secure"><Icon name="lock" size={13} /> Local session</span><a href="/">Buka CastV <Icon name="external" size={14} /></a></div>
      </header>

      <main className="receiver-main">
        <div className="receiver-topline"><div><span className="receiver-overline">WEB RECEIVER</span><h1>Layar besar, tanpa kabel.</h1></div><div className={`receiver-status status-${status}`} aria-live="polite"><i />{statusLabel}</div></div>
        <div className="receiver-stage">
          <video ref={videoRef} autoPlay playsInline muted={!soundEnabled} />
          {!hasStream && status !== 'error' && status !== 'ended' && (
            <div className="receiver-waiting">
              <div className="waiting-orb"><span /><span /><span /></div>
              <strong>{discoveryMode ? (status === 'connecting' ? 'Mencari sender di Wi-Fi…' : 'Menunggu sender nearby') : status === 'waiting' ? 'Menunggu layar dari PC' : status === 'connecting' ? 'Menyiapkan receiver…' : 'Membuka sesi…'}</strong>
              <span>{discoveryMode ? 'Nearby mode · tanpa QR' : <>Kode sesi <b>{room || '—'}</b></>}</span>
              <small>{discoveryMode ? 'Pastikan PC sender dan perangkat ini berada di Wi-Fi yang sama.' : 'Pastikan PC sender dan perangkat ini berada di Wi-Fi yang sama.'}</small>
            </div>
          )}
          {(status === 'error' || status === 'ended') && (
            <div className="receiver-error-state"><div className="error-orb"><Icon name="wifi" size={27} /></div><strong>{status === 'ended' ? 'Sesi sudah selesai' : 'Belum bisa terhubung'}</strong><p>{error || 'Pastikan CastV masih berjalan di komputer.'}</p><a className="light-button" href="/">Kembali ke CastV <Icon name="arrow-right" size={15} /></a></div>
          )}
          {hasStream && !startedViewing && <button className="start-viewing-button" onClick={() => void startViewing()}><span><Icon name="play" size={18} /></span>Ketuk untuk mulai menonton</button>}
          {hasStream && <div className="receiver-live-badge"><i /> LIVE <span>·</span> {room}</div>}
          {hasStream && <div className="receiver-controls"><button onClick={() => void startViewing()} aria-label="Aktifkan suara" className={soundEnabled ? 'is-active' : ''}><Icon name="volume" size={18} /></button><button onClick={() => void toggleFullscreen()} aria-label="Layar penuh"><Icon name="external" size={18} /></button></div>}
        </div>
        <div className="receiver-bottomline"><div className="receiver-meta"><span><i className="green-dot" /> Stream langsung</span><span><Icon name="lock" size={13} /> Terenkripsi WebRTC</span></div><button className="details-toggle" onClick={() => setShowDetails((value) => !value)}>{showDetails ? 'Sembunyikan' : 'Detail sesi'} <Icon name="arrow-right" size={14} /></button></div>
        {showDetails && <div className="receiver-details"><div><span>Kode sesi</span><code>{room || 'Nearby mode'}</code></div><div><span>Mode</span><code>{discoveryMode ? 'Wi-Fi discovery' : 'WebRTC / LAN'}</code></div><p>CastV hanya meneruskan sinyal. Video mengalir langsung antar perangkat.</p></div>}
      </main>
      <footer className="receiver-footer"><span>Powered by <strong>CastV</strong></span><span>Tidak ada video yang disimpan</span></footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><ReceiverApp /></StrictMode>);
