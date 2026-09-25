/**
 * @file Node image adapter backed by `sharp` (libvips).
 *
 * Security properties:
 *  - `limitInputPixels` is set from the header-verified dimensions, so libvips
 *    itself refuses to allocate beyond what we validated (defence in depth for
 *    headers that lie).
 *  - `failOn: 'error'` rejects truncated/corrupt pixel data instead of
 *    silently emitting a half-grey image.
 *  - **Metadata stripping is sharp's default**: no `withMetadata()` /
 *    `keepMetadata()` call means EXIF (GPS, device serials), XMP (can carry
 *    script payloads), IPTC and comments are all dropped. ICC profiles are
 *    *converted* to sRGB and then removed — stripping without converting would
 *    visibly shift colours on wide-gamut (Display P3 / Adobe RGB) photos.
 *  - `.rotate()` bakes the EXIF orientation into the pixels *before* EXIF is
 *    dropped; otherwise portrait phone photos come out sideways.
 */
import sharp, { type Sharp } from 'sharp';
import type { EncodeResult, ImageAdapter, JobContext, MediaSource } from '../adapters/types.js';
import { planImage, type EncodeFormat } from '../adapters/imagePlan.js';
import { CorruptMediaError, DimensionLimitError, OptimizerError, ProcessingTimeoutError } from '../errors.js';
import { mimeOf } from '../security/magic.js';
import type { NormalizedOptions } from '../security/SecurityGuard.js';
import type { DetectedMedia } from '../types.js';

const ALL: ReadonlySet<EncodeFormat> = new Set(['webp', 'avif', 'jpeg', 'png']);
// sharp can write animated WebP (and GIF, which we don't offer as an output).
const ANIMATABLE: ReadonlySet<EncodeFormat> = new Set(['webp']);

function encoder(pipeline: Sharp, f: EncodeFormat, o: NormalizedOptions['image']): Sharp {
  switch (f) {
    case 'webp': return pipeline.webp({ quality: o.quality, lossless: o.lossless, effort: 5, smartSubsample: true });
    case 'avif': return pipeline.avif({ quality: o.quality, lossless: o.lossless, effort: 4 });
    case 'jpeg': return pipeline.jpeg({ quality: o.quality, mozjpeg: true, progressive: true });
    case 'png':
      // Lossy mode quantises to a palette (pngquant-style), usually a 60-80% saving on flat graphics.
      return pipeline.png({ compressionLevel: 9, adaptiveFiltering: true, palette: !o.lossless, quality: o.quality, effort: 8 });
  }
}

/** libvips messages that mean "the file is bad", not "we are broken". */
const CORRUPT_HINTS = /(corrupt|truncat|premature|invalid|bad |unexpected end|not a known|unsupported image|vipsjpeg|pngload|webpload|gifload|heifload|tiff)/i;

export class SharpImageAdapter implements ImageAdapter {
  async optimize(
    src: MediaSource, detected: DetectedMedia, opts: NormalizedOptions['image'], ctx: JobContext,
  ): Promise<EncodeResult> {
    if (src.type !== 'bytes') throw new Error('SharpImageAdapter expects an in-memory image');
    const input = src.bytes;

    try {
      // metadata() parses headers only — no pixel decode, safe before limits are known.
      const meta = await sharp(input, { limitInputPixels: false, animated: true }).metadata();
      const width = meta.width ?? 0;
      const frameHeight = meta.pageHeight ?? meta.height ?? 0;
      const frames = meta.pages ?? 1;
      if (!width || !frameHeight) throw new CorruptMediaError('Image has no dimensions');
      ctx.guard.assertDimensions(width, frameHeight, frames);
      // The whole animation is decoded as one tall strip: bound its *total* pixel count too.
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
        // Sharp can't be interrupted mid-encode, but we stop between candidates.
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
