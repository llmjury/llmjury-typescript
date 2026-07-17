/** `track`/`assign` must never block or throw into the host app, even with a dead network. */
import { describe, expect, it } from 'vitest';

import { Client } from '../src/client.js';
import { FailingTransport, RecordingTransport } from './doubles.js';

describe('non-blocking, no-throw client', () => {
  it('track never throws and drops on failure (no offline store)', async () => {
    const client = new Client({
      apiKey: 'pk_test',
      transport: new FailingTransport(),
      flushIntervalMs: 60_000,
    });

    // A failing transport must not surface as an exception in the caller's path.
    const started = Date.now();
    for (let i = 0; i < 50; i += 1) {
      client.track('exposure', { experiment_id: 'exp', user_id: `u${i}`, variant: 'control' });
    }
    // 50 enqueue calls return effectively instantly — no network on the hot path.
    expect(Date.now() - started).toBeLessThan(200);

    await client.flush();
    await client.close();
    // No offline store configured, so after exhausted retries the batch is dropped — not thrown.
    expect(client.dropped).toBe(50);
  });

  it('assign returns null and never throws without config', async () => {
    const client = new Client({ apiKey: 'pk_test', transport: new FailingTransport() });
    expect(client.assign('exp', 'user')).toBeNull();
    await client.close();
  });

  it('assign resolves deterministically from polled config', async () => {
    const config = [
      {
        id: 'exp_x',
        salt: 's',
        bucket_count: 1000,
        version: 3,
        allocation: [
          { variant: 'control', weight: 50 },
          { variant: 'treatment', weight: 50 },
        ],
      },
    ];
    const client = new Client({ apiKey: 'pk_test', transport: new RecordingTransport(config) });
    expect(await client.refreshConfig('exp_x')).toBe(true);

    const variant = client.assign('exp_x', 'user-0');
    expect(variant === 'control' || variant === 'treatment').toBe(true);
    // Deterministic: same inputs, same variant.
    expect(client.assign('exp_x', 'user-0')).toBe(variant);
    await client.close();
  });
});
