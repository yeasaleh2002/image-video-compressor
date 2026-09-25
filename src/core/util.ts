export function uuid(): string {
  return globalThis.crypto.randomUUID();
}

export function compressionRatio(original: number, optimized: number): string {
  if (original <= 0) return '0.0%';
  return `${(((original - optimized) / original) * 100).toFixed(1)}%`;
}

export function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new TypeError('Invalid base64');
  const B = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer;
  if (B) return B.from(clean, 'base64');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeBase64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(e: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString('base64');
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function parseDataUrl(s: string): { mime: string; base64: string } {
  const comma = s.indexOf(',');
  const header = comma > 0 ? s.slice(5, comma) : '';
  if (!s.startsWith('data:') || comma < 0 || !/;base64$/i.test(header)) {
    throw new TypeError('Only base64 data URLs are supported');
  }
  return { mime: header.replace(/;base64$/i, ''), base64: s.slice(comma + 1) };
}
