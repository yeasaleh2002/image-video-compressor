/**
 * @file Classifies a `MediaInput` without ever guessing what a bare string is.
 */
import { ValidationError } from '../errors.js';
import type { MediaInput } from '../types.js';

export type InputKind = 'bytes' | 'arraybuffer' | 'blob' | 'dataurl' | 'base64' | 'url' | 'path';

function isTagged<K extends string>(v: unknown, key: K): v is Record<K, string> {
  return typeof v === 'object' && v !== null && Object.keys(v).length === 1
    && typeof (v as Record<string, unknown>)[key] === 'string';
}

export function classifyInput(input: MediaInput): InputKind {
  if (input instanceof Uint8Array) return 'bytes';
  if (input instanceof ArrayBuffer) return 'arraybuffer';
  if (typeof Blob !== 'undefined' && input instanceof Blob) return 'blob';
  if (typeof input === 'string') {
    if (input.startsWith('data:')) return 'dataurl';
    throw new ValidationError('String inputs must be tagged: { base64 }, { url } or { path } (or a data: URL)');
  }
  if (isTagged(input, 'base64')) return 'base64';
  if (isTagged(input, 'url')) return 'url';
  if (isTagged(input, 'path')) return 'path';
  throw new ValidationError('Unsupported input: pass a Buffer/Uint8Array, ArrayBuffer, Blob, data: URL, { base64 }, { url } or { path }');
}

/** File extension for an output format. */
export function extFor(format: string): string {
  return format === 'jpeg' ? 'jpg' : format;
}
