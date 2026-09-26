import { Fmp4Muxer, HlsSegmenter, type AirplayFragmentInfo, type AirplaySegment } from './hls';

export type AirplayStreamMeta = {
  width: number;
  height: number;
  frameRate: number;
  videoBitrate: number;
  codecs: string;
};

export type AirplayPipelineCallbacks = {
  onMeta: (meta: AirplayStreamMeta) => Promise<unknown> | unknown;
  onInit: (data: Uint8Array) => Promise<unknown> | unknown;
  onSegment: (segment: AirplaySegment) => Promise<unknown> | unknown;
  onError?: (error: Error) => void;
};

function toBytes(value: ArrayBuffer | ArrayBufferView | undefined): Uint8Array | null {
  if (!value) return null;
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  const view = value as ArrayBufferView;
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

export class AirplayVideoPipeline {
  private readonly callbacks: AirplayPipelineCallbacks;
  private stream: MediaStream | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private latestFrame: VideoFrame | null = null;
  private pacerTimer: number | null = null;
  private encoder: any = null;
  private muxer: Fmp4Muxer | null = null;
  private segmenter: HlsSegmenter | null = null;
  private canvas: OffscreenCanvas | null = null;
  private context: OffscreenCanvasRenderingContext2D | null = null;
  private running = false;
  private outputChain: Promise<void> = Promise.resolve();
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private startMs = 0;
  private lastKeyframeUs = -Infinity;
  private lastChunkTimestampUs = -Infinity;
  private frameIntervalUs = 33333;
  private initSent = false;
  private segmentCount = 0;
  private targetWidth = 1280;
  private targetHeight = 720;

  constructor(callbacks: AirplayPipelineCallbacks) {
    this.callbacks = callbacks;
  }

  get active(): boolean {
    return this.running;
  }

  async start(stream: MediaStream): Promise<void> {
    if (this.running) await this.stop();
    const videoTrack = stream.getVideoTracks()[0];
    const VideoEncoderCtor = (globalThis as any).VideoEncoder;
    const ProcessorCtor = (globalThis as any).MediaStreamTrackProcessor;
    if (!videoTrack) throw new Error('Tidak ada track video untuk AirPlay.');
    if (!VideoEncoderCtor || !ProcessorCtor) throw new Error('Chromium ini tidak mendukung WebCodecs untuk AirPlay.');

    const settings = videoTrack.getSettings();
    const sourceWidth = settings.width || 1280;
    const sourceHeight = settings.height || 720;
    const scale = Math.min(1, 1920 / sourceWidth, 1080 / sourceHeight);
    const width = even(sourceWidth * scale);
    const height = even(sourceHeight * scale);
    this.targetWidth = width;
    this.targetHeight = height;
    const frameRate = 30;
    const videoBitrate = 5_000_000;
    const candidates = ['avc1.640028', 'avc1.4D4028', 'avc1.42E01E'];
    let encoderConfig: any = null;
    for (const codec of candidates) {
      const candidate = {
        codec,
        width,
        height,
        bitrate: videoBitrate,
        framerate: frameRate,
        latencyMode: 'realtime',
        avc: { format: 'avc' },
      };
      try {
        if (await VideoEncoderCtor.isConfigSupported(candidate)) {
          encoderConfig = candidate;
          break;
        }
      } catch {
        // Try the next profile.
      }
    }
    if (!encoderConfig) throw new Error('H.264 encoder tidak tersedia.');

    this.stream = stream;
    this.running = true;
    this.latestFrame?.close();
    this.latestFrame = null;
    this.startMs = performance.now();
    this.lastKeyframeUs = -Infinity;
    this.lastChunkTimestampUs = -Infinity;
    this.frameIntervalUs = Math.round(1_000_000 / frameRate);
    this.initSent = false;
    this.segmentCount = 0;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    if (scale < 1) {
      this.canvas = new OffscreenCanvas(width, height);
      this.context = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    }

    await this.callbacks.onMeta({ width, height, frameRate, videoBitrate, codecs: encoderConfig.codec });
    this.encoder = new VideoEncoderCtor({
      output: (chunk: any, metadata: any) => this.handleEncodedChunk(chunk, metadata),
      error: (error: Error) => this.fail(error),
    });
    this.encoder.configure(encoderConfig);

    const processor = new ProcessorCtor({ track: videoTrack });
    this.reader = processor.readable.getReader();
    void this.readFrames();
    this.startPacer();
  }

  private async readFrames(): Promise<void> {
    try {
      while (this.running && this.reader) {
        const result = await this.reader.read();
        if (result.done) break;
        const frame = result.value;
        if (!this.running || !this.encoder) {
          frame.close();
          break;
        }
        this.latestFrame?.close();
        this.latestFrame = frame;
      }
    } catch (error) {
      if (this.running) this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private startPacer(): void {
    this.pacerTimer = window.setInterval(() => this.encodeLatestFrame(), 33);
  }

  private encodeLatestFrame(): void {
    if (!this.running || !this.encoder || !this.latestFrame || this.encoder.state !== 'configured') return;
    if (this.encoder.encodeQueueSize > 3) return;
    const timestampUs = Math.max(0, Math.round((performance.now() - this.startMs) * 1000));
    let frame: VideoFrame;
    try {
      frame = this.renderFrame(this.latestFrame, timestampUs);
    } catch {
      return;
    }
    const keyFrame = timestampUs - this.lastKeyframeUs >= 2_000_000;
    if (keyFrame) this.lastKeyframeUs = timestampUs;
    this.encoder.encode(frame, { keyFrame });
    frame.close();
  }

  private renderFrame(source: VideoFrame, timestampUs: number): VideoFrame {
    if (!this.canvas || !this.context) return new VideoFrame(source, { timestamp: timestampUs, duration: this.frameIntervalUs });
    this.context.drawImage(source, 0, 0, this.canvas.width, this.canvas.height);
    return new VideoFrame(this.canvas, { timestamp: timestampUs, duration: this.frameIntervalUs });
  }

  private handleEncodedChunk(chunk: any, metadata: any): void {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const keyframe = chunk.type === 'key';
    const nowUs = Math.round((performance.now() - this.startMs) * 1000);
    const timestampUs = Number(chunk.timestamp) || nowUs;
    const measuredDuration = this.lastChunkTimestampUs >= 0 ? nowUs - this.lastChunkTimestampUs : this.frameIntervalUs;
    this.lastChunkTimestampUs = nowUs;
    const durationUs = measuredDuration > 0 ? measuredDuration : (Number(chunk.duration) > 0 ? Number(chunk.duration) : this.frameIntervalUs);
    this.outputChain = this.outputChain.then(async () => {
      if (!this.running && !this.muxer) return;
      if (!this.muxer) {
        const description = toBytes(metadata?.decoderConfig?.description);
        if (!description) return;
        this.muxer = new Fmp4Muxer(
          this.targetWidth,
          this.targetHeight,
          description,
          (fragment, info) => this.enqueueFragment(fragment, info),
        );
        this.segmenter = new HlsSegmenter((segment) => this.enqueueSegment(segment));
        this.muxer.start();
        this.initSent = true;
      }
      this.muxer.addSample(data, timestampUs, keyframe, durationUs);
    }).catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))));
  }

  private enqueueFragment(data: Uint8Array, info: AirplayFragmentInfo): void {
    this.outputChain = this.outputChain.then(async () => {
      if (info.kind === 'init') {
        await this.callbacks.onInit(data);
        this.segmenter?.setInit(data);
        this.initSent = true;
      } else {
        this.segmenter?.push(data, info);
      }
    }).catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))));
  }

  private enqueueSegment(segment: AirplaySegment): void {
    this.outputChain = this.outputChain.then(async () => {
      await this.callbacks.onSegment(segment);
      this.segmentCount += 1;
      if (this.segmentCount >= 1) this.resolveReady?.();
    }).catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))));
  }

  private fail(error: Error): void {
    if (!this.running && !this.muxer) return;
    this.callbacks.onError?.(error);
    this.rejectReady?.(error);
  }

  async waitUntilReady(timeoutMs = 15000): Promise<void> {
    if (!this.readyPromise) throw new Error('AirPlay pipeline belum dimulai.');
    await Promise.race([
      this.readyPromise,
      new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('HLS AirPlay belum siap.')), timeoutMs)),
    ]);
  }

  async stop(): Promise<void> {
    if (!this.running && !this.encoder) return;
    this.running = false;
    if (this.pacerTimer !== null) window.clearInterval(this.pacerTimer);
    this.pacerTimer = null;
    try { await this.reader?.cancel(); } catch { /* already closed */ }
    this.reader = null;
    this.latestFrame?.close();
    this.latestFrame = null;
    try { this.encoder?.close(); } catch { /* already closed */ }
    this.encoder = null;
    await this.outputChain;
    this.muxer = null;
    this.segmenter = null;
    this.stream = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.readyPromise = null;
  }
}
