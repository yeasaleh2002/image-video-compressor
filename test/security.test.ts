import { describe, expect, it } from 'vitest';
import { ConcurrencyLimiter } from '../src/core/limiter.js';
import {
  CorruptMediaError, DimensionLimitError, PayloadTooLargeError, ProcessingTimeoutError, QueueFullError,
  SsrfBlockedError, UnsupportedMediaError, ValidationError,
} from '../src/errors.js';
import { isBlockedIp } from '../src/security/ip.js';
import { detectMedia } from '../src/security/magic.js';
import { SecurityGuard } from '../src/security/SecurityGuard.js';

function pngHeader(w: number, h: number): Uint8Array {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

describe('IP classification (SSRF)', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2002:7f00:1::',
    'not-an-ip',
  ])('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows %s', (ip) => expect(isBlockedIp(ip)).toBe(false));
});

describe('SecurityGuard.validateUrl', () => {
  const g = new SecurityGuard();
  it.each([
    'file:///etc/passwd', 'ftp://example.com/a.jpg', 'gopher://x', 'javascript:alert(1)',
    'http://127.0.0.1/a.jpg', 'http://2130706433/a.jpg', 'http://0x7f.1/a.jpg', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/',
    'http://foo.localhost/', 'http://db.internal/', 'http://user:pw@example.com/', 'http://example.com:22/',
  ])('rejects %s', (u) => expect(() => g.validateUrl(u)).toThrow(/not allowed|Only http|credentials|Port/));

  it('accepts a public https URL', () => {
    expect(g.validateUrl('https://example.com/cat.jpg').hostname).toBe('example.com');
  });
});

describe('SecurityGuard.normalizeOptions', () => {
  const g = new SecurityGuard();
  it('fills defaults', () => {
    expect(g.normalizeOptions({ mediaType: 'auto' })).toEqual({
      mediaType: 'auto',
      image: { quality: 80, format: 'auto', lossless: false },
      video: { crf: 28, preset: 'fast', audioBitrate: '96k', removeAudio: false },
    });
  });
  it.each([
    [{ mediaType: 'audio' }],
    [{ mediaType: 'auto', extra: 1 }],
    [JSON.parse('{"mediaType":"auto","__proto__":{"polluted":true}}')],
    [{ mediaType: 'auto', imageSettings: { quality: 0 } }],
    [{ mediaType: 'auto', imageSettings: { quality: 50.5 } }],
    [{ mediaType: 'auto', imageSettings: { format: 'svg' } }],
    [{ mediaType: 'auto', imageSettings: { format: 'jpeg', lossless: true } }],
    [{ mediaType: 'auto', videoSettings: { crf: 52 } }],
    [{ mediaType: 'auto', videoSettings: { preset: 'placebo' } }],
    [{ mediaType: 'auto', videoSettings: { audioBitrate: '64k -f null -' } }],
    [{ mediaType: 'auto', videoSettings: { audioBitrate: '9999k' } }],
  ])('rejects %j', (o) => expect(() => g.normalizeOptions(o)).toThrow(ValidationError));
});

describe('Magic numbers & bomb guards', () => {
  const g = new SecurityGuard();

  it('reads PNG dimensions from the header without decoding', () => {
    expect(detectMedia(pngHeader(640, 480))).toMatchObject({ kind: 'image', format: 'png', width: 640, height: 480 });
  });

  it('rejects a 50 000 x 50 000 pixel bomb before decode', () => {
    const d = detectMedia(pngHeader(50_000, 50_000));
    expect(() => g.assertDetected(d, 'auto')).toThrow(DimensionLimitError);
  });

  it('rejects SVG / HTML / text regardless of extension', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    expect(() => detectMedia(svg)).toThrow(UnsupportedMediaError);
  });

  it('rejects an HLS playlist (ffmpeg SSRF vector)', () => {
    const m3u8 = new TextEncoder().encode('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\nhttp://169.254.169.254/\n');
    expect(() => detectMedia(m3u8)).toThrow(UnsupportedMediaError);
  });

  it('flags truncated headers as corrupt', () => {
    expect(() => detectMedia(pngHeader(10, 10).subarray(0, 18))).toThrow(CorruptMediaError);
    expect(() => detectMedia(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(CorruptMediaError);
  });

  it('rejects a mediaType mismatch', () => {
    expect(() => g.assertDetected(detectMedia(pngHeader(10, 10)), 'video')).toThrow(UnsupportedMediaError);
  });

  it('checks base64 size before decoding', () => {
    expect(() => g.assertBase64Size(200 * 1024 * 1024 * 4)).toThrow(PayloadTooLargeError);
  });
});

describe('ConcurrencyLimiter', () => {
  it('rejects with 503 when the queue is full', async () => {
    const l = new ConcurrencyLimiter(1, 1);
    const slow = () => new Promise<void>((r) => setTimeout(r, 100));
    const a = l.run(slow, 5000);
    const b = l.run(slow, 5000);
    await expect(l.run(slow, 5000)).rejects.toBeInstanceOf(QueueFullError);
    await Promise.all([a, b]);
    expect(l.stats).toEqual({ active: 0, queued: 0 });
  });

  it('times out and aborts the task', async () => {
    const l = new ConcurrencyLimiter(1, 0);
    let aborted = false;
    await expect(l.run((signal) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }), 50))
      .rejects.toBeInstanceOf(ProcessingTimeoutError);
    expect(aborted).toBe(true);
    expect(l.stats.active).toBe(0);
  });
});

describe('Error envelope', () => {
  it('serialises to { success, error, code }', () => {
    expect(new SsrfBlockedError().toJSON()).toEqual({ success: false, error: 'URL destination is not allowed', code: 403 });
  });
});
