/**
 * Frozen bucketing hash — the language-agnostic assignment algorithm (spec/bucketing.md).
 *
 * This is a direct port of the LLMJury reference implementation and the Python SDK's
 * `bucketing.py`. It MUST stay bit-for-bit identical to the Python and Java SDKs and the backend
 * assignment service: the same `(salt, userId, experimentId, bucketCount, allocation)` always
 * resolves to the same variant. The cross-language determinism fixture
 * (`spec/fixtures/bucketing-cases.json`) is the merge gate. Changing any rule here is a
 * breaking contract change.
 *
 * Intentionally dependency-free and integer-only so there is no floating-point divergence. All
 * 32-bit arithmetic uses `Math.imul` (true 32-bit multiply) and `>>> 0` (unsigned coercion) so the
 * result matches the canonical unsigned 32-bit MurmurHash3 exactly.
 */

/** One ordered allocation slice: a variant key and its integer weight. */
export interface AllocationSlice {
  variant: string;
  weight: number;
}

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

function rotl32(x: number, r: number): number {
  return ((x << r) | (x >>> (32 - r))) >>> 0;
}

/**
 * MurmurHash3 x86 32-bit (Austin Appleby). Returns an unsigned 32-bit integer; seed fixed at 0.
 */
export function murmur3x86_32(data: Uint8Array, seed = 0): number {
  const length = data.length;
  let h1 = seed >>> 0;
  const roundedEnd = length & ~0x03; // largest multiple of 4 <= length

  for (let i = 0; i < roundedEnd; i += 4) {
    let k1 =
      (data[i] & 0xff) |
      ((data[i + 1] & 0xff) << 8) |
      ((data[i + 2] & 0xff) << 16) |
      ((data[i + 3] & 0xff) << 24);
    k1 = Math.imul(k1, C1) >>> 0;
    k1 = rotl32(k1, 15);
    k1 = Math.imul(k1, C2) >>> 0;
    h1 ^= k1;
    h1 = rotl32(h1, 13);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
  }

  let k1 = 0;
  const tail = length & 0x03;
  if (tail === 3) k1 ^= (data[roundedEnd + 2] & 0xff) << 16;
  if (tail >= 2) k1 ^= (data[roundedEnd + 1] & 0xff) << 8;
  if (tail >= 1) {
    k1 ^= data[roundedEnd] & 0xff;
    k1 = Math.imul(k1, C1) >>> 0;
    k1 = rotl32(k1, 15);
    k1 = Math.imul(k1, C2) >>> 0;
    h1 ^= k1;
  }

  h1 ^= length;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b) >>> 0;
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35) >>> 0;
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

const ENCODER = new TextEncoder();

/**
 * Map a user to a bucket in `[0, bucketCount)`.
 *
 * `bucketCount` is a per-experiment config value (default 1000) carried in the fetched config — it
 * is never hardcoded in the SDK.
 */
export function bucketOf(
  salt: string,
  userId: string,
  experimentId: string,
  bucketCount: number,
): number {
  const key = ENCODER.encode(`${salt}:${userId}:${experimentId}`);
  return murmur3x86_32(key) % bucketCount;
}

/**
 * Deterministically assign a variant key using integer-only cumulative boundaries.
 *
 * The boundary for slice `i` is `floor(cumulativeWeight_i * bucketCount / totalWeight)`; a bucket
 * belongs to the first slice whose boundary it falls below. The final slice absorbs any remainder,
 * so every bucket maps to exactly one variant.
 */
export function assignVariant(
  salt: string,
  userId: string,
  experimentId: string,
  bucketCount: number,
  allocation: AllocationSlice[],
): string {
  const bucket = bucketOf(salt, userId, experimentId, bucketCount);
  let total = 0;
  for (const slice of allocation) total += slice.weight;
  let cumulative = 0;
  for (const slice of allocation) {
    cumulative += slice.weight;
    const boundary = Math.floor((cumulative * bucketCount) / total);
    if (bucket < boundary) return slice.variant;
  }
  return allocation[allocation.length - 1].variant;
}
