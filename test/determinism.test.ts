/**
 * The mandatory cross-SDK determinism test (spec/bucketing.md §5).
 *
 * Reads the shared fixture and asserts this SDK reproduces `expected_variant` (and `bucket`, where
 * present) for every case. The Python and Java SDKs assert against the
 * *same* fixture, so a green run here is part of the cross-language guarantee.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assignVariant, bucketOf, type AllocationSlice } from '../src/bucketing.js';

interface Case {
  salt: string;
  user_id: string;
  experiment_id: string;
  bucket_count: number;
  allocation: AllocationSlice[];
  bucket?: number;
  expected_variant: string;
}

const fixturePath = fileURLToPath(
  new URL('../spec/fixtures/bucketing-cases.json', import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: Case[] };

describe('cross-language bucketing fixture', () => {
  it('has cases', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it.each(fixture.cases)('$experiment_id:$user_id', (c) => {
    if (typeof c.bucket === 'number') {
      expect(bucketOf(c.salt, c.user_id, c.experiment_id, c.bucket_count)).toBe(c.bucket);
    }
    expect(assignVariant(c.salt, c.user_id, c.experiment_id, c.bucket_count, c.allocation)).toBe(
      c.expected_variant,
    );
  });
});
