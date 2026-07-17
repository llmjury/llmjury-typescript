/** `getPrompt`: variant prompt when configured, the in-code default on any failure path. */
import { describe, expect, it } from 'vitest';
import { Client } from '../src/client.js';
import type { RawConfig } from '../src/types.js';
import { FailingTransport, RecordingTransport } from './doubles.js';

const DEFAULT = 'You are a helpful assistant.';

const CONFIG: RawConfig[] = [
  {
    id: 'exp_p',
    salt: 's',
    bucket_count: 1000,
    version: 1,
    allocation: [
      { variant: 'control', weight: 50, prompt: 'Control prompt.' },
      { variant: 'treatment', weight: 50, prompt: 'Treatment prompt.' },
    ],
  },
];

describe('getPrompt', () => {
  it('returns the assigned variant prompt when configured', async () => {
    const client = new Client({ apiKey: 'pk_test', transport: new RecordingTransport(CONFIG) });
    await client.refreshConfig('exp_p');
    const result = client.getPrompt('exp_p', 'user-0', DEFAULT);
    expect(['control', 'treatment']).toContain(result.variant);
    expect(result.fallback).toBe(false);
    expect(result.prompt).toBe(
      result.variant === 'control' ? 'Control prompt.' : 'Treatment prompt.',
    );
    await client.close();
  });

  it('falls back to the in-code default when LLMJury is unreachable', async () => {
    const client = new Client({ apiKey: 'pk_test', transport: new FailingTransport() });
    const result = client.getPrompt('exp_p', 'user-0', DEFAULT);
    expect(result.variant).toBeNull();
    expect(result.fallback).toBe(true);
    expect(result.prompt).toBe(DEFAULT);
    await client.close();
  });

  it('falls back to the default when the variant has no configured prompt', async () => {
    const promptless: RawConfig[] = [
      {
        id: 'exp_np',
        salt: 's',
        bucket_count: 1000,
        version: 1,
        allocation: [
          { variant: 'control', weight: 50 },
          { variant: 'treatment', weight: 50 },
        ],
      },
    ];
    const client = new Client({ apiKey: 'pk_test', transport: new RecordingTransport(promptless) });
    await client.refreshConfig('exp_np');
    const result = client.getPrompt('exp_np', 'user-0', DEFAULT);
    expect(['control', 'treatment']).toContain(result.variant); // assignment still works
    expect(result.fallback).toBe(true);
    expect(result.prompt).toBe(DEFAULT);
    await client.close();
  });
});
