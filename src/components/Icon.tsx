import type { SVGProps } from 'react';

type IconName =
  | 'arrow-right'
  | 'check'
  | 'copy'
  | 'download'
  | 'external'
  | 'eye'
  | 'globe'
  | 'info'
  | 'lock'
  | 'monitor'
  | 'monitor-up'
  | 'phone'
  | 'play'
  | 'plus'
  | 'qr'
  | 'refresh'
  | 'send'
  | 'spark'
  | 'stop'
  | 'volume'
  | 'wifi'
  | 'x';

type Props = SVGProps<SVGSVGElement> & { name: IconName; size?: number };

export function Icon({ name, size = 20, ...props }: Props) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...props,
  };

  switch (name) {
    case 'arrow-right':
      return <svg {...common}><path d="M5 12h13M13 6l6 6-6 6" /></svg>;
    case 'check':
      return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
    case 'copy':
      return <svg {...common}><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>;
    case 'download':
      return <svg {...common}><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" /></svg>;
    case 'external':
      return <svg {...common}><path d="M14 5h5v5M19 5l-8 8" /><path d="M18 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></svg>;
    case 'eye':
      return <svg {...common}><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>;
    case 'globe':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.2 2.4 3.3 5.4 3.3 9s-1.1 6.6-3.3 9c-2.2-2.4-3.3-5.4-3.3-9S9.8 5.4 12 3Z" /></svg>;
    case 'info':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5h.01" /></svg>;
    case 'lock':
      return <svg {...common}><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
    case 'monitor':
      return <svg {...common}><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></svg>;
    case 'monitor-up':
      return <svg {...common}><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4M12 15V8m0 0-2.5 2.5M12 8l2.5 2.5" /></svg>;
    case 'phone':
      return <svg {...common}><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M10 5h4M11 18.5h2" /></svg>;
    case 'play':
      return <svg {...common} fill="currentColor" stroke="none"><path d="m8 5 11 7-11 7V5Z" /></svg>;
    case 'plus':
      return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
    case 'qr':
      return <svg {...common}><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v4h-2zM16 18h4v2h-4zM18 20h2v1h-2z" /></svg>;
    case 'refresh':
      return <svg {...common}><path d="M20 11a8 8 0 0 0-14.8-4L3 9m0 0V4m0 5h5M4 13a8 8 0 0 0 14.8 4L21 15m0 0v5m0-5h-5" /></svg>;
    case 'send':
      return <svg {...common}><path d="m21 3-7.2 18-3.9-7L3 10.1 21 3Z" /><path d="M10 14 21 3" /></svg>;
    case 'spark':
      return <svg {...common}><path d="m12 2 1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6L12 2ZM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" /></svg>;
    case 'stop':
      return <svg {...common} fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>;
    case 'volume':
      return <svg {...common}><path d="M4 10v4h4l5 4V6l-5 4H4Z" /><path d="M17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11" /></svg>;
    case 'wifi':
      return <svg {...common}><path d="M3 8.5a14 14 0 0 1 18 0M6.5 12a8.5 8.5 0 0 1 11 0M10 15.5a3.5 3.5 0 0 1 4 0M12 19h.01" /></svg>;
    case 'x':
      return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>;
    default:
      return null;
  }
}
