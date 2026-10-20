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

describe('last-super-admin domain safeguard', () => {
  it('prevents demoting or disabling the only active super_admin', () => {
    const superAdminUser = makeUser({ role: 'super_admin', status: 'active' });

    expect(
      canUpdateUserRoleOrStatus({
        targetUser: superAdminUser,
        newRole: 'user',
        activeSuperAdminCount: 1,
      }),
    ).toBe(false);

    expect(
      canUpdateUserRoleOrStatus({
        targetUser: superAdminUser,
        newStatus: 'disabled',
        activeSuperAdminCount: 1,
      }),
    ).toBe(false);

    expect(
      canUpdateUserRoleOrStatus({
        targetUser: superAdminUser,
        newRole: 'user',
        activeSuperAdminCount: 2,
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
  const superAdminCaller = {
    actorUserId: 'admin-1',
    role: 'super_admin' as const,
    divisionId: null,
    meta,
  };

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
    const adminUser = makeUser({ id: 'admin-1', role: 'super_admin' });
    harness.users.seed(adminUser);

    const res = await admin.createUser({
      email: 'newuser@corp.example',
      displayName: 'New User',
      role: 'user',
      generatePassword: true,
      caller: superAdminCaller,
    });

    expect(res.user.email).toBe('newuser@corp.example');
    expect(res.user.mustChangePassword).toBe(true);
    expect(res.temporaryPassword).toBeDefined();
    expect(harness.audit.actions()).toContain('user.create');
  });

  it('prevents demoting the last super admin', async () => {
    const { admin, harness } = setup();
    const onlyAdmin = makeUser({ id: 'admin-1', role: 'super_admin', status: 'active' });
    harness.users.seed(onlyAdmin);

    await expect(
      admin.updateUser({
        id: 'admin-1',
        role: 'user',
        caller: superAdminCaller,
      }),
    ).rejects.toThrow('Cannot disable or demote the last active super admin.');
  });

  it('never exposes passwordHash through its read surface', async () => {
    const { admin, harness } = setup();
    const list = await admin.listUsers({}, superAdminCaller);
    harness.users.seed(makeUser({ id: 'u1', passwordHash: 'plain$secret' }));

    const listed = await admin.listUsers({}, superAdminCaller);
    expect(list.items).toHaveLength(0);
    expect(listed.items[0]).not.toHaveProperty('passwordHash');

    const fetched = await admin.getUser('u1', superAdminCaller);
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

    const first = await admin.listUsers({ limit: 2 }, superAdminCaller);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await admin.listUsers(
      { limit: 2, cursor: first.nextCursor ?? undefined },
      superAdminCaller,
    );
    expect(second.items).toHaveLength(2);
    const firstIds = new Set(first.items.map((u) => u.id));
    expect(second.items.every((u) => !firstIds.has(u.id))).toBe(true);
  });

  describe('division admin isolation & rules', () => {
    const div1Caller = {
      actorUserId: 'admin-div-1',
      role: 'admin' as const,
      divisionId: 'div-1',
      meta,
    };

    it('forces divisionId on create and restricts role to user', async () => {
      const { admin, harness, divisions } = setup();
      await divisions.create({ id: 'div-1', name: 'Division 1' });
      harness.users.seed(
        makeUser({ id: 'admin-div-1', role: 'admin', divisionId: 'div-1', status: 'active' }),
      );

      // Attempt to create super_admin or admin fails with forbidden
      await expect(
        admin.createUser({
          email: 'admin2@corp.example',
          displayName: 'Admin 2',
          role: 'admin',
          generatePassword: true,
          caller: div1Caller,
        }),
      ).rejects.toThrow('Division administrators can only provision users with the user role.');

      // Valid creation forces divisionId = caller.divisionId
      const created = await admin.createUser({
        email: 'user-in-div1@corp.example',
        displayName: 'User In Div 1',
        role: 'user',
        generatePassword: true,
        divisionId: 'some-other-div', // ignored/overridden
        caller: div1Caller,
      });

      expect(created.user.divisionId).toBe('div-1');
      expect(created.user.role).toBe('user');
    });

    it('returns 404 when division admin accesses or modifies users in other divisions', async () => {
      const { admin, harness } = setup();
      harness.users.seed(
        makeUser({ id: 'admin-div-1', role: 'admin', divisionId: 'div-1', status: 'active' }),
      );
      harness.users.seed(
        makeUser({ id: 'user-div-2', role: 'user', divisionId: 'div-2', status: 'active' }),
      );

      // getUser returns 404
      await expect(admin.getUser('user-div-2', div1Caller)).rejects.toThrow('User not found.');

      // updateUser returns 404
      await expect(
        admin.updateUser({
          id: 'user-div-2',
          displayName: 'Hacked Name',
          caller: div1Caller,
        }),
      ).rejects.toThrow('User not found.');

      // resetUserPassword returns 404
      await expect(
        admin.resetUserPassword({
          id: 'user-div-2',
          generatePassword: true,
          caller: div1Caller,
        }),
      ).rejects.toThrow('User not found.');
    });

    it('forbids division admin from changing role or division of users in own division', async () => {
      const { admin, harness } = setup();
      harness.users.seed(
        makeUser({ id: 'admin-div-1', role: 'admin', divisionId: 'div-1', status: 'active' }),
      );
      harness.users.seed(
        makeUser({ id: 'user-div-1', role: 'user', divisionId: 'div-1', status: 'active' }),
      );

      await expect(
        admin.updateUser({
          id: 'user-div-1',
          role: 'admin',
          caller: div1Caller,
        }),
      ).rejects.toThrow('Division administrators cannot change user roles.');

      await expect(
        admin.updateUser({
          id: 'user-div-1',
          divisionId: 'div-2',
          caller: div1Caller,
        }),
      ).rejects.toThrow('Division administrators cannot reassign user divisions.');
    });

    it('prevents division admin without division from listing users', async () => {
      const { admin, harness } = setup();
      harness.users.seed(makeUser({ id: 'admin-unassigned', role: 'admin', divisionId: null }));
      const unassignedCaller = {
        actorUserId: 'admin-unassigned',
        role: 'admin' as const,
        divisionId: null,
        meta,
      };

      await expect(admin.listUsers({}, unassignedCaller)).rejects.toThrow(
        'Division administrator must belong to a division.',
      );
    });

    it('prevents division admin from targeting super_admin or peer admin in same division', async () => {
      const { admin, harness } = setup();
      harness.users.seed(
        makeUser({ id: 'admin-div-1', role: 'admin', divisionId: 'div-1', status: 'active' }),
      );
      harness.users.seed(
        makeUser({ id: 'super-admin-div-1', role: 'super_admin', divisionId: 'div-1', status: 'active' }),
      );
      harness.users.seed(
        makeUser({ id: 'peer-admin-div-1', role: 'admin', divisionId: 'div-1', status: 'active' }),
      );

      await expect(admin.getUser('super-admin-div-1', div1Caller)).rejects.toThrow(
        'User not found.',
      );
      await expect(admin.getUser('peer-admin-div-1', div1Caller)).rejects.toThrow(
        'User not found.',
      );

      await expect(
        admin.updateUser({
          id: 'super-admin-div-1',
          displayName: 'Hacked Super',
          caller: div1Caller,
        }),
      ).rejects.toThrow('User not found.');

      await expect(
        admin.updateUser({
          id: 'peer-admin-div-1',
          status: 'disabled',
          caller: div1Caller,
        }),
      ).rejects.toThrow('User not found.');

      await expect(
        admin.resetUserPassword({
          id: 'super-admin-div-1',
          generatePassword: true,
          caller: div1Caller,
        }),
      ).rejects.toThrow('User not found.');

      await expect(
        admin.resetUserPassword({
          id: 'peer-admin-div-1',
          generatePassword: true,
          caller: div1Caller,
        }),
      ).rejects.toThrow('User not found.');
    });

    it('forbids division admin from self-disabling', async () => {
      const { admin, harness } = setup();
      harness.users.seed(
        makeUser({ id: 'admin-div-1', role: 'admin', divisionId: 'div-1', status: 'active' }),
      );

      await expect(
        admin.updateUser({
          id: 'admin-div-1',
          status: 'disabled',
          caller: div1Caller,
        }),
      ).rejects.toThrow('Cannot disable your own administrator account.');
    });
  });
});
