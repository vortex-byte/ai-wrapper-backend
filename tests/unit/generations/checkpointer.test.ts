import { describe, expect, it } from 'vitest';
import { Checkpointer } from '@/generations/application/checkpointer.ts';
import type { CheckpointTextInput, GenerationRepository } from '@/generations/ports/generation-repository.ts';

describe('Checkpointer', () => {
  it('buffers small chunks and flushes periodically', async () => {
    const checkpoints: CheckpointTextInput[] = [];
    const mockRepo: Partial<GenerationRepository> = {
      checkpointText: async (input) => {
        checkpoints.push(input);
      },
    };

    const clock = { now: () => new Date('2026-10-12T12:00:00Z') };

    const checkpointer = new Checkpointer({
      generationId: 'gen-1',
      generationRepo: mockRepo as GenerationRepository,
      clock,
      intervalMs: 20,
      maxBufferBytes: 100,
    });

    checkpointer.append('part-1', 'chunk 1', 1);
    checkpointer.append('part-1', ' chunk 2', 2);

    expect(checkpoints.length).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(checkpoints.length).toBe(1);
    expect(checkpoints[0]?.chunk).toBe('chunk 1 chunk 2');
    expect(checkpoints[0]?.lastEventSeq).toBe(2);
    expect(checkpoints[0]?.partId).toBe('part-1');

    await checkpointer.dispose();
  });

  it('flushes immediately when reaching maxBufferBytes threshold', async () => {
    const checkpoints: CheckpointTextInput[] = [];
    const mockRepo: Partial<GenerationRepository> = {
      checkpointText: async (input) => {
        checkpoints.push(input);
      },
    };

    const clock = { now: () => new Date('2026-10-12T12:00:00Z') };

    const checkpointer = new Checkpointer({
      generationId: 'gen-2',
      generationRepo: mockRepo as GenerationRepository,
      clock,
      intervalMs: 1000,
      maxBufferBytes: 10,
    });

    checkpointer.append('part-2', '12345678901', 5);

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(checkpoints.length).toBe(1);
    expect(checkpoints[0]?.chunk).toBe('12345678901');
    expect(checkpoints[0]?.lastEventSeq).toBe(5);

    await checkpointer.dispose();
  });

  it('dispose waits for an in-flight flush and drains deltas buffered during it', async () => {
    const checkpoints: CheckpointTextInput[] = [];
    const gate: { release: (() => void) | null } = { release: null };

    const mockRepo: Partial<GenerationRepository> = {
      checkpointText: async (input) => {
        // The first flush is held open so we can append while it is still in flight.
        if (gate.release === null) {
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        checkpoints.push(input);
      },
    };

    const clock = { now: () => new Date('2026-10-12T12:00:00Z') };

    const checkpointer = new Checkpointer({
      generationId: 'gen-3',
      generationRepo: mockRepo as GenerationRepository,
      clock,
      intervalMs: 5,
      maxBufferBytes: 1000,
    });

    checkpointer.append('part-3', 'first', 1);

    await new Promise((resolve) => setTimeout(resolve, 15));

    checkpointer.append('part-3', '-second', 2);

    const disposePromise = checkpointer.dispose();
    // Release the blocked first flush; dispose must not resolve before the tail is persisted.
    gate.release?.();
    await disposePromise;

    const persisted = checkpoints.map((c) => c.chunk).join('');
    expect(persisted).toBe('first-second');
  });

  it('buffers and flushes deltas across multiple part IDs without cross-contamination', async () => {
    const checkpoints: CheckpointTextInput[] = [];
    const mockRepo: Partial<GenerationRepository> = {
      checkpointText: async (input) => {
        checkpoints.push(input);
      },
    };

    const clock = { now: () => new Date('2026-10-12T12:00:00Z') };

    const checkpointer = new Checkpointer({
      generationId: 'gen-multi',
      generationRepo: mockRepo as GenerationRepository,
      clock,
      intervalMs: 1000,
      maxBufferBytes: 1000,
    });

    checkpointer.append('part-A', 'Hello A', 1);
    checkpointer.append('part-B', 'Hello B', 2);
    checkpointer.append('part-A', ' more A', 3);

    await checkpointer.flush();

    const partACheckpoints = checkpoints.filter((c) => c.partId === 'part-A');
    const partBCheckpoints = checkpoints.filter((c) => c.partId === 'part-B');

    expect(partACheckpoints).toHaveLength(1);
    expect(partACheckpoints[0]?.chunk).toBe('Hello A more A');

    expect(partBCheckpoints).toHaveLength(1);
    expect(partBCheckpoints[0]?.chunk).toBe('Hello B');

    await checkpointer.dispose();
  });
});