/**
 * @file A bounded FIFO concurrency limiter with backpressure and timeouts.
 *
 * Why not just `p-limit`? We need two things it doesn't give us:
 *  - **Bounded queue.** An unbounded queue turns a traffic spike into an OOM
 *    (every waiting job holds its input buffer). When the queue is full we
 *    reject immediately with 503 so load balancers / clients back off.
 *  - **Per-job deadline + abort.** A job that exceeds its budget gets its
 *    AbortSignal fired, which adapters wire to `ffmpeg.kill('SIGKILL')` or
 *    the WASM `terminate()`, so a hostile file can't pin a CPU forever.
 */
import { ProcessingTimeoutError, QueueFullError } from '../errors.js';

export interface LimiterStats { active: number; queued: number; }

export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueue: number,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new RangeError('maxConcurrent must be >= 1');
    if (!Number.isInteger(maxQueue) || maxQueue < 0) throw new RangeError('maxQueue must be >= 0');
  }

  get stats(): LimiterStats {
    return { active: this.active, queued: this.queue.length };
  }

  /**
   * Runs `task` once a slot is free.
   *
   * @param task      Receives an AbortSignal that fires on timeout. It MUST stop
   *                  work (kill child processes, etc.) when the signal fires.
   * @param timeoutMs Budget measured from when the task *starts*, not from
   *                  when it was queued.
   */
  async run<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.queue.length >= this.maxQueue) throw new QueueFullError();
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    // Slot ownership was transferred to us by release() (or taken directly above).
    this.active++;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new ProcessingTimeoutError());
        reject(new ProcessingTimeoutError());
      }, timeoutMs);
    });

    try {
      return await Promise.race([task(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
      this.release();
    }
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
