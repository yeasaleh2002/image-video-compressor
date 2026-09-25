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
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    live.clear();
  };
  process.once('exit', sweep);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
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
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        live.delete(dir);
      } catch {}
    },
  };
}
