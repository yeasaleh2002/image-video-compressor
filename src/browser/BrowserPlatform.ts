import type { EncodeResult, Ingested, Platform, Workspace } from '../adapters/types.js';
import { classifyInput } from '../core/inputKind.js';
import { decodeBase64, encodeBase64, parseDataUrl } from '../core/util.js';
import { ValidationError } from '../errors.js';
import { detectMedia } from '../security/magic.js';
import type { NormalizedOptions, SecurityGuard } from '../security/SecurityGuard.js';
import type { MediaInput } from '../types.js';
import { browserFetch } from './browserFetch.js';
import { CanvasImageAdapter } from './CanvasImageAdapter.js';
import { WasmFfmpegVideoAdapter, type WasmFfmpegConfig } from './WasmFfmpegVideoAdapter.js';

const NOOP_WORKSPACE: Workspace = {
  tempPath: () => { throw new Error('No file system in the browser'); },
  dispose: async () => {},
};

export class BrowserPlatform implements Platform {
  readonly image = new CanvasImageAdapter();
  readonly video: WasmFfmpegVideoAdapter;

  constructor(private readonly guard: SecurityGuard, ffmpeg: WasmFfmpegConfig = {}) {
    this.video = new WasmFfmpegVideoAdapter(ffmpeg);
  }

  async createWorkspace(): Promise<Workspace> {
    return NOOP_WORKSPACE;
  }

  async ingest(input: MediaInput, _ws: Workspace, _requested: NormalizedOptions['mediaType'], signal: AbortSignal): Promise<Ingested> {
    let bytes: Uint8Array;
    switch (classifyInput(input)) {
      case 'bytes': bytes = input as Uint8Array; break;
      case 'arraybuffer': bytes = new Uint8Array(input as ArrayBuffer); break;
      case 'blob': {
        const blob = input as Blob;
        this.guard.assertSize(blob.size, 'unknown');
        bytes = new Uint8Array(await blob.arrayBuffer());
        break;
      }
      case 'dataurl':
      case 'base64': {
        let b64: string;
        try {
          b64 = typeof input === 'string' ? parseDataUrl(input).base64 : (input as { base64: string }).base64;
        } catch (e) { throw new ValidationError((e as Error).message); }
        this.guard.assertBase64Size(b64.length);
        try { bytes = decodeBase64(b64); } catch { throw new ValidationError('Invalid base64 payload'); }
        break;
      }
      case 'url': bytes = await browserFetch((input as { url: string }).url, this.guard, signal); break;
      case 'path': throw new ValidationError('{ path } inputs are only supported in Node.js');
    }
    this.guard.assertSize(bytes.byteLength, 'unknown');
    return { source: { type: 'bytes', bytes }, size: bytes.byteLength, detected: detectMedia(bytes) };
  }

  async emit(input: MediaInput, result: EncodeResult): Promise<unknown> {
    if (result.output.type !== 'bytes') throw new Error('Browser adapters must return bytes');
    const bytes = result.output.bytes;
    switch (classifyInput(input)) {
      case 'bytes': return bytes;
      case 'arraybuffer': return bytes.slice().buffer;
      case 'blob': return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: result.mime });
      case 'base64': return encodeBase64(bytes);
      case 'dataurl':
      case 'url': return `data:${result.mime};base64,${encodeBase64(bytes)}`;
      default: throw new ValidationError('Unsupported input');
    }
  }
}
