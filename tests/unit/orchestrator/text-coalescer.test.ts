import { describe, expect, it } from 'vitest';
import { TextCoalescer } from '@/orchestrator/text-coalescer.ts';

describe('TextCoalescer', () => {
  it('coalesces multiple chunks within the interval into a single flush', async () => {
    const flushes: { partId: string; delta: string }[] = [];
    const coalescer = new TextCoalescer({
      flushIntervalMs: 25,
      onFlush: (partId, delta) => flushes.push({ partId, delta }),
    });

    coalescer.append('part-1', 'Hello');
    coalescer.append('part-1', ' ');
    coalescer.append('part-1', 'world');

    expect(flushes.length).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(flushes).toEqual([{ partId: 'part-1', delta: 'Hello world' }]);
    coalescer.dispose();
  });

  it('flushes immediately when the partId changes', () => {
    const flushes: { partId: string; delta: string }[] = [];
    const coalescer = new TextCoalescer({
      flushIntervalMs: 50,
      onFlush: (partId, delta) => flushes.push({ partId, delta }),
    });

    coalescer.append('part-1', 'First part text');
    expect(flushes.length).toBe(0);

    coalescer.append('part-2', 'Second part text');
    expect(flushes).toEqual([{ partId: 'part-1', delta: 'First part text' }]);

    coalescer.flush();
    expect(flushes).toEqual([
      { partId: 'part-1', delta: 'First part text' },
      { partId: 'part-2', delta: 'Second part text' },
    ]);
    coalescer.dispose();
  });

  it('flushes immediately when buffered characters exceed maxBufferedChars', () => {
    const flushes: { partId: string; delta: string }[] = [];
    const coalescer = new TextCoalescer({
      flushIntervalMs: 500,
      maxBufferedChars: 10,
      onFlush: (partId, delta) => flushes.push({ partId, delta }),
    });

    coalescer.append('part-1', '12345');
    expect(flushes.length).toBe(0);

    coalescer.append('part-1', '678901');
    expect(flushes).toEqual([{ partId: 'part-1', delta: '12345678901' }]);
    coalescer.dispose();
  });
});
