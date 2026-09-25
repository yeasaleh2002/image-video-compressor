import type { EncodeResult, Platform } from '../adapters/types.js';
import { OptimizerError, ProcessingError, toErrorResponse } from '../errors.js';
import { SecurityGuard } from '../security/SecurityGuard.js';
import type {
  ConcurrencyConfig, DetailedOptimizationResponse, MediaInput, OptimizationErrorResponse,
  OptimizationOptions, OutputFor, SecurityLimits,
} from '../types.js';
import { ConcurrencyLimiter } from './limiter.js';
import { compressionRatio } from './util.js';

export interface MediaOptimizerConfig {
  limits?: Partial<SecurityLimits>;
  concurrency?: Partial<ConcurrencyConfig>;
}

export class MediaOptimizer {
  readonly guard: SecurityGuard;
  private readonly imageLimiter: ConcurrencyLimiter;
  private readonly videoLimiter: ConcurrencyLimiter;

  constructor(
    private readonly platform: Platform,
    config: MediaOptimizerConfig & { concurrency: ConcurrencyConfig },
  ) {
    this.guard = new SecurityGuard(config.limits);
    const c = config.concurrency;
    this.imageLimiter = new ConcurrencyLimiter(c.maxImageJobs, c.maxQueue);
    this.videoLimiter = new ConcurrencyLimiter(c.maxVideoJobs, c.maxQueue);
  }

  get stats() {
    return { image: this.imageLimiter.stats, video: this.videoLimiter.stats };
  }

  async optimize<I extends MediaInput>(
    input: I,
    options: OptimizationOptions = { mediaType: 'auto' },
  ): Promise<DetailedOptimizationResponse<OutputFor<I>>> {
    const opts = this.guard.normalizeOptions(options);
    const ws = await this.platform.createWorkspace();

    const ingestAbort = new AbortController();
    const ingestTimer = setTimeout(
      () => ingestAbort.abort(new ProcessingError('Input ingestion timed out')),
      this.guard.limits.fetchTimeoutMs * (this.guard.limits.fetchRetries + 1) + 30_000,
    );

    try {
      const ingested = await this.platform.ingest(input, ws, opts.mediaType, ingestAbort.signal);
      clearTimeout(ingestTimer);
      const { detected, source, size } = ingested;
      this.guard.assertDetected(detected, opts.mediaType, size);

      let result: EncodeResult;
      if (detected.kind === 'image') {
        result = await this.imageLimiter.run(
          (signal) => this.platform.image.optimize(source, detected, opts.image, { signal, guard: this.guard, workspace: ws }),
          this.guard.limits.imageTimeoutMs,
        );
      } else {
        result = await this.videoLimiter.run(
          (signal) => this.platform.video.optimize(source, detected, opts.video, { signal, guard: this.guard, workspace: ws }),
          this.guard.limits.videoTimeoutMs,
        );
      }

      const data = (await this.platform.emit(input, result, ws)) as OutputFor<I>;
      const optimizedSize = result.output.type === 'bytes' ? result.output.bytes.byteLength : result.output.size;
      const ratio = compressionRatio(size, optimizedSize);
      const grew = optimizedSize >= size;

      return {
        success: true,
        originalSize: size,
        optimizedSize,
        compressionRatio: ratio,
        format: result.format,
        data,
        message: grew
          ? `Sanitized ${detected.kind}; output is not smaller than the input (${ratio}). Try a lower quality / higher CRF.`
          : `Optimized ${detected.kind} ${detected.format} → ${result.format}, saved ${ratio}`,
        details: {
          mediaType: detected.kind,
          inputFormat: detected.format,
          mimeType: result.mime,
          width: result.width,
          height: result.height,
          durationSeconds: result.durationSeconds,
          warnings: result.warnings,
        },
      };
    } catch (err) {
      if (err instanceof OptimizerError) throw err;

      throw new ProcessingError(undefined, { cause: err });
    } finally {
      clearTimeout(ingestTimer);
      await ws.dispose();
    }
  }

  async optimizeSafe<I extends MediaInput>(
    input: I,
    options?: OptimizationOptions,
  ): Promise<DetailedOptimizationResponse<OutputFor<I>> | OptimizationErrorResponse> {
    try {
      return await this.optimize(input, options);
    } catch (err) {
      return toErrorResponse(err);
    }
  }
}
