/** Interception: implicit metrics (latency, TTFT, tokens, errors) captured with no track calls. */
import { describe, expect, it } from 'vitest';
import { Client } from '../src/client.js';
import { extractResponseFields } from '../src/intercept.js';
import type { RawConfig } from '../src/types.js';
import { RecordingTransport } from './doubles.js';

const CONFIG: RawConfig[] = [
  {
    id: 'exp_i',
    name: 'intercept-demo',
    salt: 's',
    bucket_count: 1000,
    version: 1,
    allocation: [
      { variant: 'control', weight: 50 },
      { variant: 'treatment', weight: 50 },
    ],
  },
];

const openaiShaped = {
  model: 'gpt-x',
  usage: { prompt_tokens: 64, completion_tokens: 96 },
  choices: [{ message: { content: 'openai reply' } }],
};

const anthropicShaped = {
  model: 'claude-x',
  usage: { input_tokens: 40, output_tokens: 70 },
  content: [{ text: 'anthropic reply' }],
};

describe('extractResponseFields', () => {
  it('understands OpenAI and Anthropic shapes plus plain strings', () => {
    expect(extractResponseFields(openaiShaped)).toEqual({
      model: 'gpt-x',
      tokens_input: 64,
      tokens_output: 96,
      response: 'openai reply',
    });
    expect(extractResponseFields(anthropicShaped)).toEqual({
      model: 'claude-x',
      tokens_input: 40,
      tokens_output: 70,
      response: 'anthropic reply',
    });
    expect(extractResponseFields('plain text')).toEqual({ response: 'plain text' });
    expect(extractResponseFields({})).toEqual({});
  });
});

describe('interceptModelCall', () => {
  it('tracks exposure + model_call with measured latency and extracted fields', async () => {
    const transport = new RecordingTransport(CONFIG);
    const client = new Client({ apiKey: 'pk_test', transport });
    await client.refreshConfig('intercept-demo');

    const reply = await client.interceptModelCall('intercept-demo', 'u-1', undefined, (call) => {
      call.markFirstToken();
      call.record(anthropicShaped, { prompt: 'the prompt' });
      return 'done';
    });
    expect(reply).toBe('done');

    await client.flush();
    await client.close();
    expect(transport.sentEvents.map((e) => e.type)).toEqual(['exposure', 'model_call']);
    const [exposure, modelCall] = transport.sentEvents;
    expect(exposure.experiment_id).toBe('exp_i'); // name normalized to the canonical id
    expect(modelCall.latency_ms as number).toBeGreaterThanOrEqual(0);
    expect(modelCall.ttft_ms as number).toBeGreaterThanOrEqual(0);
    expect(modelCall.tokens_output).toBe(70);
    expect(modelCall.model).toBe('claude-x');
    expect(modelCall.prompt).toBe('the prompt');
    expect(modelCall.response).toBe('anthropic reply');
  });

  it('records the error, drops the response, and re-throws', async () => {
    const transport = new RecordingTransport(CONFIG);
    const client = new Client({ apiKey: 'pk_test', transport });
    await client.refreshConfig('intercept-demo');

    await expect(
      client.interceptModelCall('intercept-demo', 'u-err', undefined, (call) => {
        call.record('half a reply', { prompt: 'the prompt' });
        throw new Error('provider blew up');
      }),
    ).rejects.toThrow('provider blew up');

    await client.flush();
    await client.close();
    const modelCall = transport.sentEvents.at(-1)!;
    expect(modelCall.type).toBe('model_call');
    expect((modelCall.metadata as Record<string, unknown>).error).toBe(true);
    expect(modelCall.response).toBeUndefined(); // no trustworthy response on failure
    expect(modelCall.latency_ms as number).toBeGreaterThanOrEqual(0);
  });

  it('records nothing on the fallback path (variant null)', async () => {
    const transport = new RecordingTransport(); // serves no config
    const client = new Client({ apiKey: 'pk_test', transport });
    const out = await client.interceptModelCall('intercept-demo', 'u-1', null, (call) => {
      call.record('still works');
      return 42;
    });
    expect(out).toBe(42);
    await client.flush();
    await client.close();
    expect(transport.sentEvents).toEqual([]);
  });
});
