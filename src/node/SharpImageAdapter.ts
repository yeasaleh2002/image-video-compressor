import sharp, { type Sharp } from 'sharp';
import type { EncodeResult, ImageAdapter, JobContext, MediaSource } from '../adapters/types.js';
import { planImage, type EncodeFormat } from '../adapters/imagePlan.js';
import { CorruptMediaError, DimensionLimitError, OptimizerError, ProcessingTimeoutError } from '../errors.js';
import { mimeOf } from '../security/magic.js';
import type { NormalizedOptions } from '../security/SecurityGuard.js';
import type { DetectedMedia } from '../types.js';

const ALL: ReadonlySet<EncodeFormat> = new Set(['webp', 'avif', 'jpeg', 'png']);

const ANIMATABLE: ReadonlySet<EncodeFormat> = new Set(['webp']);

function encoder(pipeline: Sharp, f: EncodeFormat, o: NormalizedOptions['image']): Sharp {
  switch (f) {
    case 'webp': return pipeline.webp({ quality: o.quality, lossless: o.lossless, effort: 5, smartSubsample: true });
    case 'avif': return pipeline.avif({ quality: o.quality, lossless: o.lossless, effort: 4 });
    case 'jpeg': return pipeline.jpeg({ quality: o.quality, mozjpeg: true, progressive: true });
    case 'png':

      return pipeline.png({ compressionLevel: 9, adaptiveFiltering: true, palette: !o.lossless, quality: o.quality, effort: 8 });
  }
}

const CORRUPT_HINTS = /(corrupt|truncat|premature|invalid|bad |unexpected end|not a known|unsupported image|vipsjpeg|pngload|webpload|gifload|heifload|tiff)/i;

export class SharpImageAdapter implements ImageAdapter {
  async optimize(
    src: MediaSource, detected: DetectedMedia, opts: NormalizedOptions['image'], ctx: JobContext,
  ): Promise<EncodeResult> {
    if (src.type !== 'bytes') throw new Error('SharpImageAdapter expects an in-memory image');
    const input = src.bytes;

    try {
      const meta = await sharp(input, { limitInputPixels: false, animated: true }).metadata();
      const width = meta.width ?? 0;
      const frameHeight = meta.pageHeight ?? meta.height ?? 0;
      const frames = meta.pages ?? 1;
      if (!width || !frameHeight) throw new CorruptMediaError('Image has no dimensions');
      ctx.guard.assertDimensions(width, frameHeight, frames);

      if (width * frameHeight * frames > ctx.guard.limits.maxPixels) {
        throw new DimensionLimitError('Total animation pixel count exceeds the limit');
      }

      const plan = planImage({
        detected, hasAlpha: meta.hasAlpha === true, animated: frames > 1, opts,
        available: ALL, animatable: ANIMATABLE,
      });
      const animated = frames > 1 && !plan.flatten;

      let best: { data: Buffer; info: sharp.OutputInfo; format: EncodeFormat } | undefined;
      for (const f of plan.candidates) {
        if (ctx.signal.aborted) throw new ProcessingTimeoutError();
        const pipeline = sharp(input, {
          limitInputPixels: width * frameHeight * (animated ? frames : 1),
          failOn: 'error',
          sequentialRead: true,
          animated,
        }).rotate();
        const { data, info } = await encoder(pipeline, f, opts).toBuffer({ resolveWithObject: true });
        if (!best || data.length < best.data.length) best = { data, info, format: f };
      }
      if (!best) throw new CorruptMediaError('No encodable output');

      return {
        output: { type: 'bytes', bytes: best.data },
        format: best.format,
        mime: mimeOf(best.format),
        width: best.info.width,
        height: best.info.pageHeight ?? best.info.height,
        warnings: plan.warnings,
      };
    } catch (err) {
      if (err instanceof OptimizerError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/pixel limit/i.test(msg)) throw new DimensionLimitError('Image exceeds the pixel limit');
      if (CORRUPT_HINTS.test(msg)) throw new CorruptMediaError(undefined, { cause: err });
      throw err;
    }
  }
}
