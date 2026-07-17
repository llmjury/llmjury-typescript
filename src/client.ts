/**
 * The LLMJury client: deterministic `assign` + non-blocking `track`.
 *
 * Design (parity with the Python SDK):
 *
 * * `assign(experiment, user)` is **pure local compute** against the polled experiment config — no
 *   network on the hot path, so it never blocks. It returns the variant *key* (or `null` while the
 *   config is still being fetched), reproducing the frozen bucketing hash exactly.
 * * `track(event, payload)` only appends to an in-memory buffer that flushes asynchronously; it
 *   never blocks or throws into the caller.
 * * Experiment config is fetched by **polling** `GET /v1/config` with `If-None-Match`/`304` into an
 *   in-process cache (default every 60s). When a `track` (ingest) response carries a newer
 *   `config_version` than what is cached, an immediate refresh is triggered. No SSE/WebSocket.
 * * Authentication is the org **publishable** key via the `X-API-Key` header.
 *
 * The transport is injectable (the default uses the runtime `fetch` — zero runtime dependencies in
 * Node 18+ and the browser); tests pass a fake transport to exercise failure paths without a network.
 */

import { assignVariant } from './bucketing.js';
import { EventBuffer } from './buffer.js';
import type { Logger } from './logger.js';
import { consoleLogger } from './logger.js';
import { ModelCall } from './intercept.js';
import { wrapClient } from './wrap.js';
import type { OfflineStore } from './offline.js';
import type {
  CachedConfig,
  ConfigResponse,
  IngestAck,
  PromptAssignment,
  RawConfig,
  TrackEvent,
  VariantVariables,
} from './types.js';

const DEFAULT_BUCKET_COUNT = 1000;

/** Production API base URL. Override with `baseUrl`, or the `LLMJURY_BASE_URL` env var for local dev. */
const DEFAULT_BASE_URL = 'https://api.llmjury.com';

/** Read an env var without assuming `process` exists (keeps the SDK browser-safe). */
function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

/** Boundary the client talks to. Swap a fake in for tests; default is {@link HttpTransport}. */
export interface Transport {
  getConfig(experimentId: string | null, etag: string | null): Promise<ConfigResponse>;
  postEvents(events: TrackEvent[]): Promise<IngestAck>;
}

function randomId(): string {
  if (typeof globalThis.crypto !== 'undefined' && 'randomUUID' in globalThis.crypto) {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for older runtimes without Web Crypto — not cryptographically strong, only unique.
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Runtime `fetch`-based HTTP transport — no third-party runtime dependency. */
export class HttpTransport implements Transport {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    baseUrl: string,
    apiKey: string,
    options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const handle = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(handle);
    }
  }

  async getConfig(experimentId: string | null, etag: string | null): Promise<ConfigResponse> {
    let url = `${this.base}/v1/config`;
    if (experimentId) url += `?experiment_id=${encodeURIComponent(experimentId)}`;
    const headers: Record<string, string> = { 'X-API-Key': this.apiKey };
    if (etag) headers['If-None-Match'] = etag;
    return this.withTimeout(async (signal) => {
      const res = await this.fetchImpl(url, { method: 'GET', headers, signal });
      if (res.status === 304) return { status: 304, configs: [], etag };
      if (!res.ok) throw new Error(`config fetch failed: HTTP ${res.status}`);
      const body = (await res.json().catch(() => [])) as unknown;
      const configs = Array.isArray(body) ? (body as RawConfig[]) : [];
      return { status: 200, configs, etag: res.headers.get('ETag') };
    });
  }

  async postEvents(events: TrackEvent[]): Promise<IngestAck> {
    const url = `${this.base}/v1/events`;
    return this.withTimeout(async (signal) => {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'X-API-Key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
        signal,
      });
      if (!res.ok) throw new Error(`event ingest failed: HTTP ${res.status}`);
      const ack = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return {
        accepted: Number(ack.accepted ?? 0),
        configVersion: Number(ack.config_version ?? 0),
      };
    });
  }
}

export interface ClientOptions {
  /**
   * The org **publishable** key, sent as `X-API-Key`. Safe in the browser; write-only/rate-limited.
   * Optional: falls back to the `LLMJURY_API_KEY` env var, so you can construct `new Client()` with
   * no secret in code. Required only when neither the env var nor a custom `transport` is provided.
   */
  apiKey?: string;
  /** API base URL. Defaults to `LLMJURY_BASE_URL` env var, else `https://api.llmjury.com`. */
  baseUrl?: string;
  /**
   * Experiment ids to prefetch at startup so the first {@link Client.assign} resolves immediately.
   * Await {@link Client.ready} to be sure the configs have loaded before assigning.
   */
  experiments?: string[];
  transport?: Transport;
  flushIntervalMs?: number;
  flushSize?: number;
  configPollIntervalMs?: number;
  /** Offline spill store (e.g. {@link FileOfflineStore} in Node, {@link IndexedDbOfflineStore} in a browser). */
  offline?: OfflineStore;
  requestTimeoutMs?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

/** Public SDK entrypoint. Construct once per process/page and reuse; call {@link Client.close} at exit. */
export class Client {
  private readonly transport: Transport;
  private readonly log: Logger;
  private readonly buffer: EventBuffer;
  private readonly pollIntervalMs: number;

