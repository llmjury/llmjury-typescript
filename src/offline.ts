/**
 * Durable offline spill buffer for telemetry events.
 *
 * When the in-memory {@link EventBuffer} exhausts its network retries it spills the batch here
 * instead of dropping it, so events survive a process restart or an extended outage. On the next
 * client start the events are replayed with their **original** timestamps. Replay is bounded to a
 * 24h age — anything older is discarded so a stale store can never
 * flood the backend with ancient data.
 *
 * Two implementations mirror the two runtimes the SDK targets:
 *
 * * {@link FileOfflineStore} — Node: newline-delimited JSON file, each line
 *   `{ "event": <event>, "savedAt": <epochMs> }`. The event's own `timestamp` is left untouched.
 * * {@link IndexedDbOfflineStore} — browser: one IndexedDB object store keyed by an autoincrement
 *   id, each record `{ event, savedAt }`.
 *
 * Both never throw into the caller — I/O failures are logged and swallowed (an SDK must never
 * throw into the host app).
 */

import type { Logger } from './logger.js';
import { consoleLogger } from './logger.js';
import type { TrackEvent } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A spilled record: the original event plus the wall-clock time it was persisted. */
export interface OfflineRecord {
  event: TrackEvent;
  savedAt: number;
}

/** Storage boundary the buffer spills to. Inject a fake in tests; swap File/IndexedDB per runtime. */
export interface OfflineStore {
  /** Append events, stamping each with the current wall-clock time. Never throws. */
  appendAll(events: TrackEvent[]): Promise<void>;
  /** Return events younger than the 24h bound, in original order, with original timestamps. */
  loadReplayable(): Promise<TrackEvent[]>;
  /** Remove all spilled records (called after a successful replay). */
  clear(): Promise<void>;
}

interface OfflineOptions {
  maxAgeMs?: number;
  now?: () => number;
  logger?: Logger;
}

function replayable(records: OfflineRecord[], now: number, maxAgeMs: number): TrackEvent[] {
  const cutoff = now - maxAgeMs;
  const out: TrackEvent[] = [];
  for (const record of records) {
    if (record && typeof record.savedAt === 'number' && record.savedAt >= cutoff) {
      out.push(record.event);
    }
  }
  return out;
}

/** Node file-backed spill+replay buffer (newline-delimited JSON). */
export class FileOfflineStore implements OfflineStore {
  private readonly path: string;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(path: string, options: OfflineOptions = {}) {
    this.path = path;
    this.maxAgeMs = options.maxAgeMs ?? DAY_MS;
    this.now = options.now ?? Date.now;
    this.log = options.logger ?? consoleLogger;
  }

  async appendAll(events: TrackEvent[]): Promise<void> {
    if (events.length === 0) return;
    const savedAt = this.now();
    try {
      const fs = await import('node:fs/promises');
      const pathMod = await import('node:path');
      const dir = pathMod.dirname(this.path);
      if (dir) await fs.mkdir(dir, { recursive: true });
      const lines = events.map((event) => JSON.stringify({ event, savedAt })).join('\n') + '\n';
      await fs.appendFile(this.path, lines, 'utf8');
    } catch (err) {
      this.log.warn(`llmjury: failed to persist ${events.length} offline events: ${String(err)}`);
    }
  }

  async loadReplayable(): Promise<TrackEvent[]> {
    let content: string;
    try {
      const fs = await import('node:fs/promises');
      content = await fs.readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      this.log.warn(`llmjury: failed to read offline buffer: ${String(err)}`);
      return [];
    }
    const records: OfflineRecord[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as OfflineRecord);
      } catch {
        continue; // tolerate a torn final line from a crash mid-write.
      }
    }
    return replayable(records, this.now(), this.maxAgeMs);
  }

  async clear(): Promise<void> {
    try {
      const fs = await import('node:fs/promises');
      await fs.rm(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      this.log.warn(`llmjury: failed to clear offline buffer: ${String(err)}`);
    }
  }
}

/** Browser IndexedDB-backed spill+replay buffer. */
export class IndexedDbOfflineStore implements OfflineStore {
  private readonly dbName: string;
  private readonly storeName = 'events';
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(dbName = 'llmjury-offline', options: OfflineOptions = {}) {
    this.dbName = dbName;
    this.maxAgeMs = options.maxAgeMs ?? DAY_MS;
    this.now = options.now ?? Date.now;
    this.log = options.logger ?? consoleLogger;
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async appendAll(events: TrackEvent[]): Promise<void> {
    if (events.length === 0) return;
    const savedAt = this.now();
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        for (const event of events) store.add({ event, savedAt });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch (err) {
      this.log.warn(`llmjury: failed to persist ${events.length} offline events: ${String(err)}`);
    }
  }

  async loadReplayable(): Promise<TrackEvent[]> {
    try {
      const db = await this.open();
      const records = await new Promise<OfflineRecord[]>((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readonly');
        const request = tx.objectStore(this.storeName).getAll();
        request.onsuccess = () => resolve(request.result as OfflineRecord[]);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return replayable(records, this.now(), this.maxAgeMs);
    } catch (err) {
      this.log.warn(`llmjury: failed to read offline buffer: ${String(err)}`);
      return [];
    }
  }

  async clear(): Promise<void> {
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch (err) {
      this.log.warn(`llmjury: failed to clear offline buffer: ${String(err)}`);
    }
  }
}

/**
 * Pick the right offline store for the current runtime: IndexedDB in a browser, a file in Node.
 * Returns `undefined` when neither is available (so the buffer falls back to drop-on-failure).
 */
export function defaultOfflineStore(
  fileNameOrPath: string,
  options: OfflineOptions = {},
): OfflineStore | undefined {
  if (typeof indexedDB !== 'undefined') {
    return new IndexedDbOfflineStore(fileNameOrPath, options);
  }
  if (typeof process !== 'undefined' && process.versions?.node) {
    return new FileOfflineStore(fileNameOrPath, options);
  }
  return undefined;
}
