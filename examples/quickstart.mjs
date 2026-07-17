// Runnable sample. Build first (`npm run build`), then `node examples/quickstart.mjs`.
//
// It uses an in-process fake transport so it runs with no backend and no network — demonstrating the
// real API surface (ready → assign → track → flush → close) and the deterministic hash. In a real app
// you drop the `transport` option; the client reads `LLMJURY_API_KEY` and talks to https://api.llmjury.com.
import { Client } from '../dist/esm/index.js';

const config = [
  {
    id: 'exp_checkout',
    salt: 'salt-checkout',
    bucket_count: 1000,
    version: 1,
    allocation: [
      { variant: 'control', weight: 90 },
      { variant: 'treatment', weight: 10 },
    ],
  },
];

// A fake transport so the sample is self-contained. Real apps omit this.
const transport = {
  async getConfig() {
    return { status: 200, configs: config, etag: 'etag-1' };
  },
  async postEvents(events) {
    console.log(`  ingest received ${events.length} event(s)`);
    return { accepted: events.length, configVersion: 0 };
  },
};

// Real apps need only: new Client({ experiments: ['exp_checkout'] }) with LLMJURY_API_KEY set.
const client = new Client({ transport, experiments: ['exp_checkout'] });

await client.ready(); // resolves once the declared experiments are fetched

for (const user of ['user-1', 'user-2', 'user-3']) {
  const variant = client.assign('exp_checkout', user);
  console.log(`assign(${user}) -> ${variant}`);
  client.track('exposure', {
    experiment_id: 'exp_checkout',
    user_id: user,
    variant,
  });
}

await client.flush();
await client.close();
console.log('done');
