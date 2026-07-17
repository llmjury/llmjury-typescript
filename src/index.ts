/**
 * LLMJury TypeScript SDK — deterministic `assign` + non-blocking `track`.
 *
 * See the module README and `spec/bucketing.md` for the frozen assignment contract. The public
 * surface mirrors the Python SDK and asserts the same cross-language fixture.
 */

export { Client, HttpTransport } from './client.js';
export { ModelCall, extractResponseFields } from './intercept.js';
export type { ModelCallFields } from './intercept.js';
export { wrapClient } from './wrap.js';
export type { ClientOptions, Transport } from './client.js';
export { EventBuffer } from './buffer.js';
export type { EventBufferOptions, Sender } from './buffer.js';
export { FileOfflineStore, IndexedDbOfflineStore, defaultOfflineStore } from './offline.js';
export type { OfflineStore, OfflineRecord } from './offline.js';
export { assignVariant, bucketOf, murmur3x86_32 } from './bucketing.js';
export type { AllocationSlice } from './bucketing.js';
export type { Logger } from './logger.js';
export type {
  TrackEvent,
  CachedConfig,
  RawConfig,
  ConfigResponse,
  IngestAck,
  PromptAssignment,
  VariantVariables,
} from './types.js';

export const VERSION = '0.1.0';
