import { describe, expect, it, vi } from 'vitest';
import { withSavepoint, type SavepointClient } from '@/db/tx.ts';

function fakeClient(): { client: SavepointClient; statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    client: {
      async query(text: string): Promise<unknown> {
        statements.push(text);
        return undefined;
      },
    },
  };
}

describe('withSavepoint', () => {
  it('wraps the body in SAVEPOINT/RELEASE and returns its value', async () => {
    const { client, statements } = fakeClient();

    await expect(
      withSavepoint(client, async () => 'value'),
    ).resolves.toBe('value');

    expect(statements).toEqual(['SAVEPOINT sp_1', 'RELEASE SAVEPOINT sp_1']);
  });

  it('rolls back to the savepoint and rethrows when the body fails', async () => {
    const { client, statements } = fakeClient();
    const failure = new Error('unique violation');

    await expect(
      withSavepoint(client, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(statements).toEqual([
      'SAVEPOINT sp_1',
      'ROLLBACK TO SAVEPOINT sp_1',
      'RELEASE SAVEPOINT sp_1',
    ]);
  });

  it('keeps a successful sibling committed after a failed savepoint', async () => {
    const { client, statements } = fakeClient();

    await expect(withSavepoint(client, async () => 'ok')).resolves.toBe('ok');
    await expect(
      withSavepoint(client, async () => {
        throw new Error('bad row');
      }),
    ).rejects.toThrow('bad row');

    expect(statements.at(0)).toBe('SAVEPOINT sp_1');
    expect(statements.at(2)).toBe('SAVEPOINT sp_2');
  });

  it('does not call RELEASE twice on success', async () => {
    const { client } = fakeClient();
    const spy = vi.spyOn(client, 'query');

    await withSavepoint(client, async () => undefined);

    expect(spy).toHaveBeenCalledTimes(2);
  });
});
