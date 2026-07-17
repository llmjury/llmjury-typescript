/**
 * Model-call interception: the implicit metrics captured without explicit `track` calls.
 *
 * Wrap the LLM call in {@link Client.interceptModelCall} and the SDK records the **exposure** and
 * the **model_call** event automatically, with:
 *
 * - `latency_ms` — wall-clock around the wrapped function (always measured)
 * - `ttft_ms` — time to first token, when the caller marks it (streaming)
 * - `model` / `tokens_input` / `tokens_output` — duck-typed from OpenAI- and Anthropic-shaped
 *   response objects (no provider SDK dependency), overridable explicitly
 * - `metadata.error` — `true` when the wrapped function throws (the error is re-thrown, never
 *   swallowed), so an `error_rate` metric needs no code at all
 *
 * The ONLY events an application must still track explicitly are business outcomes
 * (`business_event`) — everything a model call can tell us is intercepted here, and judge metrics
 * (quality/safety/relevance) are computed server-side from the recorded prompt/response.
 */

/** Explicit fields the caller can attach to an intercepted call (they win over extraction). */
export interface ModelCallFields {
  prompt?: string;
  response?: string;
  model?: string;
  tokens_input?: number;
  tokens_output?: number;
  cost_usd?: number;
  metadata?: Record<string, unknown>;
}

/** Best-effort field extraction from a provider response object (duck-typed, never throws). */
export function extractResponseFields(response: unknown): ModelCallFields {
  const fields: ModelCallFields = {};
  try {
    if (typeof response === 'string') {
      return { response };
    }
    if (response === null || typeof response !== 'object') {
      return fields;
    }
    const r = response as Record<string, unknown>;
    if (typeof r.model === 'string' && r.model !== '') {
      fields.model = r.model;
    }
    const usage = r.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage === 'object') {
      const tokensIn = usage.input_tokens ?? usage.prompt_tokens; // Anthropic ?? OpenAI
      const tokensOut = usage.output_tokens ?? usage.completion_tokens;
      if (typeof tokensIn === 'number') fields.tokens_input = tokensIn;
      if (typeof tokensOut === 'number') fields.tokens_output = tokensOut;
    }
    // Response text: Anthropic content[0].text, else OpenAI choices[0].message.content.
    const content = r.content as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(content) && content.length > 0 && typeof content[0]?.text === 'string') {
      fields.response = content[0].text as string;
    } else {
      const choices = r.choices as Array<Record<string, unknown>> | undefined;
      const message = Array.isArray(choices)
        ? (choices[0]?.message as Record<string, unknown> | undefined)
        : undefined;
      if (typeof message?.content === 'string') {
        fields.response = message.content;
      }
    }
  } catch {
    // extraction is best-effort — never break the host app over telemetry.
  }
  return fields;
}

/** Handle passed to the {@link Client.interceptModelCall} callback. */
export class ModelCall {
  private readonly startedAt: number;
  private ttftMs: number | null = null;
  private fields: ModelCallFields = {};
  private metadata: Record<string, unknown> = {};

  constructor(
    private readonly trackFn: (event: string, payload: Record<string, unknown>) => void,
    private readonly experiment: string,
    private readonly user: string,
    private readonly variant: string | null,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.startedAt = this.now();
  }

  /** Record time-to-first-token (first call wins) — call when the first stream chunk lands. */
  markFirstToken(): void {
    if (this.ttftMs === null) {
      this.ttftMs = Math.round(this.now() - this.startedAt);
    }
  }

  /**
   * Attach the model response and/or explicit fields to the call. `response` is duck-type
   * extracted (model, tokens, text); explicit fields always win over extracted ones.
   */
  record(response?: unknown, fields?: ModelCallFields): void {
    if (response !== undefined) {
      this.fields = { ...this.fields, ...extractResponseFields(response) };
    }
    if (fields) {
      const { metadata, ...rest } = fields;
      if (metadata) this.metadata = { ...this.metadata, ...metadata };
      for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined) (this.fields as Record<string, unknown>)[key] = value;
      }
    }
  }

  /** @internal Emit the exposure + model_call events (called by the wrapper). */
  finish(failed: boolean): void {
    if (this.variant === null) {
      return; // fallback path (config unavailable): record nothing, change nothing
    }
    const base = { experiment_id: this.experiment, user_id: this.user, variant: this.variant };
    this.trackFn('exposure', { ...base });
    const event: Record<string, unknown> = {
      ...base,
      ...this.fields,
      latency_ms: Math.round(this.now() - this.startedAt),
    };
    if (this.ttftMs !== null) event.ttft_ms = this.ttftMs;
    if (failed) {
      this.metadata.error = true;
      delete event.response; // a failed call has no trustworthy response payload
    }
    if (Object.keys(this.metadata).length > 0) event.metadata = { ...this.metadata };
    this.trackFn('model_call', event);
  }
}
