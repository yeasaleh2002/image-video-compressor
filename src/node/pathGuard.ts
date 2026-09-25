import { constants as fsc } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { PathTraversalError, ValidationError } from '../errors.js';

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertSanePath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) throw new ValidationError('path must be a non-empty string');
  if (p.includes('\0')) throw new PathTraversalError('NUL byte in path');
  if (/^[\\/]{2}/.test(p)) throw new PathTraversalError('UNC and device paths are not allowed');
}

export class PathGuard {
  private readonly roots: Promise<string[]>;

  constructor(allowedRoots: string[] = []) {
    this.roots = Promise.all(allowedRoots.map(async (r) => realpath(path.resolve(r))));
  }

  async enabled(): Promise<boolean> {
    return (await this.roots).length > 0;
  }

  private async resolveCandidate(p: string): Promise<{ roots: string[]; candidate: string }> {
    const roots = await this.roots;
    if (roots.length === 0) throw new PathTraversalError('Path inputs are disabled (configure allowedRoots)');
    return { roots, candidate: path.resolve(roots[0]!, p) };
  }

  async openForRead(p: unknown): Promise<{ handle: FileHandle; realPath: string; size: number }> {
    assertSanePath(p);
    const { roots, candidate } = await this.resolveCandidate(p);

    if (!roots.some((r) => isInside(r, candidate))) throw new PathTraversalError();

    let real: string;
    try { real = await realpath(candidate); } catch { throw new ValidationError('File not found'); }

    if (!roots.some((r) => isInside(r, real))) throw new PathTraversalError();

    const flags = fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0);
    const handle = await open(real, flags);
    try {
      const [st, pathSt] = await Promise.all([handle.stat(), stat(real)]);
      if (!st.isFile()) throw new ValidationError('Path is not a regular file');
      if (st.dev !== pathSt.dev || st.ino !== pathSt.ino) throw new PathTraversalError('File changed during validation');
      return { handle, realPath: real, size: st.size };
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  async resolveOutputDir(dir: string): Promise<string> {
    assertSanePath(dir);
    const { roots, candidate } = await this.resolveCandidate(dir);
    let real: string;
    try { real = await realpath(candidate); } catch { throw new ValidationError('Output directory not found'); }
    if (!roots.some((r) => isInside(r, real))) throw new PathTraversalError('Output directory is outside the allowed directories');
    if (!(await stat(real)).isDirectory()) throw new ValidationError('Output path is not a directory');
    return real;
  }
}
