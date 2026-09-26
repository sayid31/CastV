export type AirplayFragmentInfo = {
  kind: 'init' | 'video';
  keyframe: boolean;
  timestampUs: number;
  durationUs: number;
  sequence: number;
};

export type AirplaySegment = {
  sequence: number;
  durationSec: number;
  data: Uint8Array;
  initVersion: number;
};

const textEncoder = new TextEncoder();
const VIDEO_TIMESCALE = 90000;

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function ascii(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function u8(value: number): Uint8Array {
  return new Uint8Array([value & 0xff]);
}

function u16(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function u24(value: number): Uint8Array {
  return new Uint8Array([(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function u64(value: number): Uint8Array {
  const high = Math.floor(value / 0x100000000);
  const low = value >>> 0;
  return concat([u32(high), u32(low)]);
}

function zeros(length: number): Uint8Array {
  return new Uint8Array(length);
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32(body.length + 8), ascii(type), body]);
}

function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, u8(version), u24(flags), ...payload);
}

const UNITY_MATRIX = concat([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
]);

function buildInitSegment(width: number, height: number, description: Uint8Array): Uint8Array {
  const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'), ascii('iso5'), ascii('iso6'));
  const mvhd = fullBox(
    'mvhd', 0, 0,
    u32(0), u32(0), u32(1000), u32(0),
    u32(0x00010000), u16(0x0100), zeros(10), UNITY_MATRIX, zeros(24), u32(2),
  );
  const tkhd = fullBox(
    'tkhd', 0, 3,
    u32(0), u32(0), u32(1), u32(0), u32(0), zeros(8),
    u16(0), u16(0), u16(0), u16(0), UNITY_MATRIX,
    u32(width << 16), u32(height << 16),
  );
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(VIDEO_TIMESCALE), u32(0), u16(0x55c4), u16(0));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii('vide'), zeros(12), ascii('VideoHandler'), u8(0));
  const vmhd = fullBox('vmhd', 0, 1, u16(0), zeros(6));
  const dref = fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1));
  const dinf = box('dinf', dref);
  const avc1 = box(
    'avc1',
    zeros(6), u16(1), u16(0), u16(0), zeros(12), u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x0018), u16(0xffff),
    box('avcC', description),
  );
  const stbl = box(
    'stbl',
    fullBox('stsd', 0, 0, u32(1), avc1),
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)),
  );
  const minf = box('minf', vmhd, dinf, stbl);
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
  const trex = fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0));
  const moov = box('moov', mvhd, trak, box('mvex', trex));
  return concat([ftyp, moov]);
}

function buildFragment(sequence: number, baseDecodeTime: number, duration: number, data: Uint8Array, keyframe: boolean): Uint8Array {
  const placeholderTrun = fullBox(
    'trun', 0, 0x701,
    u32(1), u32(0), u32(duration), u32(data.length), u32(keyframe ? 0x02000000 : 0x01010000),
  );
  const placeholderTraf = box(
    'traf',
    fullBox('tfhd', 0, 0x020000, u32(1)),
    fullBox('tfdt', 1, 0, u64(baseDecodeTime)),
    placeholderTrun,
  );
  const placeholderMoof = box('moof', fullBox('mfhd', 0, 0, u32(sequence)), placeholderTraf);
  const dataOffset = placeholderMoof.length + 8;
  const trunWithOffset = fullBox(
    'trun', 0, 0x701,
    u32(1), u32(dataOffset), u32(duration), u32(data.length), u32(keyframe ? 0x02000000 : 0x01010000),
  );
  const trafWithOffset = box(
    'traf',
    fullBox('tfhd', 0, 0x020000, u32(1)),
    fullBox('tfdt', 1, 0, u64(baseDecodeTime)),
    trunWithOffset,
  );
  const finalMoof = box('moof', fullBox('mfhd', 0, 0, u32(sequence)), trafWithOffset);
  return concat([finalMoof, box('mdat', data)]);
}

export class Fmp4Muxer {
  private started = false;
  private sequence = 1;
  private decodeTime = 0;
  private originUs: number | null = null;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly description: Uint8Array,
    private readonly onData: (data: Uint8Array, info: AirplayFragmentInfo) => void,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.onData(buildInitSegment(this.width, this.height, this.description), {
      kind: 'init', keyframe: true, timestampUs: 0, durationUs: 0, sequence: 0,
    });
  }

  addSample(data: Uint8Array, timestampUs: number, keyframe: boolean, durationUs = 33333): void {
    if (!this.started) this.start();
    if (this.originUs === null) this.originUs = timestampUs;
    const relativeUs = Math.max(0, timestampUs - this.originUs);
    const duration = Math.max(1, Math.round((durationUs / 1_000_000) * VIDEO_TIMESCALE));
    this.onData(buildFragment(this.sequence++, this.decodeTime, duration, data, keyframe), {
      kind: 'video', keyframe, timestampUs: relativeUs, durationUs, sequence: this.sequence - 1,
    });
    this.decodeTime += duration;
  }
}

export class HlsSegmenter {
  private init: Uint8Array | null = null;
  private readonly inits = new Map<number, Uint8Array>();
  private initVersion = 0;
  private pending: Uint8Array[] = [];
  private pendingDurationUs = 0;
  private readonly segments = new Map<number, AirplaySegment>();
  private nextSequence = 0;

  constructor(private readonly onSegment: (segment: AirplaySegment) => void) {}

  setInit(data: Uint8Array): number {
    this.flush();
    this.initVersion += 1;
    this.init = data;
    this.inits.set(this.initVersion, data);
    this.segments.clear();
    return this.initVersion;
  }

  push(data: Uint8Array, info: AirplayFragmentInfo): void {
    if (!this.init) throw new Error('HLS segmenter needs an init segment first.');
    if (info.kind !== 'video') return;
    if (this.pending.length > 0 && info.keyframe && this.pendingDurationUs >= 950_000) this.flush();
    this.pending.push(data);
    this.pendingDurationUs += info.durationUs;
  }

  flush(): void {
    if (!this.init || this.pending.length === 0) return;
    const segment: AirplaySegment = {
      sequence: this.nextSequence++,
      durationSec: Math.max(0.1, this.pendingDurationUs / 1_000_000),
      data: concat(this.pending),
      initVersion: this.initVersion,
    };
    this.pending = [];
    this.pendingDurationUs = 0;
    this.segments.set(segment.sequence, segment);
    const keys = [...this.segments.keys()].sort((a, b) => a - b);
    while (keys.length > 8) this.segments.delete(keys.shift()!);
    this.onSegment(segment);
  }

  get ready(): boolean {
    return Boolean(this.init && this.segments.size >= 1);
  }

  playlist(): string {
    if (!this.init || this.segments.size === 0) return '';
    const items = [...this.segments.values()].sort((a, b) => a.sequence - b.sequence);
    const target = Math.max(1, Math.ceil(Math.max(...items.map((item) => item.durationSec))));
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-TARGETDURATION:${target}`,
      `#EXT-X-MEDIA-SEQUENCE:${items[0].sequence}`,
      '#EXT-X-INDEPENDENT-SEGMENTS',
    ];
    let currentInit = -1;
    for (const item of items) {
      if (item.initVersion !== currentInit) {
        lines.push(`#EXT-X-MAP:URI="init-${item.initVersion}.mp4"`);
        currentInit = item.initVersion;
      }
      lines.push(`#EXTINF:${item.durationSec.toFixed(3)},`, `seg-${item.sequence}.m4s`);
    }
    return `${lines.join('\n')}\n`;
  }
}
