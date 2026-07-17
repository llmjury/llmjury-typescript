// Model comparison: route traffic across two models with getVariables.
//
// Variants carry arbitrary variables — here `model` and `temperature` — merged over your
// in-code defaults, so the experiment can vary any knob without a redeploy.
//
// Runs completely offline via a fake transport. Real apps drop `transport`, set
// LLMJURY_API_KEY, and the client talks to https://api.llmjury.com.
// Build first (`npm run build`), then `node examples/model-comparison.mjs`.
import { Client } from '../dist/esm/index.js';

const config = [
  {
    id: 'exp_model_shootout',
    name: 'model-shootout',
    salt: 'salt-shootout-v1',
    bucket_count: 1000,
    version: 1,
    allocation: [
      {
        variant: 'haiku',
        weight: 50,
        variables: { model: 'claude-haiku-4-5', temperature: '0.3' },
      },
      {
        variant: 'sonnet',
        weight: 50,
        variables: { model: 'claude-sonnet-5', temperature: '0.3' },
      },
    ],
  },
];

const transport = {
  async getConfig() {
    return { status: 200, configs: config, etag: 'etag-1' };
  },
  async postEvents(events) {
    for (const e of events) console.log(`  [ingest] ${e.type} variant=${e.variant}`);
    return { accepted: events.length, configVersion: 0 };
  },
};

const client = new Client({ transport, experiments: ['exp_model_shootout'] });
await client.ready();

for (const user of ['alice', 'bob', 'carol']) {
  const v = client.getVariables('model-shootout', user, {
    model: 'claude-haiku-4-5',
    temperature: '0.3',
  });
  console.log(`${user}: variant=${v.variant} -> model=${v.values.model}`);

  // ... call your LLM with v.values.model and track cost/latency/outcome. The dashboard
  // then answers: does the bigger model actually move the business metric enough to
  // justify its cost?
  client.track('model_call', {
    experiment_id: 'model-shootout',
    user_id: user,
    variant: v.variant,
    model: v.values.model,
    latency_ms: 840,
    tokens_input: 512,
    tokens_output: 128,
  });
}

await client.flush();
await client.close();
