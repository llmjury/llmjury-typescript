import type { AllocationSlice } from './bucketing.js';

/**
 * A telemetry event the host app records via `client.track`. `type` is the event kind
 * (`exposure` | `model_call` | `business_event`); `experiment_id` and `user_id` are required for
 * the event to be sent. The SDK stamps `event_id` and `timestamp` if absent. Any extra fields
 * (metrics, metadata) are carried through as-is and validated by the backend against
 * the LLMJury event schema.
 */
export interface TrackEvent {
  type: string;
  experiment_id?: string;
  user_id?: string;
  event_id?: string;
  timestamp?: string;
  [key: string]: unknown;
}

/** The bucketing inputs the SDK needs, distilled from a fetched `ExperimentConfig`. */
export interface CachedConfig {
  experimentId: string;
  salt: string;
  bucketCount: number;
  allocation: AllocationSlice[];
  version: number;
  /** Variant → configured prompt text (only variants that carry one). */
  prompts: Record<string, string>;
  /** Variant → custom variables (model, temperature, …) — resolved from client memory. */
  variables: Record<string, Record<string, string>>;
  /** The unique, human-readable experiment name (an alternate address for assign/track). */
  name?: string;
}

/**
 * Result of {@link Client.getVariables} — always usable, never throws.
 *
 * `values` starts from the caller's in-code defaults and overlays the assigned variant's
 * configured variables (plus its prompt, when set, under the `"prompt"` key). Resolved entirely
 * from the client-memory config cache — no API call on this path; the cache refreshes in the
 * background (60s poll) and immediately when an event send reports a newer config version.
 * `fallback` is `true` when the defaults came back unmodified (config unreachable).
 */
export interface VariantVariables {
  variant: string | null;
  values: Record<string, string>;
  fallback: boolean;
}

/**
 * Result of {@link Client.getPrompt} — always usable, never throws.
 *
 * `variant` is the assigned variant key, or `null` when assignment could not resolve (config not
 * yet cached / backend unreachable). `prompt` is the text to use: the variant's configured prompt
 * when available, otherwise the caller's in-code default. `fallback` is `true` whenever the
 * returned prompt is the default rather than the variant's configured prompt.
 */
export interface PromptAssignment {
  variant: string | null;
  prompt: string;
  fallback: boolean;
}

/** Raw experiment config as returned by `GET /v1/config` (snake_case, backend shape). */
export interface RawConfig {
  id?: string;
  experiment_id?: string;
  name?: string;
  salt?: string;
  bucket_count?: number;
  version?: number;
  allocation?: Array<{
    variant: string;
    weight: number;
    prompt?: string | null;
    variables?: Record<string, string> | null;
  }>;
}

/** Result of a `GET /v1/config` poll. `status` is 200 (configs) or 304 (unchanged). */
export interface ConfigResponse {
  status: number;
  configs: RawConfig[];
  etag: string | null;
}

/** Result of `POST /v1/events`. `configVersion` is the org-aggregate staleness hint. */
export interface IngestAck {
  accepted: number;
  configVersion: number;
}
