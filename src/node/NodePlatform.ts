/**
 * @file Node runtime: ingestion (buffers, base64, jailed paths, SSRF-safe
 * URLs), shape-preserving output, and adapter wiring.
 */
import { constants as fsc, createWriteStream } from 'node:fs';
import { copyFile, open, readFile, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { EncodeResult, Ingested, MediaSource, Platform, Workspace } from '../adapters/types.js';
import { classifyInput, extFor } from '../core/inputKind.js';
import { decodeBase64, encodeBase64, parseDataUrl, uuid } from '../core/util.js';
import { PayloadTooLargeError, ValidationError } from '../errors.js';
import { detectMedia, SNIFF_BYTES } from '../security/magic.js';
import type { NormalizedOptions, SecurityGuard } from '../security/SecurityGuard.js';
import type { MediaInput } from '../types.js';
import { FluentFfmpegVideoAdapter, type FfmpegBinaries } from './FluentFfmpegVideoAdapter.js';
import { PathGuard } from './pathGuard.js';
import { safeDownload } from './safeFetch.js';
import { SharpImageAdapter } from './SharpImageAdapter.js';
import { createNodeWorkspace } from './workspace.js';

export interface NodePlatformConfig extends FfmpegBinaries {
  /** Directories `{ path }` inputs may read from. Empty (default) = path inputs disabled. */
  allowedRoots?: string[];
  /** Where optimized files for `{ path }` inputs are written. Default: next to the input. Must be inside `allowedRoots`. */
  outputDir?: string;
  /** Base for per-job temp dirs. Default `os.tmpdir()`. */
  tempDir?: string;
  maxVideoJobs: number;
}

export class NodePlatform implements Platform {
  readonly image = new SharpImageAdapter();
  readonly video: FluentFfmpegVideoAdapter;
  private readonly paths: PathGuard;
  /** Real path of a `{ path }` input, per job, so `emit` can place the output next to it. */
  private readonly origins = new WeakMap<Workspace, string>();

  constructor(private readonly guard: SecurityGuard, private readonly config: NodePlatformConfig) {
    this.video = new FluentFfmpegVideoAdapter(config, config.maxVideoJobs);
    this.paths = new PathGuard(config.allowedRoots);
  }

  createWorkspace(): Promise<Workspace> {
    return createNodeWorkspace(this.config.tempDir);
  }

  /* --------------------------------------------------------------------- */
  /* Ingestion                                                             */
  /* --------------------------------------------------------------------- */

  async ingest(input: MediaInput, ws: Workspace, _requested: NormalizedOptions['mediaType'], signal: AbortSignal): Promise<Ingested> {
    switch (classifyInput(input)) {
      case 'bytes': return this.fromBytes(input as Uint8Array, ws);
      case 'arraybuffer': return this.fromBytes(new Uint8Array(input as ArrayBuffer), ws);
      case 'blob': {
        const blob = input as Blob;
        this.guard.assertSize(blob.size, 'unknown'); // before arrayBuffer() allocates
        return this.fromBytes(new Uint8Array(await blob.arrayBuffer()), ws);
      }
      case 'dataurl': {
        let parsed;
        try { parsed = parseDataUrl(input as string); } catch (e) { throw new ValidationError((e as Error).message); }
        return this.fromBase64(parsed.base64, ws); // the declared MIME is ignored: magic numbers decide
      }
      case 'base64': return this.fromBase64((input as { base64: string }).base64, ws);
      case 'path': {
        const { handle, realPath, size } = await this.paths.openForRead((input as { path: string }).path);
        this.origins.set(ws, realPath);
        try {
          return await this.fromHandle(handle, size, ws, false);
        } finally {
          await handle.close();
        }
      }
      case 'url': {
        const dest = ws.tempPath('download');
        const size = await safeDownload((input as { url: string }).url, this.guard, dest, signal);
        const handle = await open(dest, 'r');
        try {
          return await this.fromHandle(handle, size, ws, dest);
        } finally {
          await handle.close();
        }
      }
    }
  }

  private fromBase64(b64: string, ws: Workspace): Promise<Ingested> {
    this.guard.assertBase64Size(b64.length); // before decoding
    let bytes: Uint8Array;
    try { bytes = decodeBase64(b64); } catch { throw new ValidationError('Invalid base64 payload'); }
    return this.fromBytes(bytes, ws);
  }

  private async fromBytes(bytes: Uint8Array, ws: Workspace): Promise<Ingested> {
    this.guard.assertSize(bytes.byteLength, 'unknown');
    const detected = detectMedia(bytes);
    if (detected.kind === 'image') return { source: { type: 'bytes', bytes }, size: bytes.byteLength, detected };
    // Videos go to disk so ffmpeg can seek; the caller's buffer is already in memory anyway.
    const file = ws.tempPath(detected.format);
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    return { source: { type: 'file', path: file, size: bytes.byteLength }, size: bytes.byteLength, detected };
  }

  /**
   * Common path for file-backed input. Reads only the header first, so the
   * per-kind size limit is enforced *before* a large image is buffered.
   *
   * @param inWorkspace The file's path if it already lives in the workspace
   *                    (URL download), or `false` if it must be copied in.
   */
  private async fromHandle(handle: FileHandle, size: number, ws: Workspace, inWorkspace: string | false): Promise<Ingested> {
    this.guard.assertSize(size, 'unknown');
    const head = new Uint8Array(Math.min(size, SNIFF_BYTES));
    await handle.read(head, 0, head.length, 0);
    const kind = detectMedia(head, { dimensions: false }).kind;
    this.guard.assertSize(size, kind);

    if (kind === 'image') {
      const bytes = await handle.readFile();
      if (bytes.length !== size) throw new ValidationError('File changed while being read');
      return { source: { type: 'bytes', bytes }, size, detected: detectMedia(bytes) };
    }

    const detected = detectMedia(head);
    let source: MediaSource;
    if (inWorkspace) {
      source = { type: 'file', path: inWorkspace, size };
    } else {
      // Copy through the already-validated handle (never re-open the user path),
      // streaming with a hard byte cap in case the file grows mid-copy.
      const file = ws.tempPath(detected.format);
      let copied = 0;
      const max = this.guard.maxBytesFor('video');
      await pipeline(
        handle.createReadStream({ start: 0, autoClose: false }),
        new Transform({
          transform(chunk: Buffer, _e, cb) {
            copied += chunk.length;
            cb(copied > max ? new PayloadTooLargeError('File grew beyond the limit while copying') : null, chunk);
          },
        }),
        createWriteStream(file, { flags: 'wx', mode: 0o600 }),
      );
      source = { type: 'file', path: file, size: copied };
    }
    return { source, size, detected };
  }

  /* --------------------------------------------------------------------- */
  /* Output (same container as input)                                      */
  /* --------------------------------------------------------------------- */

  async emit(input: MediaInput, result: EncodeResult, ws: Workspace): Promise<unknown> {
    const kind = classifyInput(input);
    if (kind === 'path') return this.emitToPath(result, ws);

    const bytes = result.output.type === 'bytes' ? result.output.bytes : await readFile(result.output.path);
    switch (kind) {
      case 'bytes': return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      case 'arraybuffer': return bytes.slice().buffer;
      case 'blob': return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: result.mime });
      case 'base64': return encodeBase64(bytes);
      case 'dataurl':
      case 'url': return `data:${result.mime};base64,${encodeBase64(bytes)}`;
    }
  }

  /** Writes next to the input (or to `outputDir`) under a collision-free name; never overwrites. */
  private async emitToPath(result: EncodeResult, ws: Workspace): Promise<string> {
    const origin = this.origins.get(ws);
    if (!origin) throw new Error('Missing input origin for path output');
    const dir = this.config.outputDir ? await this.paths.resolveOutputDir(this.config.outputDir) : path.dirname(origin);
    // Sanitise the stem: it came from the user's filename.
    const stem = path.basename(origin, path.extname(origin)).replace(/[^\w.-]+/g, '_').slice(0, 100) || 'media';
    const dest = path.join(dir, `${stem}-optimized-${uuid().slice(0, 8)}.${extFor(result.format)}`);

    if (result.output.type === 'file') {
      await copyFile(result.output.path, dest, fsc.COPYFILE_EXCL);
    } else {
      await writeFile(dest, result.output.bytes, { flag: 'wx' });
    }
    return dest;
  }
}
