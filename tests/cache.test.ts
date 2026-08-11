import { describe, expect, it } from 'vitest';

import { MemoryCache } from '../src/cache.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('MemoryCache', () => {
  it('returns stored values before the TTL and drops them after', async () => {
    const cache = new MemoryCache<string>(1024);
    await cache.set('k', 'v', 50, 1);
    expect(await cache.get('k')).toBe('v');
    await sleep(80);
    expect(await cache.get('k')).toBeUndefined();
  });

  it('evicts least-recently-used entries when over the byte cap', async () => {
    const cache = new MemoryCache<string>(100);
    await cache.set('a', 'A', 10_000, 40);
    await cache.set('b', 'B', 10_000, 40);
    await cache.get('a'); // refresh a's recency
    await cache.set('c', 'C', 10_000, 40); // exceeds cap -> evict b (LRU)
    expect(await cache.get('a')).toBe('A');
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('c')).toBe('C');
  });

  it('never stores an entry larger than the cap', async () => {
    const cache = new MemoryCache<string>(100);
    await cache.set('huge', 'H', 10_000, 500);
    expect(await cache.get('huge')).toBeUndefined();
  });

  it('supports explicit deletes', async () => {
    const cache = new MemoryCache<string>(1024);
    await cache.set('k', 'v', 10_000, 1);
    await cache.delete('k');
    expect(await cache.get('k')).toBeUndefined();
  });
});
