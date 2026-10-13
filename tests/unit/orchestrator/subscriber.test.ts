import { describe, expect, it } from 'vitest';
import { Subscriber } from '@/orchestrator/subscriber.ts';
import type { SSEFrame } from '@/orchestrator/events.ts';

describe('Subscriber', () => {
  it('delivers enqueued frames through async iterator', async () => {
    const subscriber = new Subscriber('sub-1');
    const frame: SSEFrame = {
      id: 1,
      event: 'message.created',
      data: '{}',
      byteLength: 20,
    };

    subscriber.push(frame);

    const iterator = subscriber[Symbol.asyncIterator]();
    const result = await iterator.next();

    expect(result.done).toBe(false);
    expect(result.value).toEqual(frame);

    subscriber.close();
    const end = await iterator.next();
    expect(end.done).toBe(true);
  });

  it('kicks subscriber when unconsumed queue exceeds maxQueueBytes', () => {
    let kickedReason = '';
    const subscriber = new Subscriber('sub-2', {
      maxQueueBytes: 50,
      onKick: (_id, reason) => {
        kickedReason = reason;
      },
    });

    const frame1: SSEFrame = {
      id: 1,
      event: 'text.delta',
      data: '12345',
      byteLength: 30,
    };
    const frame2: SSEFrame = {
      id: 2,
      event: 'text.delta',
      data: '67890',
      byteLength: 30, // 30 + 30 = 60 > 50
    };

    expect(subscriber.push(frame1)).toBe(true);
    expect(subscriber.push(frame2)).toBe(false);
    expect(kickedReason).toBe('backpressure_exceeded');
    expect(subscriber.isClosed).toBe(true);
  });
});
