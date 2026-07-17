# LLMJury TypeScript SDK

[![CI](https://github.com/llmjury/llmjury-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/llmjury/llmjury-typescript/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/llmjury-sdk)](https://www.npmjs.com/package/llmjury-sdk)
[![Node](https://img.shields.io/node/v/llmjury-sdk)](https://www.npmjs.com/package/llmjury-sdk)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

The official TypeScript/JavaScript SDK for [LLMJury](https://llmjury.com) — run LLM experiments
in production.

LLMJury lets you compare prompts and models on real traffic, with real users, and measure what
actually matters: your business outcomes. The SDK assigns each user to an experiment variant
deterministically, captures latency / tokens / errors from your existing LLM calls automatically,
and streams everything to the LLMJury dashboard where the stats engine tells you which variant
wins — and when you have enough data to trust it.

**Why teams use it:**

- **Ship prompt and model changes like feature flags.** Roll a new prompt to 10% of traffic,
  watch the metrics, roll forward or back — no redeploy.
- **Decide on outcomes, not vibes.** Tie each variant to conversion, retention, resolution rate —
  whatever your business metric is — with statistical rigor built in.
- **Zero overhead on the hot path.** Variant assignment is pure local compute (no network call),
  and tracking never blocks and never throws into your app. A full LLMJury outage degrades to
  your in-code defaults.

## Installation

```bash
npm install llmjury-sdk
```

Node 18+ or any modern browser. **Zero runtime dependencies** — the default transport is the
runtime `fetch`. Ships dual ESM + CJS builds with full type declarations.

## Authentication

Get your **publishable API key** from the LLMJury dashboard (**Settings → API keys**, it looks
like `llmj_pk_...`) and export it:

```bash
export LLMJURY_API_KEY=llmj_pk_...
```

The publishable key is write-only and rate-limited, so it is safe in servers **and** in the
browser. In Node the SDK reads the env var automatically; in the browser pass
`new Client({ apiKey: 'llmj_pk_...' })`.

## Quick start

Create an experiment in the dashboard (say, `checkout-prompt`, with variants `control` and
`friendly`, each carrying a prompt). Then:

```ts
import { Client } from 'llmjury-sdk';

// Once, at startup. Prefetching means the first assign resolves instantly.
const client = new Client({ experiments: ['checkout-prompt'] });
await client.ready();

// Per request: which variant is this user in, and what prompt does it carry?
const p = client.getPrompt('checkout-prompt', userId, 'You are a helpful assistant.');
console.log(p.variant, p.prompt); // e.g. "friendly", "You are a warm, upbeat shopping guide..."

// When the user converts, record the outcome — this is what the experiment is measured on.
client.track('business_event', {
  experiment_id: 'checkout-prompt',
  user_id: userId,
  variant: p.variant,
  business_metric: 'conversion',
  value: 1,
});
```

That's the whole loop: **assign → use the variant's prompt → track the outcome**. The dashboard
does the rest.

## Recommended production setup

Add the setup-once `wrap()` interceptor and the SDK also captures **latency, token usage, model
name, errors, and time-to-first-token** from every LLM call — with zero per-call code:

```ts
import { Client } from 'llmjury-sdk';
import Anthropic from '@anthropic-ai/sdk';

// ---- once, at startup -------------------------------------------------------
const client = new Client({ experiments: ['checkout-prompt'] });
const llm = client.wrap(new Anthropic(), 'checkout-prompt'); // every model call is now traced

// ---- per request (e.g. middleware) -------------------------------------------
await client.withUser(userId, async () => {
  const p = client.getPrompt('checkout-prompt', userId, 'You are a helpful assistant.');
  // Call your provider client DIRECTLY — metrics are intercepted automatically.
  const response = await llm.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    system: p.prompt,
    messages: [{ role: 'user', content: userInput }],
  });
});

// Later, when the user converts (often a different request), the ONLY explicit
// tracking you write is the business outcome — assign is deterministic, so
// re-deriving the variant is free and always consistent:
client.track('business_event', {
  experiment_id: 'checkout-prompt', user_id: userId,
  variant: client.assign('checkout-prompt', userId),
  business_metric: 'conversion', value: 1,
});
```

The wrapper is a duck-typed `Proxy` — it works with OpenAI- and Anthropic-style clients (or
anything shaped like them) without importing any provider SDK.

## Core concepts

| Concept | What it is |
|---|---|
| **Experiment** | A named test with an ordered list of variants and traffic weights, defined in the dashboard. Address it by id or unique name. |
| **Variant** | One arm of the experiment. Carries a prompt and/or arbitrary variables (e.g. `model`, `temperature`). |
| **Assignment** | `assign(experiment, user)` → variant key. Deterministic: the same user always gets the same variant, in every SDK language, with no network call. |
| **User / session** | Any stable string id you choose — user id, session id, tenant id. It is hashed, never stored raw for assignment. |
| **Exposure** | "User X saw variant Y" — recorded automatically by `wrap`/interception, or track it yourself. |
| **Model call** | One LLM invocation: latency, tokens in/out, model, error — captured by the interceptor. |
| **Business event** | Your outcome metric (conversion, thumbs-up, resolution). The thing the experiment is judged on. |

### Comparing models

Variants can carry **variables**, so an experiment can vary the model (or temperature, or any
knob) instead of — or alongside — the prompt:

```ts
const v = client.getVariables('model-shootout', userId, {
  model: 'claude-haiku-4-5',
  temperature: '0.3',
});
const response = await llm.messages.create({ model: v.values.model, /* ... */ });
```

### Comparing prompts

`getPrompt` is the purpose-built path: each variant carries a prompt, and your in-code default is
the guaranteed fallback. Rich prompt workflows (versioning, edit history, per-variant prompt
text) are managed in the dashboard.

### Manual control

The low-level primitives are always available if you want full control:

```ts
const variant = client.assign('checkout-prompt', userId); // variant key (or null pre-config)
client.track('exposure', { experiment_id: 'checkout-prompt', user_id: userId, variant });
client.track('model_call', {
  experiment_id: 'checkout-prompt', user_id: userId, variant,
  latency_ms: 840, tokens_input: 512, tokens_output: 128, model: 'claude-sonnet-5',
});
```

## Error handling & resilience

The SDK is engineered so that **LLMJury can never take your app down**:

- `assign` / `getPrompt` / `getVariables` never touch the network on the hot path — they compute
  against a locally cached config that refreshes in the background (60s polling, `ETag`/`304`).
- `track` appends to a bounded in-memory buffer and returns immediately. A background loop
  flushes every second (or every 1,000 events).
- Failed flushes retry a bounded number of times, then **spill offline** (`FileOfflineStore` in
  Node, `IndexedDbOfflineStore` in the browser) and replay later with their original timestamps
  (bounded to 24h), or drop. They never throw into your code.
- Before the first config fetch completes, `assign` returns `null` and `getPrompt` returns your
  default — your app keeps working during a cold start with the network down. Await
  `client.ready()` when you want to be sure configs are loaded.

There are no exceptions to catch. The one deliberate consequence: telemetry is best-effort — if
your process exits without `await client.close()`, buffered events from the last flush interval
may be lost.

## Configuration

```ts
new Client({
  apiKey: undefined,            // default: LLMJURY_API_KEY env var (Node)
  baseUrl: undefined,           // default: LLMJURY_BASE_URL env var, else https://api.llmjury.com
  experiments: [],              // experiment ids/names to prefetch at startup
  flushIntervalMs: 1000,        // ms between background flushes
  flushSize: 1000,              // flush early when the buffer reaches this size
  configPollIntervalMs: 60000,  // ms between config refreshes
  offline: undefined,           // OfflineStore enabling offline spill/replay
  requestTimeoutMs: 5000,       // per-request timeout
  logger: undefined,            // bring your own logger
  fetchImpl: undefined,         // custom fetch (proxies, test doubles)
});
```

Lifecycle: construct **one** `Client` per process/page and reuse it. Call `await client.flush()`
to drain (e.g. at the end of a job or serverless invocation) and `await client.close()` at
shutdown.

## Examples

Runnable scripts live in [`examples/`](examples/):

- [`quickstart.mjs`](examples/quickstart.mjs) — assign + track end-to-end (runs offline, no account needed)
- [`prompt-comparison.mjs`](examples/prompt-comparison.mjs) — A/B test two prompts with `getPrompt`
- [`model-comparison.mjs`](examples/model-comparison.mjs) — route traffic across models with `getVariables`
- [`production-integration.mjs`](examples/production-integration.mjs) — the full `wrap()` + business-outcome pattern

## The determinism guarantee

Assignment is a frozen, cross-language contract: MurmurHash3 over `salt:user:experiment` with
integer-only boundary arithmetic, specified in [`spec/bucketing.md`](spec/bucketing.md). The
[Python](https://github.com/llmjury/llmjury-python), TypeScript, and
[Java](https://github.com/llmjury/llmjury-java) SDKs all assert the same conformance fixture in
CI, so a user gets the same variant no matter which service — in which language — asks.

## Links

- [LLMJury docs](https://llmjury.com/docs) · [Dashboard](https://llmjury.com)
- [Python SDK](https://github.com/llmjury/llmjury-python) · [Java SDK](https://github.com/llmjury/llmjury-java)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Changelog](CHANGELOG.md)

## License

[Apache 2.0](LICENSE)