  private readonly configs = new Map<string, CachedConfig>();
  /** Node: AsyncLocalStorage keeps the ambient user request-scoped; browser: a simple slot. */
  private userStore: {
    getStore(): string | undefined;
    run<T>(user: string, fn: () => T): T;
  } | null = null;
  private ambientUser: string | null = null;
  private readonly etags = new Map<string, string | null>();
  private highestVersion = 0;
  private closed = false;
  private readonly pollTimer: ReturnType<typeof setInterval>;
  private readonly warmup: Promise<unknown>[] = [];

  constructor(options: ClientOptions = {}) {
    this.log = options.logger ?? consoleLogger;
    this.transport = options.transport ?? this.buildDefaultTransport(options);
    this.pollIntervalMs = options.configPollIntervalMs ?? 60_000;

    this.buffer = new EventBuffer((batch) => this.sendEvents(batch), {
      flushIntervalMs: options.flushIntervalMs,
      flushSize: options.flushSize,
      offline: options.offline,
      logger: this.log,
    });

    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, this.pollIntervalMs);
    (this.pollTimer as { unref?: () => void }).unref?.();

    // Prefetch declared experiments so the first assign resolves without a manual warm-up call.
    for (const id of options.experiments ?? []) {
      this.warmup.push(this.refreshConfig(id));
    }
  }

  private buildDefaultTransport(options: ClientOptions): Transport {
    const apiKey = options.apiKey ?? readEnv('LLMJURY_API_KEY');
    if (!apiKey) {
      throw new Error(
        'llmjury: missing API key. Pass { apiKey } or set the LLMJURY_API_KEY environment variable.',
      );
    }
    const baseUrl = options.baseUrl ?? readEnv('LLMJURY_BASE_URL') ?? DEFAULT_BASE_URL;
    return new HttpTransport(baseUrl, apiKey, {
      timeoutMs: options.requestTimeoutMs,
      fetchImpl: options.fetchImpl,
    });
  }

  // -- public API ---------------------------------------------------------------------------

  /**
   * Setup-once interception (OkHttp style): wrap the provider client and call it directly.
   *
   * ```ts
   * const llm = client.wrap(openaiClient, 'checkout-copy');   // once, at startup
   * await client.withUser(userId, () => llm.chat.completions.create({ model, messages }));
   * ```
   *
   * Model-shaped calls through the wrapper record the exposure + a `model_call` with measured
   * latency, tokens, model, and errors — no call-site code. Without an ambient user the call
   * passes through untouched.
   */
  wrap<T extends object>(providerClient: T, experiment: string): T {
    return wrapClient(providerClient, this, experiment);
  }

  /** Run `fn` with the ambient user bound (request-scoped in Node via AsyncLocalStorage). */
  async withUser<T>(user: string, fn: () => Promise<T> | T): Promise<T> {
    const store = await this.ensureUserStore();
    if (store) return store.run(user, () => Promise.resolve(fn()));
    this.ambientUser = user; // browser fallback — single-user context anyway
    try {
      return await fn();
    } finally {
      this.ambientUser = null;
    }
  }

  /** Set the ambient user without a scope (simple scripts/browser; prefer `withUser` in servers). */
  setUser(user: string | null): void {
    this.ambientUser = user;
  }

  /** The ambient user bound by `withUser`/`setUser`, or `null`. */
  currentUser(): string | null {
    return this.userStore?.getStore() ?? this.ambientUser;
  }

  private async ensureUserStore(): Promise<Client['userStore']> {
    if (this.userStore) return this.userStore;
    try {
      const mod = (await import('node:async_hooks')) as {
        AsyncLocalStorage: new () => {
          getStore(): string | undefined;
          run<T>(u: string, fn: () => T): T;
        };
      };
      this.userStore = new mod.AsyncLocalStorage();
    } catch {
      this.userStore = null; // browser — the simple slot handles it
    }
    return this.userStore;
  }

