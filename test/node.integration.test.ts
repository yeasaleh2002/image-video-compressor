import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { optimizeMiddleware } from '../src/middleware/express.js';
import { createNodeOptimizer } from '../src/node.js';

const require = createRequire(import.meta.url);
const FFMPEG = require('ffmpeg-static') as string;
const FFPROBE = (require('ffprobe-static') as { path: string }).path;

let root: string;
let tmp: string;
let photo: Buffer;

/** A noisy 1600x1200 "photo" with EXIF (GPS-style comment) and an ICC profile. */
async function makePhoto(): Promise<Buffer> {
  const { width, height } = { width: 1600, height: 1200 };
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = (x * 255) / width; raw[i + 1] = (y * 255) / height; raw[i + 2] = ((x ^ y) & 0xff);
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .withExif({ IFD0: { Make: 'SecretCam', Model: 'Serial-12345', ImageDescription: '<script>alert(1)</script>' } })
    .withIccProfile('p3')
    .jpeg({ quality: 98 })
    .toBuffer();
}

function makeVideo(file: string, size: string, extra: string[] = []): void {
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=2`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-metadata', 'title=SECRET-TITLE', '-metadata', 'location=+40.7128-074.0060/',
    '-c:v', 'libx264', '-crf', '8', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k',
    ...extra, file,
  ]);
}

function probe(file: string): { streams: Array<Record<string, unknown>>; format: { tags?: Record<string, string> } } {
  return JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).toString());
}

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'smo-root-'));
  tmp = mkdtempSync(path.join(os.tmpdir(), 'smo-tmp-'));
  mkdirSync(path.join(root, 'uploads'));
  photo = await makePhoto();
  writeFileSync(path.join(root, 'uploads', 'photo.jpg'), photo);
  writeFileSync(path.join(root, 'secret.txt'), 'top secret');
  makeVideo(path.join(root, 'uploads', 'clip.mp4'), '640x360');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

describe('images (sharp)', () => {
  it('optimizes a Buffer → Buffer, keeps dimensions, strips EXIF/ICC', async () => {
    const opt = createNodeOptimizer({ tempDir: tmp });
    const res = await opt.optimize(photo, { mediaType: 'auto', imageSettings: { format: 'auto', quality: 75 } });

    expect(res.success).toBe(true);
    expect(Buffer.isBuffer(res.data)).toBe(true);
    expect(['avif', 'webp', 'jpeg']).toContain(res.format);
    expect(res.optimizedSize).toBeLessThan(res.originalSize * 0.3); // > 70 % smaller
    const meta = await sharp(res.data).metadata();
    expect([meta.width, meta.height]).toEqual([1600, 1200]);
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(res.data.includes(Buffer.from('SecretCam'))).toBe(false);
    console.log(`image: ${res.originalSize} → ${res.optimizedSize} bytes (${res.compressionRatio}) as ${res.format}`);
  });

  it('keeps base64 ⇄ base64 and data URL ⇄ data URL symmetry', async () => {
    const opt = createNodeOptimizer({ tempDir: tmp });
    const b64 = await opt.optimize({ base64: photo.toString('base64') }, { mediaType: 'image', imageSettings: { format: 'webp' } });
    expect(typeof b64.data).toBe('string');
    expect(Buffer.from(b64.data, 'base64').subarray(8, 12).toString()).toBe('WEBP');

    const dataUrl = await opt.optimize(`data:image/png;base64,${photo.toString('base64')}`, { mediaType: 'auto', imageSettings: { format: 'webp' } });
    expect(dataUrl.data.startsWith('data:image/webp;base64,')).toBe(true);

    const blob = await opt.optimize(new Blob([photo]), { mediaType: 'auto', imageSettings: { format: 'png', lossless: true } });
    expect(blob.data).toBeInstanceOf(Blob);
    expect(blob.data.type).toBe('image/png');
  });

  it('rejects a lying extension / declared MIME (magic numbers win)', async () => {
    const opt = createNodeOptimizer({ tempDir: tmp });
    const res = await opt.optimizeSafe(`data:image/png;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}`);
    expect(res).toEqual({ success: false, error: 'Unrecognised or disallowed file signature', code: 415 });
  });

  it('rejects a corrupt JPEG with 422', async () => {
    const opt = createNodeOptimizer({ tempDir: tmp });
    const broken = Buffer.from(photo.subarray(0, Math.floor(photo.length / 3)));
    const res = await opt.optimizeSafe(broken, { mediaType: 'image' });
    expect(res).toMatchObject({ success: false, code: 422 });
  });
});

describe('path jail', () => {
  it('disables path inputs unless allowedRoots is set', async () => {
    const res = await createNodeOptimizer({ tempDir: tmp }).optimizeSafe({ path: path.join(root, 'uploads', 'photo.jpg') });
    expect(res).toMatchObject({ success: false, code: 403 });
  });

  it.each(['../secret.txt', '../../../../etc/passwd', 'uploads/../../x', '\\\\server\\share\\a.jpg', 'a\0.jpg'])(
    'blocks %j', async (p) => {
      const opt = createNodeOptimizer({ tempDir: tmp, allowedRoots: [path.join(root, 'uploads')] });
      const res = await opt.optimizeSafe({ path: p });
      expect(res.success).toBe(false);
      expect([403]).toContain((res as { code: number }).code);
    });

  it('optimizes path → new path next to the input, never overwriting', async () => {
    const opt = createNodeOptimizer({ tempDir: tmp, allowedRoots: [path.join(root, 'uploads')] });
    const res = await opt.optimize({ path: 'photo.jpg' }, { mediaType: 'image', imageSettings: { format: 'webp', quality: 70 } });
    expect(path.dirname(res.data)).toBe(path.join(root, 'uploads'));
    expect(path.basename(res.data)).toMatch(/^photo-optimized-[0-9a-f]{8}\.webp$/);
    expect(readFileSync(res.data).subarray(8, 12).toString()).toBe('WEBP');
  });
});

describe('video (native ffmpeg)', () => {
  it('path → path MP4: smaller, same dimensions, metadata stripped', async () => {
    const opt = createNodeOptimizer({ tempDir: tmp, allowedRoots: [path.join(root, 'uploads')] });
    const res = await opt.optimize({ path: 'clip.mp4' }, {
      mediaType: 'auto', videoSettings: { crf: 30, preset: 'fast', audioBitrate: '64k' },
    });
    expect(res.format).toBe('mp4');
    expect(res.optimizedSize).toBeLessThan(res.originalSize);
    const p = probe(res.data);
    const v = p.streams.find((s) => s.codec_type === 'video')!;
    expect([v.width, v.height]).toEqual([640, 360]);
    expect(JSON.stringify(p.format.tags ?? {})).not.toMatch(/SECRET|40\.7128/);
    console.log(`video: ${res.originalSize} → ${res.optimizedSize} bytes (${res.compressionRatio})`);
  });

  it('Buffer → Buffer WebM with audio removed', async () => {
    const webm = path.join(root, 'clip.webm');
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=1',
      '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'libvpx-vp9', '-b:v', '2M', '-c:a', 'libopus', webm]);
    const opt = createNodeOptimizer({ tempDir: tmp });
    const res = await opt.optimize(readFileSync(webm), { mediaType: 'video', videoSettings: { removeAudio: true, crf: 35 } });
    expect(res.format).toBe('webm');
    const out = path.join(root, 'out.webm');
    writeFileSync(out, res.data);
    const streams = probe(out).streams;
    expect(streams.map((s) => s.codec_type)).toEqual(['video']);
  });

  it('handles odd dimensions for H.264 (1px trim, reported as a warning)', async () => {
    const odd = path.join(root, 'odd.mp4');
    makeVideo(odd, '321x241', ['-vf', 'scale=321:241', '-pix_fmt', 'yuv444p', '-profile:v', 'high444']);
    const res = await createNodeOptimizer({ tempDir: tmp }).optimize(readFileSync(odd), { mediaType: 'video' });
    expect(res.details.warnings.join()).toMatch(/Odd dimensions/);
    expect([res.details.width, res.details.height]).toEqual([320, 240]);
  });

  it('rejects a video over the duration limit before transcoding', async () => {
    const opt = createNodeOptimizer({ tempDir: tmp, limits: { maxVideoDurationSeconds: 1 } });
    const res = await opt.optimizeSafe(readFileSync(path.join(root, 'uploads', 'clip.mp4')));
    expect(res).toMatchObject({ success: false, code: 413 });
  });
});

describe('temp-file hygiene', () => {
  it('leaves no workspace directories behind after success and failure', async () => {
    const opt = createNodeOptimizer({ tempDir: tmp });
    await opt.optimizeSafe(readFileSync(path.join(root, 'uploads', 'clip.mp4')), { mediaType: 'video' });
    await opt.optimizeSafe(Buffer.from(photo.subarray(0, 5000)));
    expect(readdirSync(tmp).filter((d) => d.startsWith('smo-'))).toEqual([]);
  });
});

describe('Express middleware', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const optimizer = createNodeOptimizer({ tempDir: tmp });
    const mw = optimizeMiddleware({ optimizer, maxJsonBytes: 10 * 1024 * 1024 });
    server = http.createServer((req, res) => void mw(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    fetch(base, { method: 'POST', headers, body: typeof body === 'string' || body instanceof Uint8Array ? body as BodyInit : JSON.stringify(body) });

  it('JSON base64 in → JSON base64 out', async () => {
    const r = await post({ options: { mediaType: 'image', imageSettings: { format: 'webp', quality: 70 } }, data: photo.toString('base64') });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const j = await r.json() as { success: boolean; format: string; data: string };
    expect(j).toMatchObject({ success: true, format: 'webp' });
    expect(Buffer.from(j.data, 'base64').subarray(8, 12).toString()).toBe('WEBP');
  });

  it('binary in → binary out with metric headers', async () => {
    const r = await post(photo, { 'content-type': 'image/jpeg', 'x-optimize-options': JSON.stringify({ mediaType: 'auto', imageSettings: { format: 'avif' } }) });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/avif');
    expect(Number(r.headers.get('x-optimize-optimized-size'))).toBe((await r.arrayBuffer()).byteLength);
  });

  it('never exposes path inputs over HTTP', async () => {
    const r = await post({ path: '/etc/passwd' });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ success: false, error: 'Unknown field "path"', code: 400 });
  });

  it('blocks SSRF to the metadata service', async () => {
    const r = await post({ url: 'http://169.254.169.254/latest/meta-data/' });
    expect(await r.json()).toEqual({ success: false, error: 'URL destination is not allowed', code: 403 });
  });

  it('returns 413 for oversized bodies without buffering them', async () => {
    const r = await post(JSON.stringify({ data: 'A'.repeat(11 * 1024 * 1024) }));
    expect(r.status).toBe(413);
  });

  it('returns 400 for malformed JSON and bad options', async () => {
    expect((await post('{nope')).status).toBe(400);
    const r = await post({ options: { mediaType: 'auto', videoSettings: { audioBitrate: '64k; rm -rf /' } }, data: photo.toString('base64') });
    expect(r.status).toBe(400);
  });
});
