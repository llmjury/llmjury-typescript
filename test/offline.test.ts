/**
 * Offline spill + replay (Node): events survive an outage and replay with their original
 * timestamps, bounded to a 24h age.
 */
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '../src/client.js';
import { FileOfflineStore } from '../src/offline.js';
import { FailingTransport, RecordingTransport } from './doubles.js';

const dirs: string[] = [];
function spillPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'llmjury-'));
  dirs.push(dir);
  return join(dir, 'spill.jsonl');
}

afterEach(() => {
  dirs.length = 0;
});

describe('FileOfflineStore', () => {
  it('load_replayable respects the 24h bound and preserves timestamps', async () => {
    let now = 1_000_000_000;
    const path = spillPath();
    const buf = new FileOfflineStore(path, { now: () => now });

    await buf.appendAll([{ type: 'exposure', event_id: 'old', timestamp: 'T-old' }]);
    now += 25 * 3600 * 1000; // 25h later — the old record is now past the bound
    await buf.appendAll([{ type: 'exposure', event_id: 'new', timestamp: 'T-new' }]);
    now += 1;

    const replay = await buf.loadReplayable();
    expect(replay.map((e) => e.event_id)).toEqual(['new']);
    // Original timestamp is preserved verbatim — replay is faithful.
    expect(replay[0].timestamp).toBe('T-new');
  });
});

describe('offline spill + replay across clients', () => {
  it('spills on a dead network and replays on the next client, then clears the file', async () => {
    const path = spillPath();

    // Client 1 cannot reach the network, so the event spills to the offline file.
    const c1 = new Client({
      apiKey: 'pk',
      transport: new FailingTransport(),
      offline: new FileOfflineStore(path),
      flushIntervalMs: 60_000,
    });
    c1.track('exposure', { experiment_id: 'e', user_id: 'u', variant: 'control' });
    await c1.flush();
    await c1.close();
    expect(existsSync(path)).toBe(true);

    // Client 2 has a working transport: on startup it replays the spilled event and clears the file.
    const working = new RecordingTransport();
    const c2 = new Client({
      apiKey: 'pk',
      transport: working,
      offline: new FileOfflineStore(path),
      flushIntervalMs: 60_000,
    });
    await c2.flush();
    await c2.close();

    expect(working.sentEvents.length).toBe(1);
    expect(working.sentEvents[0].type).toBe('exposure');
    expect(working.sentEvents[0].user_id).toBe('u');
    expect(existsSync(path)).toBe(false); // cleared after a successful replay
  });
});