  /**
   * Resolve `user` to their variant's custom variables, merged over in-code `defaults`.
   *
   * Pure client-memory read (the polled config cache) — never a request-path API call. The
   * variant's prompt, when configured, is included under the `"prompt"` key. On any failure path
   * the defaults come back unchanged with `fallback: true`. Never throws.
   */
  getVariables(
    experiment: string,
    user: string,
    defaults: Record<string, string> = {},
  ): VariantVariables {
    const values = { ...defaults };
    try {
      const variant = this.assign(experiment, user);
      if (variant === null) return { variant: null, values, fallback: true };
      const cached = this.configs.get(experiment);
      const configured = cached?.variables[variant] ?? {};
      const prompt = cached?.prompts[variant];
      if (prompt) values.prompt = prompt;
      Object.assign(values, configured);
      return { variant, values, fallback: Object.keys(configured).length === 0 && !prompt };
    } catch (err) {
      this.log.warn(`llmjury: getVariables failed for ${experiment}/${user}: ${String(err)}`);
      return { variant: null, values, fallback: true };
    }
  }

  /**
   * Resolve `user` to a variant key for `experiment` (deterministic, frozen hash).
   *
   * `experiment` is the experiment id OR its unique name — names resolve through the polled
   * config, and the frozen bucketing hash always runs on the canonical id, so name- and
   * id-addressed calls assign identically.
   *
   * Pure local compute against the cached config — never blocks, never throws. Returns `null` if the
   * config is not yet cached; the SDK fetches it in the background, so a later call resolves.
   * Callers should treat `null` as "fall back to your control behaviour".
   */
  assign(experiment: string, user: string): string | null {
    try {
      const cached = this.configs.get(experiment);
      if (!cached) {
        void this.refreshConfig(experiment);
        return null;
      }
      // ALWAYS hash the canonical id — hashing a name would diverge from server assignment.
      return assignVariant(
        cached.salt,
        user,
        cached.experimentId,
        cached.bucketCount,
        cached.allocation,
      );
    } catch (err) {
      this.log.warn(`llmjury: assign failed for ${experiment}/${user}: ${String(err)}`);
      return null;
    }
  }

  /**
   * Resolve `user` straight to the prompt text for their assigned variant.
   *
   * `defaultPrompt` is the **in-code fallback prompt** — it is returned whenever LLMJury cannot be
   * reached (config not yet cached), assignment fails, or the assigned variant has no prompt
   * configured. This is the recommended integration: the app always has a working prompt even
   * during a full LLMJury outage. Never blocks, never throws.
   *
   * Track the exposure with the returned `variant` when it is not `null`; on `variant === null`
   * the user saw the default path and no exposure should be recorded.
   */
  getPrompt(experiment: string, user: string, defaultPrompt: string): PromptAssignment {
    try {
      const variant = this.assign(experiment, user);
      if (variant === null) return { variant: null, prompt: defaultPrompt, fallback: true };
      const prompt = this.configs.get(experiment)?.prompts[variant];
      if (!prompt) return { variant, prompt: defaultPrompt, fallback: true };
      return { variant, prompt, fallback: false };
    } catch (err) {
      this.log.warn(`llmjury: getPrompt failed for ${experiment}/${user}: ${String(err)}`);
      return { variant: null, prompt: defaultPrompt, fallback: true };
    }
  }

  /**
   * Wrap an LLM call so its implicit metrics are captured with NO explicit tracking.
   *
   * ```ts
   * const a = client.getPrompt('checkout-copy', userId, DEFAULT_PROMPT);
   * const reply = await client.interceptModelCall('checkout-copy', userId, a.variant, async (call) => {
   *   const response = await llm(a.prompt, userInput);
   *   call.record(response, { prompt: a.prompt });
   *   return response;
   * });
   * ```
   *
   * On completion the SDK tracks the exposure and a `model_call` event with the measured
   * `latency_ms`, `ttft_ms` (when {@link ModelCall.markFirstToken} was called), and the
   * model/token fields extracted from the response. A thrown error is recorded as
   * `metadata.error = true` and re-thrown. When `variant` is `null` (the getPrompt fallback path)
   * nothing is recorded. Only business outcomes still need {@link Client.track}.
   */
  async interceptModelCall<T>(
    experiment: string,
    user: string,
    variant: string | null | undefined,
    fn: (call: ModelCall) => Promise<T> | T,
  ): Promise<T> {
    const resolved = variant !== undefined ? variant : this.assign(experiment, user);
    const call = new ModelCall((e, p) => this.track(e, p), experiment, user, resolved);
    try {
      const result = await fn(call);
      call.finish(false);
      return result;
    } catch (err) {
      call.finish(true);
      throw err;
    }
  }

  /**
   * Buffer an event of type `event` (`exposure` | `model_call` | `business_event`).
   *
   * `payload` carries the event fields (`experiment_id`, `user_id` and any metrics). The SDK stamps
   * a client-generated `event_id` and `timestamp` if absent. Non-blocking; never throws into the
   * caller.
   */
  track(event: string, payload: Record<string, unknown>): void {
    try {
      const record = this.buildEvent(event, payload);
      if (!record) return;
      this.buffer.add(record);
    } catch (err) {
      this.log.warn(`llmjury: track failed for ${event}: ${String(err)}`);
    }
  }

