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

  constructor(private readonly bins: FfmpegBinaries, maxJobs: number) {
    this.threads = Math.max(1, Math.floor(os.availableParallelism() / maxJobs));
  }

  private command(input: string) {
    const cmd = ffmpeg(input);
    if (this.bins.ffmpegPath) cmd.setFfmpegPath(this.bins.ffmpegPath);
    if (this.bins.ffprobePath) cmd.setFfprobePath(this.bins.ffprobePath);
    return cmd;
  }

  private probe(file: string, demuxArgs: string[]): Promise<FfprobeData> {
    return new Promise((resolve, reject) => {
      this.command(file).ffprobe(0, demuxArgs, (err, data) => (err ? reject(err) : resolve(data)));
    });
  }

  async optimize(
    src: MediaSource, detected: DetectedMedia, opts: NormalizedOptions['video'], ctx: JobContext,
  ): Promise<EncodeResult> {
    if (src.type !== 'file') throw new Error('FluentFfmpegVideoAdapter expects a workspace file');
    const plan = planVideo(detected.format);

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

    if (!probedName.split(',').includes(plan.demuxer) && !(plan.demuxer === 'matroska' && probedName.includes('webm'))) {
      throw new UnsupportedMediaError('Container does not match its signature');
    }
    ctx.guard.assertDimensions(video.width, video.height);
    const duration = Number(probe.format.duration);
    ctx.guard.assertDuration(Number.isFinite(duration) ? duration : undefined);
    const hasAudio = probe.streams.some((s) => s.codec_type === 'audio');

    const outPath = ctx.workspace.tempPath(plan.ext);
    const cmd = this.command(src.path)
      .inputOptions(inputArgs(plan))
      .outputOptions(outputArgs(plan, opts, { width: video.width, height: video.height, hasAudio, threads: this.threads }))
      .output(outPath);

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cmd.kill('SIGKILL');
        reject(new ProcessingTimeoutError());
      };
      if (ctx.signal.aborted) return onAbort();
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      cmd
        .on('end', () => { ctx.signal.removeEventListener('abort', onAbort); resolve(); })
        .on('error', (err: Error, _stdout?: string | null, stderr?: string | null) => {
          ctx.signal.removeEventListener('abort', onAbort);
          if (ctx.signal.aborted) return;
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
