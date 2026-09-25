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

  async run<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.queue.length >= this.maxQueue) throw new QueueFullError();
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }

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
