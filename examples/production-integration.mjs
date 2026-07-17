// Production LLM integration: the full recommended pattern.
//
// Setup-once wrap() interception + getPrompt + one explicit business-outcome event. The
// wrapped provider client records exposure, latency, tokens, model, and errors for every
// call — with zero per-call tracking code.
//
// This example fakes both the LLMJury backend and the LLM provider so it runs offline; the
// integration code is exactly what you'd ship (with the real `new Anthropic()` / `new OpenAI()`
// client and no `transport`).
// Build first (`npm run build`), then `node examples/production-integration.mjs`.
import { Client } from '../dist/esm/index.js';

const config = [
  {
    id: 'exp_checkout',
    name: 'checkout-prompt',
    salt: 'salt-checkout-v1',
    bucket_count: 1000,
    version: 1,
    allocation: [
      {
        variant: 'control',
        weight: 50,
        prompt: 'You are a helpful assistant.',
      },
      {
        variant: 'friendly',
        weight: 50,
        prompt: 'You are a warm, upbeat shopping guide. Keep answers short.',
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

// A fake Anthropic-shaped client — the wrapper duck-types it exactly like the real one.
const fakeAnthropic = {
  messages: {
    async create() {
      return {
        model: 'claude-sonnet-5',
        usage: { input_tokens: 512, output_tokens: 128 },
        content: "Sure — here's how to finish checking out.",
      };
    },
  },
};

// ---- setup, once at startup ---------------------------------------------------
const client = new Client({ transport, experiments: ['exp_checkout'] });
await client.ready();
const llm = client.wrap(fakeAnthropic, 'checkout-prompt');

// ---- per request ----------------------------------------------------------------
const userId = 'user-42';
const p = client.getPrompt('checkout-prompt', userId, 'You are a helpful assistant.');
console.log(`variant=${p.variant} prompt="${p.prompt}"`);

await client.withUser(userId, async () => {
  // Call the provider client DIRECTLY — the wrapper records exposure + model_call
  // (latency, tokens, model, errors) automatically.
  const response = await llm.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    system: p.prompt,
    messages: [{ role: 'user', content: 'How do I check out?' }],
  });
  console.log(`llm answered: "${response.content}"`);
});

// ---- when the outcome happens (often a different request) ----------------------
client.track('business_event', {
  experiment_id: 'checkout-prompt',
  user_id: userId,
  variant: p.variant,
  business_metric: 'conversion',
  value: 1,
});

await client.flush();
await client.close();
