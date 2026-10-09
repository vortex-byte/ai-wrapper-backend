import { describe, expect, it } from 'vitest';
import { createAdminService } from '@/admin/application/admin-service.ts';
import { canUpdateUserRoleOrStatus } from '@/admin/domain/last-admin.ts';
import { generateTemporaryPassword } from '@/admin/domain/password-generator.ts';
import type { Division, DivisionRepository } from '@/admin/ports/division-repository.ts';
import { createHarness, makeUser } from '../auth/fakes.ts';

class InMemoryDivisionRepository implements DivisionRepository {
  readonly rows = new Map<string, Division>();

  async findById(id: string): Promise<Division | null> {
    return this.rows.get(id) ?? null;
  }
  async findByName(name: string): Promise<Division | null> {
    for (const d of this.rows.values()) {
      if (d.name === name) return d;
    }
    return null;
  }
  async findMany(): Promise<Division[]> {
    return Array.from(this.rows.values());
  }
  async create(input: { id: string; name: string; externalRef?: string | null }): Promise<Division> {
    const div: Division = {
      id: input.id,
      name: input.name,
      externalRef: input.externalRef ?? null,
      createdAt: new Date(),
    };
    this.rows.set(div.id, div);
    return div;
  }
  async update(input: { id: string; name?: string; externalRef?: string | null }): Promise<Division> {
    const target = this.rows.get(input.id);
    if (!target) throw new Error('not found');
    const updated = {
      ...target,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.externalRef !== undefined ? { externalRef: input.externalRef } : {}),
    };
    this.rows.set(target.id, updated);
    return updated;
  }
}

describe('last-admin domain safeguard', () => {
  it('prevents demoting or disabling the only active admin', () => {
    const adminUser = makeUser({ role: 'admin', status: 'active' });

    expect(
      canUpdateUserRoleOrStatus({
        targetUser: adminUser,
        newRole: 'user',
        activeAdminCount: 1,
      }),
    ).toBe(false);

    expect(
      canUpdateUserRoleOrStatus({
        targetUser: adminUser,
        newStatus: 'disabled',
        activeAdminCount: 1,
      }),
    ).toBe(false);

    expect(
      canUpdateUserRoleOrStatus({
        targetUser: adminUser,
        newRole: 'user',
        activeAdminCount: 2,
      }),
    ).toBe(true);
  });
});

describe('generateTemporaryPassword', () => {
  it('generates a 14-char hyphenated password', () => {
    const pass = generateTemporaryPassword();
    expect(pass.length).toBe(14);
    expect(pass.split('-')).toHaveLength(3);
  });

  it('uses only the intended alphabet and varies across calls', () => {
    const allowed = new Set('23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ-');
    const samples = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const pass = generateTemporaryPassword();
      for (const ch of pass) expect(allowed.has(ch)).toBe(true);
      samples.add(pass);
    }
    expect(samples.size).toBeGreaterThan(40);
  });
});

describe('admin service', () => {
  const meta = { ip: '127.0.0.1', userAgentHash: 'hash', requestId: 'req-1' };

  function setup() {
    const harness = createHarness();
    const divisions = new InMemoryDivisionRepository();
    const admin = createAdminService({
      users: harness.users,
      divisions,
      sessions: harness.sessions,
      hasher: harness.hasher,
      audit: harness.audit,
      clock: harness.clock,
      idGen: { uuidv7: () => 'gen-uuid-1' },
      passwordPolicy: harness.deps.passwordPolicy,
    });
    return { harness, divisions, admin };
  }

  it('creates a user with generated temporary password and logs audit', async () => {
    const { admin, harness } = setup();
    const adminUser = makeUser({ id: 'admin-1', role: 'admin' });
    harness.users.seed(adminUser);

    const res = await admin.createUser({
      email: 'newuser@corp.example',
      displayName: 'New User',
      role: 'user',
      generatePassword: true,
      actorUserId: 'admin-1',
      meta,
    });

    expect(res.user.email).toBe('newuser@corp.example');
    expect(res.user.mustChangePassword).toBe(true);
    expect(res.temporaryPassword).toBeDefined();
    expect(harness.audit.actions()).toContain('user.create');
  });

  it('prevents demoting the last admin', async () => {
    const { admin, harness } = setup();
    const onlyAdmin = makeUser({ id: 'admin-1', role: 'admin', status: 'active' });
    harness.users.seed(onlyAdmin);

    await expect(
      admin.updateUser({
        id: 'admin-1',
        role: 'user',
        actorUserId: 'admin-1',
        meta,
      }),
    ).rejects.toThrow('Cannot disable or demote the last active admin.');
  });

  it('never exposes passwordHash through its read surface', async () => {
    const { admin, harness } = setup();
    const list = await admin.listUsers({});
    harness.users.seed(makeUser({ id: 'u1', passwordHash: 'plain$secret' }));

    const listed = await admin.listUsers({});
    expect(list.items).toHaveLength(0);
    expect(listed.items[0]).not.toHaveProperty('passwordHash');

    const fetched = await admin.getUser('u1');
    expect(fetched).not.toHaveProperty('passwordHash');
  });

  it('paginates with a keyset cursor in the in-memory repository', async () => {
    const { admin, harness } = setup();
    for (let i = 0; i < 5; i++) {
      harness.users.seed(
        makeUser({
          id: `00000000-0000-7000-8000-00000000000${i}`,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        }),
      );
    }

    const first = await admin.listUsers({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await admin.listUsers({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(2);
    const firstIds = new Set(first.items.map((u) => u.id));
    expect(second.items.every((u) => !firstIds.has(u.id))).toBe(true);
  });
});
