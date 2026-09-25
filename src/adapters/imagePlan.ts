/**
 * @file Which output encodings to try for an image. Shared by Node and browser.
 *
 * `'auto'` is resolved by *measurement*, not heuristics: each candidate is
 * encoded and the smallest wins. The candidate list is chosen so the
 * comparison is always legal (e.g. never JPEG for transparent images, never a
 * still-only format for animations).
 */
import type { NormalizedOptions } from '../security/SecurityGuard.js';
import type { DetectedMedia } from '../types.js';

export type EncodeFormat = 'webp' | 'avif' | 'jpeg' | 'png';

export interface ImagePlanInput {
  detected: DetectedMedia;
  hasAlpha: boolean;
  animated: boolean;
  opts: NormalizedOptions['image'];
  /** Formats the current encoder can produce (browsers vary on AVIF). */
  available: ReadonlySet<EncodeFormat>;
  /** Formats that can carry animation with this encoder. */
  animatable: ReadonlySet<EncodeFormat>;
}

export interface ImagePlan {
  candidates: EncodeFormat[];
  /** Encode only the first frame (target format can't animate). */
  flatten: boolean;
  warnings: string[];
}

export function planImage(p: ImagePlanInput): ImagePlan {
  const warnings: string[] = [];
  const { format, lossless } = p.opts;

  if (format !== 'auto') {
    if (!p.available.has(format)) {
      // Explicit request we can't honour here (e.g. AVIF encode on Safari): degrade to WebP, loudly.
      warnings.push(`${format} encoding is unavailable in this runtime; used webp`);
      return { candidates: ['webp'], flatten: p.animated && !p.animatable.has('webp'), warnings };
    }
    const flatten = p.animated && !p.animatable.has(format);
    if (flatten) warnings.push(`${format} output cannot be animated; kept the first frame only`);
    return { candidates: [format], flatten, warnings };
  }

  let candidates: EncodeFormat[];
  if (p.animated) {
    candidates = ['webp'];
  } else if (lossless) {
    candidates = ['webp', 'png'];
  } else {
    candidates = ['avif', 'webp'];
    // A well-tuned JPEG (mozjpeg) sometimes beats WebP on photos that were already JPEG.
    if (!p.hasAlpha && p.detected.format === 'jpeg') candidates.push('jpeg');
  }
  candidates = candidates.filter((f) => p.available.has(f));
  if (candidates.length === 0) candidates = ['png'];
  return { candidates, flatten: p.animated && !candidates.every((c) => p.animatable.has(c)), warnings };
}
