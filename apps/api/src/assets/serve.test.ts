import { describe, expect, it } from 'vitest';
import { parseRange } from './serve.ts';

describe('parseRange (ADR-039)', () => {
  it('handles a-b, a-, -n, clamping, and unsatisfiable or ignored ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ offset: 0, length: 10 });
    expect(parseRange('bytes=90-', 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange('bytes=-10', 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange('bytes=-500', 100)).toEqual({ offset: 0, length: 100 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ offset: 50, length: 50 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull(); // multiple ranges → whole file
    expect(parseRange('bytes=9-1', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
    expect(parseRange('bytes=-', 100)).toBeNull();
  });
});
