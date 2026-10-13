import { describe, expect, it } from 'vitest';
import { RingBuffer } from '@/orchestrator/ring-buffer.ts';

describe('RingBuffer', () => {
  it('assigns monotonic sequential sequence numbers starting at 1', () => {
    const buffer = new RingBuffer();
    const f1 = buffer.push('message.created', { msg: 1 });
    const f2 = buffer.push('generation.state', { state: 'generating' });
    const f3 = buffer.push('text.delta', { delta: 'hi' });

    expect(f1.id).toBe(1);
    expect(f2.id).toBe(2);
    expect(f3.id).toBe(3);
    expect(buffer.size).toBe(3);
    expect(buffer.firstSeq).toBe(1);
    expect(buffer.lastSeq).toBe(3);
  });

  it('evicts oldest frames when maxEvents capacity is exceeded', () => {
    const buffer = new RingBuffer({ maxEvents: 3 });
    buffer.push('text.delta', 'a');
    buffer.push('text.delta', 'b');
    buffer.push('text.delta', 'c');
    buffer.push('text.delta', 'd');

    expect(buffer.size).toBe(3);
    expect(buffer.firstSeq).toBe(2);
    expect(buffer.lastSeq).toBe(4);

    const all = buffer.getAll();
    expect(all.map((f) => f.id)).toEqual([2, 3, 4]);
  });

  it('evicts oldest frames when maxBytes capacity is exceeded', () => {
    const buffer = new RingBuffer({ maxBytes: 100 });
    buffer.push('text.delta', 'small 1');
    buffer.push('text.delta', 'small 2');
    buffer.push('text.delta', 'larger payload pushing over byte cap');

    expect(buffer.byteLength).toBeLessThanOrEqual(100);
    expect(buffer.size).toBeLessThan(3);
  });

  it('correctly reports canReplay based on contiguous sequence history', () => {
    const buffer = new RingBuffer({ maxEvents: 3 });
    buffer.push('text.delta', '1');
    buffer.push('text.delta', '2');
    buffer.push('text.delta', '3');

    expect(buffer.canReplay(0)).toBe(true);
    expect(buffer.canReplay(1)).toBe(true);
    expect(buffer.canReplay(2)).toBe(true);
    expect(buffer.canReplay(3)).toBe(true);

    buffer.push('text.delta', '4');

    expect(buffer.canReplay(0)).toBe(false);
    expect(buffer.canReplay(1)).toBe(true);
    expect(buffer.canReplay(2)).toBe(true);
  });

  it('replays only frames strictly after lastEventSeq', () => {
    const buffer = new RingBuffer();
    buffer.push('text.delta', '1');
    buffer.push('text.delta', '2');
    buffer.push('text.delta', '3');

    const replayFrom0 = buffer.replayFrom(0);
    expect(replayFrom0.map((f) => f.id)).toEqual([1, 2, 3]);

    const replayFrom2 = buffer.replayFrom(2);
    expect(replayFrom2.map((f) => f.id)).toEqual([3]);

    const replayFrom3 = buffer.replayFrom(3);
    expect(replayFrom3).toEqual([]);
  });
});
