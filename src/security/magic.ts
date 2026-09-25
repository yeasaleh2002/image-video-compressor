/**
 * @file Magic-number sniffing + cheap header parsing.
 *
 * Why in-house instead of `file-type`?
 *  1. **Allow-list, not identify-everything.** We only need to recognise the
 *     ~11 formats we are willing to decode. Anything else — SVG (script/XSS
 *     vector), HEIC, PDFs, archives, HLS playlists — falls through to
 *     `UnsupportedMediaError` by construction.
 *  2. **Dimensions before decode.** Pixel-bomb protection requires reading
 *     width/height from the header *before* a decoder allocates a framebuffer.
 *  3. **Isomorphic and synchronous.** Pure `Uint8Array` logic: identical
 *     behaviour in Node and in browsers, zero dependencies.
 *
 * Every parser is bounds-checked; a header that ends early or contradicts
 * itself is reported as {@link CorruptMediaError}, never as an exception from
 * an out-of-range read.
 */
import { CorruptMediaError, UnsupportedMediaError } from '../errors.js';
import type { DetectedFormat, DetectedMedia, MediaKind } from '../types.js';

/** How many leading bytes callers should provide for video sniffing. */
export const SNIFF_BYTES = 64 * 1024;

const MIME: Record<DetectedFormat, string> = {
  jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', tiff: 'image/tiff',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo',
};

const KIND: Record<DetectedFormat, MediaKind> = {
  jpeg: 'image', png: 'image', gif: 'image', webp: 'image', avif: 'image', tiff: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video',
};

export function mimeOf(format: DetectedFormat | 'webp' | 'avif' | 'jpeg' | 'png'): string {
  return MIME[format];
}

/* ------------------------------------------------------------------------- */
/* Bounds-checked readers                                                    */
/* ------------------------------------------------------------------------- */

function need(b: Uint8Array, end: number, what: string): void {
  if (end > b.length) throw new CorruptMediaError(`Truncated ${what} header`);
}
const u8 = (b: Uint8Array, o: number) => { need(b, o + 1, 'media'); return b[o]!; };
const u16be = (b: Uint8Array, o: number) => (u8(b, o) << 8) | u8(b, o + 1);
const u16le = (b: Uint8Array, o: number) => u8(b, o) | (u8(b, o + 1) << 8);
const u24le = (b: Uint8Array, o: number) => u16le(b, o) | (u8(b, o + 2) << 16);
const u32be = (b: Uint8Array, o: number) => ((u16be(b, o) << 16) >>> 0) + u16be(b, o + 2);
const u32le = (b: Uint8Array, o: number) => (u16le(b, o) + ((u16le(b, o + 2) << 16) >>> 0)) >>> 0;
const ascii = (b: Uint8Array, o: number, n: number) => {
  need(b, o + n, 'media');
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]!);
  return s;
};
const startsWith = (b: Uint8Array, sig: number[], o = 0) =>
  b.length >= o + sig.length && sig.every((v, i) => b[o + i] === v);

function indexOfAscii(b: Uint8Array, needle: string, from = 0, limit = b.length): number {
  const end = Math.min(limit, b.length) - needle.length;
  outer: for (let i = from; i <= end; i++) {
    for (let j = 0; j < needle.length; j++) if (b[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/* ------------------------------------------------------------------------- */
/* Per-format dimension parsers                                              */
/* ------------------------------------------------------------------------- */

function pngSize(b: Uint8Array): [number, number] {
  // Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4)
  if (ascii(b, 12, 4) !== 'IHDR') throw new CorruptMediaError('PNG is missing its IHDR chunk');
  return [u32be(b, 16), u32be(b, 20)];
}

function jpegSize(b: Uint8Array): [number, number] {
  let o = 2;
  while (o < b.length) {
    // Markers may be preceded by any number of 0xFF fill bytes.
    if (u8(b, o) !== 0xff) throw new CorruptMediaError('Invalid JPEG marker stream');
    while (o < b.length && b[o] === 0xff) o++;
    const marker = u8(b, o); o++;
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS before any SOF → no frame header
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue; // standalone markers
    const len = u16be(b, o);
    if (len < 2) throw new CorruptMediaError('Invalid JPEG segment length');
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return [u16be(b, o + 5), u16be(b, o + 3)];
    o += len;
  }
  throw new CorruptMediaError('JPEG has no frame header');
}

function webpSize(b: Uint8Array): [number, number] {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ') {
    if (!startsWith(b, [0x9d, 0x01, 0x2a], 23)) throw new CorruptMediaError('Invalid VP8 frame tag');
    return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff];
  }
  if (chunk === 'VP8L') {
    if (u8(b, 20) !== 0x2f) throw new CorruptMediaError('Invalid VP8L signature');
    const bits = u32le(b, 21);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (chunk === 'VP8X') return [u24le(b, 24) + 1, u24le(b, 27) + 1];
  throw new CorruptMediaError('Unknown WebP chunk layout');
}

function gifSize(b: Uint8Array): [number, number] {
  return [u16le(b, 6), u16le(b, 8)];
}

function tiffSize(b: Uint8Array): [number, number] {
  const le = b[0] === 0x49;
  const r16 = (o: number) => (le ? u16le(b, o) : u16be(b, o));
  const r32 = (o: number) => (le ? u32le(b, o) : u32be(b, o));
  const ifd = r32(4);
  const count = r16(ifd);
  if (count > 4096) throw new CorruptMediaError('Implausible TIFF IFD');
  let w = 0, h = 0;
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    const tag = r16(e);
    const type = r16(e + 2);
    const value = type === 3 ? r16(e + 8) : r32(e + 8);
    if (tag === 256) w = value;
    else if (tag === 257) h = value;
  }
  return [w, h];
}

/**
 * AVIF: the image spatial extent lives in `ispe` property boxes. Grids and
 * thumbnails can each carry one, so we take the largest — that's what the
 * decoder will ultimately allocate.
 */
function avifSize(b: Uint8Array): [number, number] {
  let w = 0, h = 0, from = 0;
  for (;;) {
    const i = indexOfAscii(b, 'ispe', from, SNIFF_BYTES);
    if (i < 0) break;
    // box type (4) + version/flags (4) → width, height
    w = Math.max(w, u32be(b, i + 8));
    h = Math.max(h, u32be(b, i + 12));
    from = i + 4;
  }
  if (!w || !h) throw new CorruptMediaError('AVIF is missing its spatial extent');
  return [w, h];
}

/* ------------------------------------------------------------------------- */
/* Container sniffers                                                        */
/* ------------------------------------------------------------------------- */

const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1',
  'dash', 'M4V ', 'M4VH', 'M4VP', 'mmp4', '3gp4', '3gp5', '3gp6', '3g2a', 'f4v ',
]);
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

