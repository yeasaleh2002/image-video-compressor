/**
 * @file Per-job temp workspace.
 *
 * Each job gets its own `mkdtemp` directory (random suffix, mode 0700 on
 * POSIX) and files inside are named with v4 UUIDs, so concurrent jobs can
 * never collide or read each other's files. `dispose()` removes the whole
 * directory; it runs in the optimizer's `finally`, so cleanup happens on
 * success, failure, and timeout alike.
 *
 * A process-level registry also removes any directories still alive on
 * `exit` / SIGINT / SIGTERM — the last line of defence if a job is
 * interrupted mid-flight.
 */
import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Workspace } from '../adapters/types.js';
import { uuid } from '../core/util.js';

const live = new Set<string>();
let hooksInstalled = false;

function installExitHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const sweep = () => {
    for (const dir of live) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    live.clear();
  };
  process.once('exit', sweep);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    // Only take over the signal if nobody else handles it, so we don't change
    // the host app's shutdown semantics.
    if (process.listenerCount(sig) === 0) {
      process.once(sig, () => { sweep(); process.kill(process.pid, sig); });
    }
  }
}

export async function createNodeWorkspace(baseDir = os.tmpdir()): Promise<Workspace> {
  installExitHooks();
  const dir = await mkdtemp(path.join(baseDir, 'smo-'));
  live.add(dir);
  let disposed = false;
  return {
    tempPath: (ext: string) => path.join(dir, `${uuid()}.${ext.replace(/[^a-z0-9]/gi, '')}`),
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        // maxRetries covers Windows EBUSY while ffmpeg is still releasing handles.
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        live.delete(dir);
      } catch { /* left in live: the exit hook will retry */ }
    },
  };
}
