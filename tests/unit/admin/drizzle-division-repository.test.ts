import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock('@/db/client.ts', () => ({
  runDb: () => ({ execute }),
}));

import { DrizzleDivisionRepository } from '@/admin/infrastructure/drizzle-division-repository.ts';

const RANGE = { from: '2026-04-02', to: '2026-05-01' };

describe('DrizzleDivisionRepository stats read model', () => {
  beforeEach(() => {
    execute.mockReset();
  });

  it('normalizes raw SQL rows: timestamptz text and bigint strings', async () => {
    execute.mockResolvedValue({
      rows: [
        {
          id: 'div-1',
          name: 'Engineering',
          externalRef: null,
          createdAt: '2026-01-01 00:00:00+00',
          memberCount: 2,
          tokens: '1200',
          requests: 7,
          costMicros: '2500000',
          monthlyTokens: '5000000',
        },
      ],
    });

    const rows = await new DrizzleDivisionRepository().findManyWithStats(RANGE);

    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    expect(rows[0]?.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(rows[0]?.tokens).toBe(1200);
    expect(rows[0]?.costUsd).toBe(2.5);
    expect(rows[0]?.monthlyTokens).toBe(5_000_000);
  });

  it('keeps a Date instance when the driver already parsed it', async () => {
    execute.mockResolvedValue({
      rows: [
        {
          id: 'div-1',
          name: 'Engineering',
          externalRef: 'eng',
          createdAt: new Date('2026-02-03T04:05:06.000Z'),
          memberCount: 0,
          tokens: '0',
          requests: 0,
          costMicros: null,
          monthlyTokens: null,
        },
      ],
    });

    const division = await new DrizzleDivisionRepository().findWithStats('div-1', RANGE);

    expect(division?.createdAt.toISOString()).toBe('2026-02-03T04:05:06.000Z');
    expect(division?.costUsd).toBeNull();
    expect(division?.monthlyTokens).toBeNull();
  });

  it('returns null when the id does not exist', async () => {
    execute.mockResolvedValue({ rows: [] });

    await expect(
      new DrizzleDivisionRepository().findWithStats('div-missing', RANGE),
    ).resolves.toBeNull();
  });
});
