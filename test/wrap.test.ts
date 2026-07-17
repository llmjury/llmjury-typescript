/** Setup-once wrap(): provider calls traced with zero call-site code; variables from memory. */
import { describe, expect, it } from 'vitest';
import { Client } from '../src/client.js';
import type { RawConfig } from '../src/types.js';
import { RecordingTransport } from './doubles.js';

const CONFIG: RawConfig[] = [
  {
    id: 'exp_w',
    name: 'wrap-demo',
    salt: 's',
    bucket_count: 1000,
    version: 1,
    allocation: [
      {
        variant: 'control',
        weight: 50,
        prompt: 'Control prompt.',
        variables: { model: 'claude-haiku-4-5', temperature: '0.2' },
      },
      {
        variant: 'treatment',
        weight: 50,
        prompt: 'Treatment prompt.',
        variables: { model: 'claude-sonnet-5', temperature: '0.7' },
      },
    ],
  },
];

const anthropicShaped = (model: string) => ({
  model,
  usage: { input_tokens: 40, output_tokens: 70 },
  content: [{ text: 'a reply' }],
});

function fakeProvider() {
  return {
    messages: {
      create: async (options: { model: string; messages: unknown[] }) =>
        anthropicShaped(options.model),
    },
    close: () => 'closed',
  };
}

async function readyClient(): Promise<{ client: Client; transport: RecordingTransport }> {
  const transport = new RecordingTransport(CONFIG);
  const client = new Client({ apiKey: 'pk_test', transport });
  await client.refreshConfig('wrap-demo');
  return { client, transport };
}

describe('wrap', () => {
  it('traces wrapped model calls with no call-site code', async () => {
    const { client, transport } = await readyClient();
    const llm = client.wrap(fakeProvider(), 'wrap-demo');

    const v = client.getVariables('wrap-demo', 'u-1', { model: 'fallback-model' });
    const response = await client.withUser('u-1', () =>
      llm.messages.create({ model: v.values.model, messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(response.content[0].text).toBe('a reply');

    await client.flush();
    await client.close();
    expect(transport.sentEvents.map((e) => e.type)).toEqual(['exposure', 'model_call']);
    const modelCall = transport.sentEvents[1];
    expect(modelCall.experiment_id).toBe('exp_w');
    expect(modelCall.variant).toBe(v.variant);
    expect(modelCall.tokens_output).toBe(70);
    expect(modelCall.prompt).toBe('hi');
    expect(modelCall.model).toBe(v.values.model);
  });

  it('passes through non-model and userless calls untracked', async () => {
    const { client, transport } = await readyClient();
    const llm = client.wrap(fakeProvider(), 'wrap-demo');

    await llm.messages.create({ model: 'm', messages: [] }); // no ambient user
    await client.withUser('u-1', () => llm.close()); // not a model call
    await client.flush();
    await client.close();
    expect(transport.sentEvents).toEqual([]);
  });

  it('records errors and re-throws', async () => {
    const { client, transport } = await readyClient();
    const exploding = {
      create: async (_request: unknown) => {
        throw new Error('provider timeout');
      },
    };
    const llm = client.wrap(exploding, 'wrap-demo');
    await expect(
      client.withUser('u-err', () =>
        llm.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      ),
    ).rejects.toThrow('provider timeout');
    await client.flush();
    await client.close();
    const modelCall = transport.sentEvents.at(-1)!;
    expect(modelCall.type).toBe('model_call');
    expect((modelCall.metadata as Record<string, unknown>).error).toBe(true);
  });
});

describe('getVariables', () => {
  it('merges the variant variables over defaults from client memory', async () => {
    const { client, transport } = await readyClient();
    const v = client.getVariables('wrap-demo', 'u-1', { model: 'fallback', top_p: '1.0' });
    expect(v.fallback).toBe(false);
    expect(['claude-haiku-4-5', 'claude-sonnet-5']).toContain(v.values.model); // configured wins
    expect(v.values.top_p).toBe('1.0'); // default preserved
    expect(['Control prompt.', 'Treatment prompt.']).toContain(v.values.prompt);
    expect(transport.configCalls).toBe(1); // resolved from memory — no extra API call
    await client.close();
  });

  it('falls back to defaults when the config is unreachable', async () => {
    const client = new Client({ apiKey: 'pk_test', transport: new RecordingTransport() });
    const v = client.getVariables('wrap-demo', 'u-1', { model: 'fallback' });
    expect(v.variant).toBeNull();
    expect(v.fallback).toBe(true);
    expect(v.values).toEqual({ model: 'fallback' });
    await client.close();
  });
});