  /**
   * Blocking, exception-safe config fetch. Useful at startup so the first `assign` resolves; not
   * part of the hot path. Resolves to `true` if the config is cached afterwards.
   */
  async refreshConfig(experimentId: string): Promise<boolean> {
    await this.fetchConfig(experimentId);
    return this.configs.has(experimentId);
  }

  /**
   * Resolve once the experiments passed via `options.experiments` have been fetched. Await this at
   * startup so the first {@link Client.assign} returns a variant instead of `null`.
   */
  async ready(): Promise<void> {
    await Promise.all(this.warmup);
  }

  /** Best-effort flush of buffered events (e.g. before a short script or page-unload). */
  async flush(): Promise<void> {
    await this.buffer.flush();
  }

  /** Flush and stop background timers. Call at process/page shutdown. */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.pollTimer);
    await this.buffer.close();
  }

  /** Events dropped so far (buffer overflow or exhausted retries with no offline store). */
  get dropped(): number {
    return this.buffer.dropped;
  }

  // -- internals ----------------------------------------------------------------------------

  private buildEvent(event: string, payload: Record<string, unknown>): TrackEvent | null {
    const record: TrackEvent = { ...payload, type: event };
    record.event_id ??= randomId();
    record.timestamp ??= new Date().toISOString();
    if (!record.experiment_id || !record.user_id) {
      this.log.warn(`llmjury: dropping ${event} event missing experiment_id/user_id`);
      return null;
    }
    // Name-addressed events normalize to the canonical id so the analysis pipeline (keyed by id)
    // attributes them; unknown identifiers pass through untouched. The held config version is
    // stamped so the version-scoped rollups attribute the event to the config it ran under.
    const cached = this.configs.get(String(record.experiment_id));
    if (cached) {
      record.experiment_id = cached.experimentId;
      record.config_version ??= cached.version;
    }
    return record;
  }

  private async sendEvents(batch: TrackEvent[]): Promise<void> {
    const ack = await this.transport.postEvents(batch);
    if (ack.configVersion > this.highestVersion) {
      // Staleness hint: org config advanced past what we hold — refresh everything we know.
      for (const experimentId of this.configs.keys()) {
        void this.refreshConfig(experimentId);
      }
    }
  }

  private async pollAll(): Promise<void> {
    if (this.closed) return;
    for (const experimentId of this.configs.keys()) {
      if (this.closed) return;
      await this.fetchConfig(experimentId);
    }
  }

  private async fetchConfig(experimentId: string): Promise<void> {
    try {
      const etag = this.etags.get(experimentId) ?? null;
      const response = await this.transport.getConfig(experimentId, etag);
      if (response.status === 304) return;
      this.storeConfigs(response, experimentId);
    } catch (err) {
      this.log.warn(`llmjury: config fetch failed for ${experimentId}: ${String(err)}`);
    }
  }

  private storeConfigs(response: ConfigResponse, requestedId: string): void {
    for (const raw of response.configs) {
      const cached = parseConfig(raw);
      if (!cached) continue;
      this.configs.set(cached.experimentId, cached);
      if (cached.name) this.configs.set(cached.name, cached); // names are unique per org
      this.highestVersion = Math.max(this.highestVersion, cached.version);
    }
    if (response.etag !== null) this.etags.set(requestedId, response.etag);
  }
}

function parseConfig(raw: RawConfig): CachedConfig | null {
  const experimentId = raw.id ?? raw.experiment_id;
  if (!experimentId || raw.salt == null || raw.allocation == null) return null;
  const allocation = raw.allocation.map((slice) => ({
    variant: String(slice.variant),
    weight: Number(slice.weight),
  }));
  const prompts: Record<string, string> = {};
  const variables: Record<string, Record<string, string>> = {};
  for (const slice of raw.allocation) {
    if (typeof slice.prompt === 'string' && slice.prompt !== '') {
      prompts[String(slice.variant)] = slice.prompt;
    }
    if (slice.variables && typeof slice.variables === 'object') {
      const entries = Object.entries(slice.variables).filter(([, v]) => typeof v === 'string');
      if (entries.length > 0) variables[String(slice.variant)] = Object.fromEntries(entries);
    }
  }
  return {
    experimentId,
    salt: String(raw.salt),
    bucketCount: Number(raw.bucket_count ?? DEFAULT_BUCKET_COUNT),
    allocation,
    version: Number(raw.version ?? 0),
    prompts,
    variables,
    ...(typeof raw.name === 'string' && raw.name !== '' ? { name: raw.name } : {}),
  };
}
