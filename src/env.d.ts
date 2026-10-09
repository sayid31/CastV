/// <reference types="vite/client" />

export type CastDisplaySource = {
  id: string;
  name: string;
  type: 'screen' | 'window';
  thumbnail: string;
  appIcon: string;
};

export type CastTarget = {
  id: string;
  protocol: 'airplay' | 'cast';
  name: string;
  host: string;
  address: string;
  addresses: string[];
  port: number;
  model: string;
  features: string;
  video: boolean;
  pairingRequired: boolean;
  lastSeen: number;
};

declare global {
  /** Versi aplikasi, di-inject oleh Vite dari package.json saat build. */
  const __APP_VERSION__: string;

  interface Window {
    castv?: {
      getDisplaySources: () => Promise<CastDisplaySource[]>;
      selectDisplaySource: (sourceId: string) => Promise<boolean>;
      getCastTargets: () => Promise<CastTarget[]>;
      rescanCastTargets: () => Promise<boolean>;
      onCastTargets: (callback: (targets: CastTarget[]) => void) => () => void;
      setAirplayMeta: (meta: { width: number; height: number; frameRate: number; videoBitrate: number; codecs: string }) => Promise<unknown>;
      setAirplayInit: (data: ArrayBuffer | Uint8Array) => Promise<number>;
      setAirplaySegment: (data: ArrayBuffer | Uint8Array, info: { sequence: number; duration: number; initVersion: number }) => Promise<boolean>;
      playAirplay: (target: CastTarget) => Promise<{ ok: boolean; streamUrl: string; info: { name?: string; model?: string; sourceVersion?: string } }>;
      stopAirplay: () => Promise<boolean>;
      onAirplayError: (callback: (message: string) => void) => () => void;
      onAirplayWarning: (callback: (payload: { name: string; message: string }) => void) => () => void;
      onAirplayDisconnected: (callback: (payload: { name: string; message: string }) => void) => () => void;
      onAirplayStalled: (callback: (payload: { name: string; message: string }) => void) => () => void;
    };
  }
}

export {};
