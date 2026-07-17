/** Name-based addressing: unique experiment names resolve like ids, and always hash the id. */
import { describe, expect, it } from 'vitest';
import { Client } from '../src/client.js';
import type { RawConfig } from '../src/types.js';
import { RecordingTransport } from './doubles.js';

const CONFIG: RawConfig[] = [
  {
    id: 'exp_x',
    name: 'checkout-copy',
    salt: 's',
    bucket_count: 1000,
    version: 1,
    allocation: [
      { variant: 'control', weight: 50, prompt: 'Control prompt.' },
      { variant: 'treatment', weight: 50 },
    ],
  },
];

describe('name-based addressing', () => {
  it('assign by name matches assign by id (the hash runs on the canonical id)', async () => {
    const client = new Client({ apiKey: 'pk_test', transport: new RecordingTransport(CONFIG) });
    await client.refreshConfig('checkout-copy');
    for (const user of ['u-1', 'u-2', 'u-3', 'u-4']) {
      expect(client.assign('checkout-copy', user)).toBe(client.assign('exp_x', user));
    }
    await client.close();
  });

  it('tracked events normalize the name to the canonical id', async () => {
    const transport = new RecordingTransport(CONFIG);
    const client = new Client({ apiKey: 'pk_test', transport });
    await client.refreshConfig('checkout-copy');
    client.track('exposure', {
      experiment_id: 'checkout-copy',
      user_id: 'u-1',
      variant: 'control',
    });
    await client.flush();
    await client.close();
    expect(transport.sentEvents).toHaveLength(1);
    // The pipeline is keyed by the canonical id — the name must never reach ingest.
    expect(transport.sentEvents[0].experiment_id).toBe('exp_x');
  });
});
