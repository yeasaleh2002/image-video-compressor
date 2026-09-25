/**
 * @file File-system jail for `{ path }` inputs and outputs.
 *
 * Path inputs are **disabled unless `allowedRoots` is configured** — secure by
 * default. When enabled, a path is accepted only if its *real* location (after
 * resolving `..`, symlinks and junctions) is inside one of the roots.
 *
 * TOCTOU: we open the file once and hand the resulting `FileHandle` to the
 * caller, then verify the handle's identity (dev+ino) matches the realpath we
 * checked. All later reads go through that handle, so swapping the path for a
 * symlink after the check has no effect.
 */
import { constants as fsc } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { PathTraversalError, ValidationError } from '../errors.js';

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Rejects NUL bytes, over-long values, UNC/device paths and non-strings. */
function assertSanePath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) throw new ValidationError('path must be a non-empty string');
  if (p.includes('\0')) throw new PathTraversalError('NUL byte in path');
  // Windows device namespace (\\?\, \\.\) and UNC shares can bypass normalisation.
  if (/^[\\/]{2}/.test(p)) throw new PathTraversalError('UNC and device paths are not allowed');
}

export class PathGuard {
  private readonly roots: Promise<string[]>;

  constructor(allowedRoots: string[] = []) {
    // Resolve roots to their real location once, so a symlinked root still works
    // and comparisons are like-for-like.
    this.roots = Promise.all(allowedRoots.map(async (r) => realpath(path.resolve(r))));
  }

  async enabled(): Promise<boolean> {
    return (await this.roots).length > 0;
  }

  /**
   * Resolves a user path against the jail. Relative paths are resolved against
   * the FIRST root (not `process.cwd()`), so `"a.jpg"` means `<root>/a.jpg`.
   */
  private async resolveCandidate(p: string): Promise<{ roots: string[]; candidate: string }> {
    const roots = await this.roots;
    if (roots.length === 0) throw new PathTraversalError('Path inputs are disabled (configure allowedRoots)');
    return { roots, candidate: path.resolve(roots[0]!, p) };
  }

  /** Opens a jailed regular file for reading. The caller owns (and must close) the handle. */
  async openForRead(p: unknown): Promise<{ handle: FileHandle; realPath: string; size: number }> {
    assertSanePath(p);
    const { roots, candidate } = await this.resolveCandidate(p);

    // Lexical check first: cheap, and gives a clean error for "../../etc/passwd".
    if (!roots.some((r) => isInside(r, candidate))) throw new PathTraversalError();

    let real: string;
    try { real = await realpath(candidate); } catch { throw new ValidationError('File not found'); }
    // Real check second: defeats symlinks / junctions pointing out of the jail.
    if (!roots.some((r) => isInside(r, real))) throw new PathTraversalError();

    // O_NOFOLLOW where the platform supports it (POSIX); Windows ignores the flag.
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

  /** Validates an output directory (must exist, be a directory, and be inside the jail). */
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
