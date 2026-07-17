/**
 * In-memory, background-flushed event buffer.
 *
 * `track` must never block or throw into the host app's call path. JavaScript is
 * single-threaded, so instead of a daemon thread the buffer flushes from a timer (default every 1s)
 * or when it reaches a size threshold (default 1000). The public {@link EventBuffer.add} only pushes
 * onto an array and returns synchronously; all network I/O is `void`-ed off so a rejected flush can
 * never surface in the caller. A flush retries a bounded number of times and then either spills to
 * the {@link OfflineStore} (if configured) or drops the batch with a log line.
 */

import type { Logger } from './logger.js';
import { consoleLogger } from './logger.js';
import type { OfflineStore } from './offline.js';
import type { TrackEvent } from './types.js';

/** A sender takes a batch and resolves on success; it rejects on a failed send so the buffer retries. */
export type Sender = (batch: TrackEvent[]) => Promise<void>;

export interface EventBufferOptions {
  flushIntervalMs?: number;
  flushSize?: number;
  maxBuffered?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  offline?: OfflineStore;
  logger?: Logger;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class EventBuffer {
  private readonly sender: Sender;
  private readonly flushIntervalMs: number;
  private readonly flushSize: number;
  private readonly maxBuffered: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly offline?: OfflineStore;
  private readonly log: Logger;

  private queue: TrackEvent[] = [];
  private droppedCount = 0;
  private flushing = false;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly replayPromise: Promise<void>;

  constructor(sender: Sender, options: EventBufferOptions = {}) {
    this.sender = sender;
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.flushSize = options.flushSize ?? 1000;
    this.maxBuffered = options.maxBuffered ?? 100_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBackoffMs = options.retryBackoffMs ?? 200;
    this.offline = options.offline;
    this.log = options.logger ?? consoleLogger;

    // Replay anything spilled by a previous run before we accept new events; flush() awaits this.
    this.replayPromise = this.replayOffline();

    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // Don't keep a Node process alive just for the flush timer (no-op in the browser).
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Total events dropped (buffer overflow or exhausted retries with no offline store). */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Enqueue an event. Non-blocking; never throws. Drops the oldest event on overflow. */
  add(event: TrackEvent): void {
    if (this.closed) return;
    if (this.queue.length >= this.maxBuffered) {
      this.queue.shift();
      this.droppedCount += 1;
      this.log.warn(`llmjury: event buffer full (${this.maxBuffered}); dropping oldest`);
    }
    this.queue.push(event);
    if (this.queue.length >= this.flushSize) {
      void this.flush();
    }
  }

  /** Drain the buffer. Resolves once nothing is left to send (best-effort under concurrency). */
  async flush(): Promise<void> {
    await this.replayPromise;
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.flushSize);
        await this.sendWithRetry(batch);
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Stop the flush timer after a final drain. Safe to call more than once. */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.flush();
  }

  private async replayOffline(): Promise<void> {
    if (!this.offline) return;
    try {
      const events = await this.offline.loadReplayable();
      if (events.length > 0) this.queue.unshift(...events);
      await this.offline.clear();
    } catch (err) {
      this.log.warn(`llmjury: offline replay failed: ${String(err)}`);
    }
  }

  private async sendWithRetry(batch: TrackEvent[]): Promise<void> {
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        await this.sender(batch);
        return;
      } catch (err) {
        if (attempt + 1 < this.maxRetries) {
          await sleep(this.retryBackoffMs * (attempt + 1));
          continue;
        }
        this.log.warn(
          `llmjury: flush of ${batch.length} events failed after ${this.maxRetries} attempts: ${String(err)}`,
        );
      }
    }
    if (this.offline) {
      await this.offline.appendAll(batch);
    } else {
      this.droppedCount += batch.length;
    }
  }
}