function sniffFtyp(b: Uint8Array): DetectedFormat {
  const size = u32be(b, 0);
  if (size < 16) throw new CorruptMediaError('Invalid ftyp box');
  const major = ascii(b, 8, 4);
  // Compatible brands follow the minor version (bytes 12-15).
  const compat: string[] = [];
  for (let o = 16; o + 4 <= Math.min(size, b.length, 256); o += 4) compat.push(ascii(b, o, 4));
  const brands = [major, ...compat];

  if (major === 'avif' || major === 'avis' || (HEIF_BRANDS.has(major) && compat.includes('avif'))) return 'avif';
  if (major === 'qt  ') return 'mov';
  if (brands.some((x) => MP4_BRANDS.has(x))) return 'mp4';
  if (HEIF_BRANDS.has(major)) throw new UnsupportedMediaError('HEIC/HEIF is not supported; convert to JPEG/AVIF first');
  if (major.startsWith('M4A') || major === 'M4B ') throw new UnsupportedMediaError('Audio-only files are not supported');
  throw new UnsupportedMediaError(`Unsupported ISO-BMFF brand "${major.trim()}"`);
}

function sniffEbml(b: Uint8Array): DetectedFormat {
  // DocType element ID 0x4282, then a 1-byte vint size (0x80 | len) for short strings.
  for (let i = 4; i < Math.min(b.length - 3, 4096); i++) {
    if (b[i] === 0x42 && b[i + 1] === 0x82) {
      const len = u8(b, i + 2) & 0x7f;
      const doc = ascii(b, i + 3, Math.min(len, 16));
      if (doc === 'webm') return 'webm';
      if (doc === 'matroska') return 'mkv';
      throw new UnsupportedMediaError(`Unsupported EBML DocType "${doc}"`);
    }
  }
  throw new CorruptMediaError('EBML header has no DocType');
}

/**
 * Identify media from its first bytes. Throws for anything outside the
 * allow-list; never looks at filenames, extensions or declared MIME types.
 *
 * @param head The file's leading bytes. Pass the whole file for images (so
 *             JPEG SOF scanning can walk past large EXIF blocks) or at least
 *             {@link SNIFF_BYTES} for videos.
 * @param opts.dimensions Set to `false` to identify the format from a partial
 *             head without parsing dimensions (used to pick the per-kind
 *             byte limit before reading a whole file).
 */
export function detectMedia(head: Uint8Array, opts: { dimensions?: boolean } = {}): DetectedMedia {
  const wantSize = opts.dimensions !== false;
  if (head.length < 12) throw new CorruptMediaError('File is too small to be valid media');

  let format: DetectedFormat | undefined;
  let size: [number, number] | undefined;

  if (startsWith(head, [0xff, 0xd8, 0xff])) { format = 'jpeg'; if (wantSize) size = jpegSize(head); }
  else if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) { format = 'png'; if (wantSize) size = pngSize(head); }
  else if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') { format = 'gif'; if (wantSize) size = gifSize(head); }
  else if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') { format = 'webp'; if (wantSize) size = webpSize(head); }
  else if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'AVI ') { format = 'avi'; }
  else if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) { format = 'tiff'; if (wantSize) size = tiffSize(head); }
  else if (ascii(head, 4, 4) === 'ftyp') { format = sniffFtyp(head); if (format === 'avif' && wantSize) size = avifSize(head); }
  else if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) { format = sniffEbml(head); }

  if (!format) throw new UnsupportedMediaError('Unrecognised or disallowed file signature');

  const out: DetectedMedia = { kind: KIND[format], format, mime: MIME[format] };
  if (size) {
    const [width, height] = size;
    if (!width || !height) throw new CorruptMediaError('Media header reports zero dimensions');
    out.width = width;
    out.height = height;
  }
  return out;
}
