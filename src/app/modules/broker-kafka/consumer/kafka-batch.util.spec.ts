import {
  chunkMessages,
  computeHighestContiguousOffset,
} from './kafka-batch.util';

describe('chunkMessages', () => {
  it('splits items into chunks of the given size', () => {
    expect(chunkMessages([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns a single chunk when size is larger than the input', () => {
    expect(chunkMessages([1, 2], 10)).toEqual([[1, 2]]);
  });

  it('returns one chunk per item when size is 1', () => {
    expect(chunkMessages([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
  });

  it('returns an empty array for empty input', () => {
    expect(chunkMessages([], 5)).toEqual([]);
  });

  it('throws when size is less than 1', () => {
    expect(() => chunkMessages([1], 0)).toThrow(RangeError);
  });
});

describe('computeHighestContiguousOffset', () => {
  // ARCHITECTURE.md's canonical example: partition 0, offsets 40/41 succeed, 42 fails,
  // 43 must never be committed while 42 remains unresolved.
  it('stops at the first failure and returns the last successful offset before it', () => {
    const committed = computeHighestContiguousOffset([
      { offset: '40', success: true },
      { offset: '41', success: true },
      { offset: '42', success: false },
    ]);

    expect(committed).toBe('41');
  });

  it('returns null when the first outcome already failed', () => {
    const committed = computeHighestContiguousOffset([
      { offset: '40', success: false },
    ]);

    expect(committed).toBeNull();
  });

  it('returns the last offset when every outcome succeeded', () => {
    const committed = computeHighestContiguousOffset([
      { offset: '40', success: true },
      { offset: '41', success: true },
      { offset: '42', success: true },
    ]);

    expect(committed).toBe('42');
  });

  it('returns null for an empty outcome list', () => {
    expect(computeHighestContiguousOffset([])).toBeNull();
  });
});
