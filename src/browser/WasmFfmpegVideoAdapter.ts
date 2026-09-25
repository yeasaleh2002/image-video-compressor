/**
 * @file Browser video adapter backed by ffmpeg.wasm (`@ffmpeg/ffmpeg` 0.12).
 *
 * - Lazily loads one FFmpeg worker and reuses it. The single-threaded core
 *   can only run one `exec` at a time, so the browser optimizer defaults to
 *   `maxVideoJobs: 1`.
 * - Uses the exact same hardened argv as the native adapter (`ffmpegArgs.ts`).
 * - On timeout the worker is `terminate()`d (the only way to stop a running
 *   WASM exec) and a fresh one is loaded on the next job.
 * - Every file written to the in-memory FS gets a UUID name and is deleted in
 *   `finally`, so the WASM heap doesn't grow across jobs.
 *
 * Self-hosting: pass `coreURL` / `wasmURL` pointing at your own copies of
 * `@ffmpeg/core` to keep the app fully self-contained (no CDN at runtime).
 */
import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { inputArgs, outputArgs, planVideo } from '../adapters/ffmpegArgs.js';
import type { EncodeResult, JobContext, MediaSource, VideoAdapter } from '../adapters/types.js';
import { uuid } from '../core/util.js';
import { CorruptMediaError, ProcessingError, ProcessingTimeoutError, UnsupportedMediaError } from '../errors.js';
import type { NormalizedOptions } from '../security/SecurityGuard.js';
import type { DetectedMedia } from '../types.js';

export interface WasmFfmpegConfig {
  coreURL?: string;
  wasmURL?: string;
  workerURL?: string;
}

interface ProbeInfo { width: number; height: number; duration?: number; hasAudio: boolean; container: string }

/** Parses ffmpeg's `-i` banner. ffmpeg.wasm has no ffprobe in all builds, so we read the log. */
export function parseProbeLog(lines: string[]): ProbeInfo | null {
  const text = lines.join('\n');
  const container = /Input #0, ([^ ]+), from/.exec(text)?.[1] ?? '';
  const video = /Stream #0:\d+[^\n]*?: Video: [^\n]*?(\d{2,5})x(\d{2,5})/.exec(text);
  if (!video) return null;
  const d = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
  return {
    width: Number(video[1]),
    height: Number(video[2]),
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : undefined,
    hasAudio: /Stream #0:\d+[^\n]*?: Audio:/.test(text),
    container,
  };
}

export class WasmFfmpegVideoAdapter implements VideoAdapter {
  private instance: Promise<FFmpeg> | undefined;

  constructor(private readonly cfg: WasmFfmpegConfig = {}) {}

  private load(): Promise<FFmpeg> {
    this.instance ??= (async () => {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const ff = new FFmpeg();
      const cfg: Record<string, string> = {};
      if (this.cfg.coreURL) cfg.coreURL = this.cfg.coreURL;
      if (this.cfg.wasmURL) cfg.wasmURL = this.cfg.wasmURL;
      if (this.cfg.workerURL) cfg.workerURL = this.cfg.workerURL;
      await ff.load(cfg);
      return ff;
    })().catch((err) => {
      this.instance = undefined;
      throw new ProcessingError('Could not load ffmpeg.wasm', { cause: err });
    });
    return this.instance;
  }

  async optimize(
    src: MediaSource, detected: DetectedMedia, opts: NormalizedOptions['video'], ctx: JobContext,
  ): Promise<EncodeResult> {
    if (src.type !== 'bytes') throw new Error('WasmFfmpegVideoAdapter expects bytes');
    const plan = planVideo(detected.format);
    const ff = await this.load();
    const inName = `${uuid()}.${detected.format}`;
    const outName = `${uuid()}.${plan.ext}`;
    const logs: string[] = [];
    const onLog = ({ message }: { message: string }) => { if (logs.length < 2000) logs.push(message); };
    const onAbort = () => { ff.terminate(); this.instance = undefined; };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    ff.on('log', onLog);

    try {
      await ff.writeFile(inName, src.bytes);

      // ---- 1. Probe (exit code is non-zero because no output is given; that's expected)
      await ff.exec(['-hide_banner', ...inputArgs(plan), '-i', inName]);
      const info = parseProbeLog(logs);
      if (!info) throw new CorruptMediaError('No decodable video stream');
      if (!info.container.split(',').includes(plan.demuxer) && !(plan.demuxer === 'matroska' && info.container.includes('webm'))) {
        throw new UnsupportedMediaError('Container does not match its signature');
      }
      ctx.guard.assertDimensions(info.width, info.height);
      ctx.guard.assertDuration(info.duration);

      // ---- 2. Transcode
      logs.length = 0;
      const code = await ff.exec([
        '-hide_banner', ...inputArgs(plan), '-i', inName,
        ...outputArgs(plan, opts, { width: info.width, height: info.height, hasAudio: info.hasAudio, threads: 1 }),
        outName,
      ]);
      if (ctx.signal.aborted) throw new ProcessingTimeoutError();
      if (code !== 0) {
        const tail = logs.slice(-40).join('\n');
        if (/Invalid data found|moov atom not found|corrupt|error while decoding/i.test(tail)) throw new CorruptMediaError('Video stream is corrupt');
        throw new ProcessingError('Video encoding failed', { cause: new Error(tail) });
      }
      const data = await ff.readFile(outName);
      if (typeof data === 'string') throw new ProcessingError('Unexpected encoder output');

      return {
        output: { type: 'bytes', bytes: data },
        format: plan.outFormat,
        mime: plan.mime,
        width: info.width - (plan.outFormat !== 'webm' ? info.width % 2 : 0),
        height: info.height - (plan.outFormat !== 'webm' ? info.height % 2 : 0),
        durationSeconds: info.duration,
        warnings: plan.warnings,
      };
    } catch (err) {
      if (ctx.signal.aborted) throw new ProcessingTimeoutError();
      throw err;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      if (!ctx.signal.aborted) {
        ff.off('log', onLog);
        await ff.deleteFile(inName).catch(() => {});
        await ff.deleteFile(outName).catch(() => {});
      }
    }
  }
}
