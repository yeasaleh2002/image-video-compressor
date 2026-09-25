/**
 * @file Node video adapter backed by native ffmpeg via `fluent-ffmpeg`.
 *
 * Streaming model: the input is always a file inside the job's private
 * workspace (it was *streamed* there by the platform — from the network, from
 * the jailed file handle, or from the caller's buffer). ffmpeg reads it from
 * disk and writes to another workspace file.
 *
 * Why not `ffmpeg -i pipe:0`? Most real-world MP4/MOV files store the `moov`
 * index at the END of the file; a non-seekable pipe can't reach it, so piped
 * input fails on a large share of phone videos. Likewise `+faststart` output
 * (needed for progressive web playback) requires a seekable output. Disk-backed
 * temp files give constant memory use regardless of video size, which is the
 * real goal of "use streams".
 */
import ffmpeg, { type FfprobeData } from 'fluent-ffmpeg';
import os from 'node:os';
import { stat } from 'node:fs/promises';
import { inputArgs, outputArgs, planVideo } from '../adapters/ffmpegArgs.js';
import type { EncodeResult, JobContext, MediaSource, VideoAdapter } from '../adapters/types.js';
import { CorruptMediaError, OptimizerError, ProcessingError, ProcessingTimeoutError, UnsupportedMediaError } from '../errors.js';
import type { NormalizedOptions } from '../security/SecurityGuard.js';
import type { DetectedMedia } from '../types.js';

export interface FfmpegBinaries {
  ffmpegPath?: string;
  ffprobePath?: string;
}

export class FluentFfmpegVideoAdapter implements VideoAdapter {
  private readonly threads: number;

  /**
   * @param bins    Binary locations (defaults: `ffmpeg-static` / `ffprobe-static`, then `$PATH`).
   * @param maxJobs Parallel video jobs — used to split CPU cores between jobs.
   */
  constructor(private readonly bins: FfmpegBinaries, maxJobs: number) {
    this.threads = Math.max(1, Math.floor(os.availableParallelism() / maxJobs));
  }

  private command(input: string) {
    const cmd = ffmpeg(input);
    if (this.bins.ffmpegPath) cmd.setFfmpegPath(this.bins.ffmpegPath);
    if (this.bins.ffprobePath) cmd.setFfprobePath(this.bins.ffprobePath);
    return cmd;
  }

  /** Runs ffprobe with the same forced demuxer + protocol whitelist as the transcode. */
  private probe(file: string, demuxArgs: string[]): Promise<FfprobeData> {
    return new Promise((resolve, reject) => {
      // fluent-ffmpeg spawns `ffprobe -show_streams -show_format <options> <file>`,
      // so these act as input options (forced demuxer + protocol whitelist).
      this.command(file).ffprobe(0, demuxArgs, (err, data) => (err ? reject(err) : resolve(data)));
    });
  }

  async optimize(
    src: MediaSource, detected: DetectedMedia, opts: NormalizedOptions['video'], ctx: JobContext,
  ): Promise<EncodeResult> {
    if (src.type !== 'file') throw new Error('FluentFfmpegVideoAdapter expects a workspace file');
    const plan = planVideo(detected.format);

    // ---- 1. Probe & validate BEFORE decoding a single frame --------------------
    let probe: FfprobeData;
    try {
      probe = await this.probe(src.path, inputArgs(plan));
    } catch (err) {
      throw new CorruptMediaError('Video container could not be parsed', { cause: err });
    }
    const video = probe.streams.find((s) => s.codec_type === 'video');
    if (!video?.width || !video.height) throw new CorruptMediaError('No decodable video stream');
    if (probe.streams.length > 32) throw new UnsupportedMediaError('Too many streams');
    const probedName = probe.format.format_name ?? '';
    // The container ffprobe sees must agree with our magic-number verdict.
    if (!probedName.split(',').includes(plan.demuxer) && !(plan.demuxer === 'matroska' && probedName.includes('webm'))) {
      throw new UnsupportedMediaError('Container does not match its signature');
    }
    ctx.guard.assertDimensions(video.width, video.height);
    const duration = Number(probe.format.duration);
    ctx.guard.assertDuration(Number.isFinite(duration) ? duration : undefined);
    const hasAudio = probe.streams.some((s) => s.codec_type === 'audio');

    // ---- 2. Transcode -----------------------------------------------------------
    const outPath = ctx.workspace.tempPath(plan.ext);
    const cmd = this.command(src.path)
      .inputOptions(inputArgs(plan))
      .outputOptions(outputArgs(plan, opts, { width: video.width, height: video.height, hasAudio, threads: this.threads }))
      .output(outPath);

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cmd.kill('SIGKILL'); // the limiter's deadline fired: stop burning CPU now
        reject(new ProcessingTimeoutError());
      };
      if (ctx.signal.aborted) return onAbort();
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      cmd
        .on('end', () => { ctx.signal.removeEventListener('abort', onAbort); resolve(); })
        .on('error', (err: Error, _stdout?: string | null, stderr?: string | null) => {
          ctx.signal.removeEventListener('abort', onAbort);
          if (ctx.signal.aborted) return; // already rejected by onAbort
          const tail = (stderr ?? '').slice(-2000);
          if (/Invalid data found|moov atom not found|corrupt|EBML header parsing failed|error while decoding/i.test(tail)) {
            reject(new CorruptMediaError('Video stream is corrupt', { cause: err }));
          } else {
            reject(new ProcessingError('Video encoding failed', { cause: new Error(`${err.message}\n${tail}`) }));
          }
        })
        .run();
    });

    try {
      const { size } = await stat(outPath);
      return {
        output: { type: 'file', path: outPath, size },
        format: plan.outFormat,
        mime: plan.mime,
        width: video.width - (plan.outFormat !== 'webm' ? video.width % 2 : 0),
        height: video.height - (plan.outFormat !== 'webm' ? video.height % 2 : 0),
        durationSeconds: Number.isFinite(duration) ? duration : undefined,
        warnings: plan.warnings,
      };
    } catch (err) {
      if (err instanceof OptimizerError) throw err;
      throw new ProcessingError('Encoder produced no output', { cause: err });
    }
  }
}
