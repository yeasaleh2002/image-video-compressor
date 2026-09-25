import type { EncodeResult, ImageAdapter, JobContext, MediaSource } from '../adapters/types.js';
import { planImage, type EncodeFormat } from '../adapters/imagePlan.js';
import { CorruptMediaError, ProcessingTimeoutError } from '../errors.js';
import { mimeOf } from '../security/magic.js';
import type { NormalizedOptions } from '../security/SecurityGuard.js';
import type { DetectedMedia } from '../types.js';

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toBlob(canvas: AnyCanvas, type: string, quality: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encoding failed'))), type, quality));
}

let capabilities: Promise<Set<EncodeFormat>> | undefined;

function probeEncoders(): Promise<Set<EncodeFormat>> {
  capabilities ??= (async () => {
    const set = new Set<EncodeFormat>(['png', 'jpeg']);
    for (const f of ['webp', 'avif'] as const) {
      try {
        const blob = await toBlob(makeCanvas(1, 1), mimeOf(f), 0.5);
        if (blob.type === mimeOf(f)) set.add(f);
      } catch {}
    }
    return set;
  })();
  return capabilities;
}

export class CanvasImageAdapter implements ImageAdapter {
  async optimize(
    src: MediaSource, detected: DetectedMedia, opts: NormalizedOptions['image'], ctx: JobContext,
  ): Promise<EncodeResult> {
    if (src.type !== 'bytes') throw new Error('CanvasImageAdapter expects bytes');
    const warnings: string[] = [];
    let available = await probeEncoders();

    if (opts.lossless) {
      if (opts.format !== 'auto' && opts.format !== 'png') warnings.push(`Lossless ${opts.format} is unavailable in browsers; used png`);
      available = new Set(['png']);
      opts = { ...opts, format: 'auto' };
    }
    if (detected.format === 'gif' || detected.format === 'webp') {
      warnings.push('Browser encoding keeps only the first frame of animations');
    }

    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(new Blob([src.bytes as Uint8Array<ArrayBuffer>], { type: detected.mime }), { imageOrientation: 'from-image' });
    } catch (err) {
      throw new CorruptMediaError('Image could not be decoded', { cause: err });
    }

    const canvas = makeCanvas(bitmap.width, bitmap.height);
    try {
      const plan = planImage({
        detected, hasAlpha: detected.format !== 'jpeg', animated: false, opts,
        available, animatable: new Set(),
      });
      warnings.push(...plan.warnings);

      let best: { blob: Blob; format: EncodeFormat } | undefined;
      for (const f of plan.candidates) {
        if (ctx.signal.aborted) throw new ProcessingTimeoutError();
        const g = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (!g) throw new Error('2D canvas unavailable');
        g.clearRect(0, 0, canvas.width, canvas.height);
        if (f === 'jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height); }
        g.drawImage(bitmap, 0, 0);
        const blob = await toBlob(canvas, mimeOf(f), opts.quality / 100);
        if (!best || blob.size < best.blob.size) best = { blob, format: f };
      }
      if (!best) throw new CorruptMediaError('No encodable output');

      return {
        output: { type: 'bytes', bytes: new Uint8Array(await best.blob.arrayBuffer()) },
        format: best.format,
        mime: mimeOf(best.format),
        width: bitmap.width,
        height: bitmap.height,
        warnings,
      };
    } finally {
      bitmap.close();
      canvas.width = 0; canvas.height = 0;
    }
  }
}
