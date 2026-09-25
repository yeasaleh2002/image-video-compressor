import type { NormalizedOptions } from '../security/SecurityGuard.js';
import type { DetectedMedia } from '../types.js';

export type EncodeFormat = 'webp' | 'avif' | 'jpeg' | 'png';

export interface ImagePlanInput {
  detected: DetectedMedia;
  hasAlpha: boolean;
  animated: boolean;
  opts: NormalizedOptions['image'];
  available: ReadonlySet<EncodeFormat>;
  animatable: ReadonlySet<EncodeFormat>;
}

export interface ImagePlan {
  candidates: EncodeFormat[];
  flatten: boolean;
  warnings: string[];
}

export function planImage(p: ImagePlanInput): ImagePlan {
  const warnings: string[] = [];
  const { format, lossless } = p.opts;

  if (format !== 'auto') {
    if (!p.available.has(format)) {
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

    if (!p.hasAlpha && p.detected.format === 'jpeg') candidates.push('jpeg');
  }
  candidates = candidates.filter((f) => p.available.has(f));
  if (candidates.length === 0) candidates = ['png'];
  return { candidates, flatten: p.animated && !candidates.every((c) => p.animatable.has(c)), warnings };
}
