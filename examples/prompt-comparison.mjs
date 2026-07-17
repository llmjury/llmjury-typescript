// Prompt comparison: A/B test two system prompts with getPrompt.
//
// Each variant carries its prompt in the experiment config (managed in the dashboard). Your
// in-code default is the guaranteed fallback — it is what users get during a cold start, an
// outage, or if the variant has no prompt configured.
//
// Runs completely offline via a fake transport. Real apps drop `transport`, set
// LLMJURY_API_KEY, and the client talks to https://api.llmjury.com.
// Build first (`npm run build`), then `node examples/prompt-comparison.mjs`.
import { Client } from '../dist/esm/index.js';

const config = [
  {
    id: 'exp_support_tone',
    name: 'support-tone',
    salt: 'salt-tone-v1',
    bucket_count: 1000,
    version: 1,
    allocation: [
      {
        variant: 'concise',
        weight: 50,
        prompt: 'You are a support agent. Answer in at most two sentences.',
      },
      {
        variant: 'empathetic',
        weight: 50,
        prompt: 'You are a warm, patient support agent. Acknowledge feelings first.',
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

const client = new Client({ transport, experiments: ['exp_support_tone'] });
await client.ready();

for (const user of ['alice', 'bob', 'carol']) {
  const p = client.getPrompt('support-tone', user, 'You are a helpful support agent.');
  console.log(`${user}: variant=${p.variant} fallback=${p.fallback}`);
  console.log(`  system prompt: ${p.prompt}`);

  // ... call your LLM with p.prompt, then track the outcome that decides the experiment:
  client.track('business_event', {
    experiment_id: 'support-tone',
    user_id: user,
    variant: p.variant,
    business_metric: 'helpful_rating',
    value: 1,
  });
}

await client.flush();
await client.close();
