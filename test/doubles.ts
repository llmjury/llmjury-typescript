/** Shared test doubles. No real network: every transport here is in-process. */
import type { Transport } from '../src/client.js';
import type { ConfigResponse, IngestAck, RawConfig, TrackEvent } from '../src/types.js';

/** Succeeds on every call and records what was sent. Serves an optional fixed config once. */
export class RecordingTransport implements Transport {
  sentEvents: TrackEvent[] = [];
  eventCalls = 0;
  configCalls = 0;

  constructor(private readonly configs: RawConfig[] = []) {}

  async getConfig(_experimentId: string | null, etag: string | null): Promise<ConfigResponse> {
    this.configCalls += 1;
    if (this.configs.length === 0) return { status: 304, configs: [], etag };
    return { status: 200, configs: this.configs, etag: 'etag-1' };
  }

  async postEvents(events: TrackEvent[]): Promise<IngestAck> {
    this.eventCalls += 1;
    this.sentEvents.push(...events);
    return { accepted: events.length, configVersion: 0 };
  }
}

/** Rejects on every call — stands in for a dead network. */
export class FailingTransport implements Transport {
  async getConfig(): Promise<ConfigResponse> {
    throw new Error('network down');
  }

  async postEvents(): Promise<IngestAck> {
    throw new Error('network down');
  }
}
