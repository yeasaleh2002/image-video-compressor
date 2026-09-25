<div align="center">

# image-video-compressor

**Secure image & video compression for Node.js and the browser, with one API.**

[![npm version](https://img.shields.io/npm/v/image-video-compressor.svg?color=cb3837&logo=npm)](https://www.npmjs.com/package/image-video-compressor)
[![npm downloads](https://img.shields.io/npm/dm/image-video-compressor.svg?color=blue)](https://www.npmjs.com/package/image-video-compressor)
[![license](https://img.shields.io/npm/l/image-video-compressor.svg?color=green)](./LICENSE)
[![types](https://img.shields.io/npm/types/image-video-compressor.svg)](https://www.npmjs.com/package/image-video-compressor)
[![node](https://img.shields.io/node/v/image-video-compressor.svg)](https://nodejs.org)

Created by **Yeasaleh** · Inspired by **Nurix hive Team**

### Package Link: https://www.npmjs.com/search?q=image-video-compressor

</div>

---

`image-video-compressor` turns photos into WebP/AVIF and re-encodes videos with H.264 or VP9. Files typically end up **70–90% smaller**, and the original dimensions are kept. The same API runs on a Node.js server (`sharp` + native `ffmpeg`) and in the browser (Canvas + `ffmpeg.wasm`). It also ships ready-made **Express** and **Next.js** endpoints.

The package is built to safely handle files sent by strangers. It rejects pixel bombs before decoding, blocks SSRF and path traversal, ignores file extensions (it checks magic numbers instead), and strips EXIF, GPS and other metadata from every output.

## Table of contents

- [Features](#features)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Usage](#usage)
  - [Node.js: file paths](#nodejs-file-paths)
  - [Node.js: Buffers, Base64 and URLs](#nodejs-buffers-base64-and-urls)
  - [Browser / React: Blobs and Base64](#browser--react-blobs-and-base64)
  - [Express middleware](#express-middleware)
  - [Next.js route handler](#nextjs-route-handler)
- [API reference](#api-reference)
- [Security](#security)
- [What compression to expect](#what-compression-to-expect)
- [FAQ](#faq)
- [License](#license)

## Features

- 🖼️ **Images:** JPEG, PNG, GIF, WebP, AVIF and TIFF in; WebP, AVIF, JPEG (mozjpeg) or PNG out. With `format: 'auto'`, several formats are encoded and the smallest one is kept.
- 🎬 **Videos:** MP4, MOV, WebM, MKV and AVI in; H.264/AAC or VP9/Opus out with CRF quality control. The container is kept, and videos are optimized for web playback (`+faststart`).
- 🌐 **Isomorphic:** your bundler picks the right build automatically (Node or browser).
- 🔁 **Symmetric I/O:** send a Buffer and get a Buffer back; send a Blob and get a Blob back; the same goes for base64, data URLs and file paths.
- 🛡️ **Secure by default:** pixel-bomb, SSRF, path-traversal and MIME-spoofing protection, plus metadata stripping.
- 🚦 **Production-safe:** bounded job queues, per-job timeouts, streamed video handling and self-cleaning temp files.
- 🧩 **Framework-ready:** Express/Connect middleware and a Next.js App Router handler.
- 📘 **TypeScript-first:** strict types, with the output type inferred from the input type.
- 🔌 **Self-contained:** no database, no cloud API, no API key.

## Installation

```bash
# npm
npm install image-video-compressor

# yarn
yarn add image-video-compressor

# pnpm
pnpm add image-video-compressor

# bun
bun add image-video-compressor
```

**Node.js ≥ 18.17.** `sharp` installs prebuilt binaries for your platform. An `ffmpeg`/`ffprobe` binary comes with the optional `ffmpeg-static` / `ffprobe-static` packages. If your environment skips optional dependencies, install `ffmpeg` on the `PATH` or pass `ffmpegPath` / `ffprobePath`.

**Browser video support** (optional) needs ffmpeg.wasm:

```bash
npm install @ffmpeg/ffmpeg @ffmpeg/util     # or: yarn add / pnpm add / bun add
```

## Quick start

```ts
import { createNodeOptimizer } from 'image-video-compressor';
import { readFile } from 'node:fs/promises';

const optimizer = createNodeOptimizer();

const result = await optimizer.optimize(await readFile('photo.jpg'), {
  mediaType: 'auto',
  imageSettings: { format: 'auto', quality: 80 },
});

console.log(result.compressionRatio); // "84.2%"
console.log(result.format);           // "avif"
// result.data is a Buffer, because the input was a Buffer
```

## Usage

### Node.js: file paths

Path inputs are **disabled by default**. Turn them on by listing the directories the optimizer may read from:

```ts
import { createNodeOptimizer } from 'image-video-compressor';

// Create ONE instance per process and reuse it: the concurrency limits are per instance.
export const optimizer = createNodeOptimizer({
  allowedRoots: ['/srv/app/uploads'],       // required for { path } inputs
  outputDir: '/srv/app/uploads/optimized',  // optional; default = next to the input file
});

// Image: relative paths resolve inside the first allowed root
const img = await optimizer.optimize({ path: 'avatars/me.jpg' }, {
  mediaType: 'image',
  imageSettings: { format: 'webp', quality: 75 },
});
console.log(img.data); // "/srv/app/uploads/optimized/me-optimized-3f9a1c2e.webp"

// Video
const vid = await optimizer.optimize({ path: 'clips/demo.mp4' }, {
  mediaType: 'video',
  videoSettings: { crf: 28, preset: 'fast', audioBitrate: '64k' },
});
console.log(vid.data, vid.compressionRatio); // ".../demo-optimized-8b1e0c7d.mp4" "88.9%"

// Escape attempts are rejected
const bad = await optimizer.optimizeSafe({ path: '../../etc/passwd' });
// → { success: false, error: 'Path is outside the allowed directories', code: 403 }
```

Output files get collision-free names and never overwrite existing files.

### Node.js: Buffers, Base64 and URLs

```ts
// Buffer in → Buffer out
const fromBuffer = await optimizer.optimize(buffer, { mediaType: 'auto' });

// Base64 in → base64 out
const fromB64 = await optimizer.optimize({ base64: someBase64 }, {
  mediaType: 'image',
  imageSettings: { format: 'avif', quality: 60 },
});

// Data URL in → data URL out (with the NEW MIME type)
const fromDataUrl = await optimizer.optimize('data:image/png;base64,iVBORw0KGgo...', { mediaType: 'auto' });

// Remote URL: fetched with SSRF protection, 10 s timeout and retries; returns a data URL
const fromUrl = await optimizer.optimize({ url: 'https://example.com/hero.png' }, { mediaType: 'image' });
```

### Browser / React: Blobs and Base64

```tsx
import { useState } from 'react';
import { createBrowserOptimizer } from 'image-video-compressor/browser';

// Module scope: the ffmpeg.wasm worker loads once and is reused.
const optimizer = createBrowserOptimizer({
  // Recommended: serve @ffmpeg/core yourself so nothing loads from a CDN at runtime.
  ffmpeg: { coreURL: '/ffmpeg/ffmpeg-core.js', wasmURL: '/ffmpeg/ffmpeg-core.wasm' },
});

export function MediaUploader() {
  const [preview, setPreview] = useState<string>();
  const [status, setStatus] = useState('');

  async function handleFile(file: File) {
    setStatus('Optimizing…');
    const res = await optimizer.optimizeSafe(file, {
      mediaType: 'auto',
      imageSettings: { format: 'webp', quality: 80 },
      videoSettings: { crf: 30, preset: 'ultrafast', removeAudio: true },
    });

    if (!res.success) {
      setStatus(`Error ${res.code}: ${res.error}`);
      return;
    }
    setStatus(`${res.message} (${res.originalSize} → ${res.optimizedSize} bytes)`);
    setPreview(URL.createObjectURL(res.data)); // a Blob, because a File (Blob) went in
  }

  return (
    <div>
      <input type="file" accept="image/*,video/*" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
      <p>{status}</p>
      {preview && <img src={preview} alt="Optimized preview" />}
    </div>
  );
}
```

Base64 in the browser works the same way:

```ts
const res = await optimizer.optimize({ base64: canvasBase64 }, {
  mediaType: 'image',
  imageSettings: { format: 'webp', quality: 70 },
});
res.data; // base64 string of the WebP
```

> **Browser limitations:** lossless output is PNG only; animated GIF/WebP keep their first frame; AVIF is used only where the browser can encode it (detected at runtime, with WebP as the fallback); video input is capped at 200 MiB because ffmpeg.wasm holds files in memory.

### Express middleware

```ts
import express from 'express';
import { createNodeOptimizer } from 'image-video-compressor';
import { optimizeMiddleware } from 'image-video-compressor/express';

const app = express();
const optimizer = createNodeOptimizer();

// Don't put express.json() in front of this route: the middleware reads
// the body itself and enforces its own byte limit.
app.post('/api/optimize', optimizeMiddleware({
  optimizer,
  maxJsonBytes: 35 * 1024 * 1024,   // default
  maxBinaryBytes: 100 * 1024 * 1024, // default
  allowUrlInput: true,               // default
  onError: (err) => console.error(err), // called for 5xx only
}));

app.get('/healthz', (_req, res) => res.json(optimizer.stats)); // queue depth

app.listen(3000);
```

The endpoint accepts two wire formats.

**JSON in, JSON out.** Send `data` (base64 or a data URL) **or** `url`:

```bash
curl -X POST http://localhost:3000/api/optimize \
  -H 'Content-Type: application/json' \
  -d '{
    "options": { "mediaType": "image", "imageSettings": { "format": "avif", "quality": 60 } },
    "data": "'"$(base64 -w0 photo.jpg)"'"
  }'
```

```json
{
  "success": true,
  "originalSize": 2483115,
  "optimizedSize": 301442,
  "compressionRatio": "87.9%",
  "format": "avif",
  "data": "AAAAHGZ0eXBhdmlm...",
  "message": "Optimized image jpeg → avif, saved 87.9%",
  "details": { "mediaType": "image", "inputFormat": "jpeg", "mimeType": "image/avif", "width": 4032, "height": 3024, "warnings": [] }
}
```

**Binary in, binary out.** This suits large videos best. Put the options in a header; the metrics come back in `X-Optimize-*` response headers:

```bash
curl -X POST http://localhost:3000/api/optimize \
  -H 'Content-Type: video/mp4' \
  -H 'X-Optimize-Options: {"mediaType":"video","videoSettings":{"crf":28,"preset":"fast"}}' \
  --data-binary @clip.mp4 -o clip.optimized.mp4
```

Errors always come back as `{ "success": false, "error": "...", "code": 4xx|5xx }`, with the matching HTTP status. `{ path }` inputs cannot be reached over HTTP.

### Next.js route handler

```ts
// app/api/optimize/route.ts
import { createNodeOptimizer } from 'image-video-compressor';
import { createNextRouteHandler } from 'image-video-compressor/next';

export const runtime = 'nodejs';        // sharp & ffmpeg need Node.js, not the Edge runtime
export const dynamic = 'force-dynamic';

const optimizer = createNodeOptimizer();
export const POST = createNextRouteHandler({ optimizer });
```

It accepts the same JSON and binary formats as the Express middleware.

## API reference

### Entry points

| Import | Use |
|---|---|
| `image-video-compressor` | Picks the Node or browser build automatically |
| `image-video-compressor/node` | Node build, explicitly |
| `image-video-compressor/browser` | Browser build, explicitly |
| `image-video-compressor/express` | `optimizeMiddleware()` |
| `image-video-compressor/next` | `createNextRouteHandler()` |

### `createNodeOptimizer(config?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `allowedRoots` | `string[]` | `[]` | Directories `{ path }` inputs may read. Empty means path inputs are disabled. |
| `outputDir` | `string` | next to input | Where path outputs are written. Must be inside `allowedRoots`. |
| `tempDir` | `string` | `os.tmpdir()` | Base directory for per-job temp folders. |
| `ffmpegPath` / `ffprobePath` | `string` | bundled, or `PATH` | Custom binaries. |
| `limits` | `Partial<SecurityLimits>` | see below | Security limits. |
| `concurrency` | `Partial<ConcurrencyConfig>` | CPU-based | `maxImageJobs`, `maxVideoJobs`, `maxQueue` (default 50). |

### `createBrowserOptimizer(config?)`

| Option | Type | Description |
|---|---|---|
| `ffmpeg` | `{ coreURL?, wasmURL?, workerURL? }` | Self-hosted `@ffmpeg/core` assets. |
| `limits` | `Partial<SecurityLimits>` | `maxVideoBytes` defaults to 200 MiB in the browser. |
| `concurrency` | `{ maxImageJobs?, maxQueue? }` | Video always runs one job at a time (single WASM worker). |

### `optimizer.optimize(input, options?)`

This method returns `Promise<DetailedOptimizationResponse<Output>>` and **throws** an `OptimizerError` on failure.

### `optimizer.optimizeSafe(input, options?)`

The same, but it **never throws**. On failure it resolves to `{ success: false, error, code }`.

### `optimizer.stats`

Returns `{ image: { active, queued }, video: { active, queued } }`, which is handy for health checks and autoscaling.

### `OptimizationOptions`

```ts
interface OptimizationOptions {
  mediaType: 'image' | 'video' | 'auto'; // 'auto' detects via magic numbers
  imageSettings?: {
    quality?: number;                                   // 1-100, default 80
    format?: 'webp' | 'avif' | 'jpeg' | 'png' | 'auto'; // default 'auto' (smallest wins)
    lossless?: boolean;                                 // default false (JPEG can't be lossless)
  };
  videoSettings?: {
    crf?: number;                                              // 0-51, default 28 (higher = smaller)
    preset?: 'ultrafast' | 'superfast' | 'fast' | 'medium';    // default 'fast'
    audioBitrate?: string;                                     // '16k'-'320k', default '96k'
    removeAudio?: boolean;                                     // default false
  };
}
```

Unknown keys and out-of-range values are **rejected** with a 400 `ValidationError`, not silently ignored.

### `OptimizationResponse<T>`

```ts
interface OptimizationResponse<T> {
  success: boolean;
  originalSize: number;     // bytes
  optimizedSize: number;    // bytes
  compressionRatio: string; // e.g. "75.4%" (negative if the output grew)
  format: string;           // 'webp' | 'avif' | 'jpeg' | 'png' | 'mp4' | 'mov' | 'webm' | 'mkv'
  data: T;                  // same container as the input (see table below)
  message: string;
}

// What optimize() actually returns: the spec interface plus details
interface DetailedOptimizationResponse<T> extends OptimizationResponse<T> {
  details: {
    mediaType: 'image' | 'video';
    inputFormat: string;       // detected from magic numbers
    mimeType: string;          // of the output
    width?: number;
    height?: number;
    durationSeconds?: number;  // videos
    warnings: string[];        // e.g. odd-dimension trim, AVI → MP4
  };
}
```

### Input → output types

| Input | `data` type |
|---|---|
| `Buffer` / `Uint8Array` | `Buffer` / `Uint8Array` |
| `ArrayBuffer` | `ArrayBuffer` |
| `Blob` / `File` | `Blob` (new MIME type) |
| `{ base64: string }` | `string` (base64) |
| `` `data:${string}` `` | data URL |
| `{ url: string }` | data URL |
| `{ path: string }` (Node) | `string`: path of the new file |

Plain strings are never guessed, because a path, a URL and a base64 string can't be told apart safely. Wrap them as `{ path }`, `{ url }` or `{ base64 }`. A `data:` URL is the one exception.

### `SecurityLimits` (defaults)

| Limit | Default |
|---|---|
| `maxImageBytes` | 25 MiB |
| `maxVideoBytes` | 500 MiB (Node) / 200 MiB (browser) |
| `maxDimension` | 8192 px |
| `maxPixels` | 8192 × 8192 |
| `maxAnimationFrames` | 1000 |
| `maxVideoDurationSeconds` | 600 |
| `fetchTimeoutMs` | 10 000 (per attempt) |
| `fetchRetries` | 3 |
| `maxRedirects` | 3 |
| `allowedPorts` | `[80, 443]` |
| `imageTimeoutMs` | 60 000 |
| `videoTimeoutMs` | 600 000 |

### Errors

Every error is an `OptimizerError` with an HTTP-compatible `code` and a `toJSON()` that returns `{ success: false, error, code }`.

| Class | Code | When |
|---|---|---|
| `ValidationError` | 400 | Bad options or malformed input |
| `SsrfBlockedError` | 403 | URL points at a private/internal address or disallowed port |
| `PathTraversalError` | 403 | Path escapes `allowedRoots`, or path inputs are disabled |
| `PayloadTooLargeError` | 413 | Byte limit exceeded |
| `DimensionLimitError` | 413 | Pixel, frame or duration limit exceeded |
| `UnsupportedMediaError` | 415 | Signature not on the allow-list (SVG, HEIC, playlists, text…) or doesn't match `mediaType` |
| `CorruptMediaError` | 422 | Recognized format but broken or truncated data |
| `FetchFailedError` | 502 | Download failed after retries (including browser CORS failures) |
| `QueueFullError` | 503 | Too many queued jobs; retry later |
| `ProcessingTimeoutError` | 504 | The job exceeded its time budget and was killed |
| `ProcessingError` | 500 | Unexpected encoder failure |

```ts
import { UnsupportedMediaError, DimensionLimitError } from 'image-video-compressor';

try {
  await optimizer.optimize(upload, { mediaType: 'image' });
} catch (err) {
  if (err instanceof UnsupportedMediaError) { /* tell the user to upload a real image */ }
  if (err instanceof DimensionLimitError) { /* too large */ }
}
```

## Security

| Threat | Protection |
|---|---|
| **Pixel / decompression bombs** | Width and height are read from the file header and checked **before** decoding. libvips gets a matching `limitInputPixels`. Total animation pixels are capped. Videos are checked with `ffprobe` (dimensions and duration) before any frame is decoded. |
| **Memory exhaustion** | Byte limits are enforced *before* buffering, using `Content-Length` plus a streaming counter, `fstat`, `blob.size`, and the base64 length. Videos in Node are streamed to disk, never held in RAM. |
| **SSRF** | Only http/https; no credentials in URLs; only ports 80/443. Every private, loopback, link-local, CGNAT, multicast and reserved range is blocked, in IPv4 and IPv6, including IPv4 hidden inside IPv6. **DNS pinning:** the connection goes to exactly the IP that was checked, which defeats DNS rebinding. Each redirect is checked again (max 3). 10 s timeout. Compressed transfer encodings are refused. |
| **ffmpeg exploits** | The demuxer is forced from our own signature check, so a playlist disguised as `.mp4` can never be opened as HLS or concat. Network protocols are disabled inside ffmpeg. Every argument comes from validated enums or numbers. |
| **Path traversal** | Off unless `allowedRoots` is set. NUL bytes and UNC/device paths are rejected. The path is checked before and after resolving symlinks and junctions, the file is opened once, and the open file is confirmed to be the one that was checked (TOCTOU-safe). |
| **MIME spoofing** | Extensions, `Content-Type` headers and data-URL MIME types are ignored; only magic numbers count. Formats outside the allow-list, including SVG, are rejected. |
| **Metadata / XSS payloads** | EXIF (including GPS), XMP, IPTC and comments are stripped. ICC profiles are converted to sRGB and then removed, so colours stay correct. Orientation is applied to the pixels first. Video metadata, chapters, subtitles, data streams and attachments are dropped. |
| **CPU exhaustion** | Separate bounded queues for images and videos (503 when full), per-job deadlines (ffmpeg is `SIGKILL`ed), and CPU threads split between concurrent jobs. |
| **Temp-file races and leaks** | Each job gets a private temp folder with UUID file names. It is removed in `finally` on success, failure and timeout, plus a sweep on process exit. |
| **Information leaks** | Clients only see safe messages. Internal errors become a generic 500 and are passed to your `onError` for logging. |

## What compression to expect

| Input | Settings | Typical saving |
|---|---|---|
| Camera / phone JPEG | `format: 'auto'`, quality 75–80 | 70–90% |
| Screenshot PNG | `format: 'webp'` or lossy `png` | 50–85% |
| Phone MP4 (high bitrate) | `crf: 28`, `preset: 'fast'` | 70–90% |
| Already-compressed web image or video | any | 0–30% |

- **Dimensions are preserved**, with one exception: H.264 needs even width and height, so odd sizes lose 1px, and this is reported in `details.warnings`. WebM/VP9 keeps odd sizes.
- If the output isn't smaller, you still get the **sanitized** re-encode, never the original bytes (which may carry metadata). `compressionRatio` is negative in that case, and `message` says so.
- `format: 'auto'` tries AVIF, WebP and (for JPEG input) mozjpeg, then keeps the smallest. AVIF is slower to encode; pick `'webp'` if speed matters more.

## FAQ

**Does it resize images?**
No. It keeps 100% of the original dimensions and saves space through modern codecs and quality settings. If you need thumbnails, resize before or after.

**Why are my file paths rejected with 403?**
Path inputs are off by default. Set `allowedRoots` in `createNodeOptimizer()`.

**Can I use it in serverless / Docker?**
Yes. Make sure `sharp`'s prebuilt binary matches the target platform, and that the optional `ffmpeg-static` package installed (or `ffmpeg` is on the `PATH`). In Next.js, use `runtime = 'nodejs'`.

**Which video formats come out?**
The container you sent: MP4 → MP4, MOV → MOV, WebM → WebM, MKV → MKV. AVI becomes MP4.

**Does anything get uploaded anywhere?**
No. All processing is local. The only network requests are the `{ url }` inputs you ask for, and loading ffmpeg.wasm in the browser (self-host it to avoid even that).

## License

[MIT](./LICENSE) © Yeasaleh

Created by **Yeasaleh**. Inspired by **Nurix hive Team**.
