import { describe, expect, it } from 'vitest';
import { createAdminService } from '@/admin/application/admin-service.ts';
import { canUpdateUserRoleOrStatus } from '@/admin/domain/last-admin.ts';
import { generateTemporaryPassword } from '@/crypto.ts';
import type {
  Division,
  DivisionReferenceCounts,
  DivisionRepository,
  DivisionStatsRange,
  DivisionWithStats,
} from '@/admin/ports/division-repository.ts';
import { createHarness, makeUser } from '../auth/fakes.ts';

class InMemoryDivisionRepository implements DivisionRepository {
  readonly rows = new Map<string, Division>();
  readonly stats: DivisionWithStats[] = [];
  readonly ranges: DivisionStatsRange[] = [];
  readonly deleted: string[] = [];
  references: DivisionReferenceCounts = {
    users: 0,
    quotaPolicies: 0,
    usageEvents: 0,
    usageDaily: 0,
  };

  async findById(id: string): Promise<Division | null> {
    return this.rows.get(id) ?? null;
  }
  async findByName(name: string): Promise<Division | null> {
    for (const d of this.rows.values()) {
      if (d.name === name) return d;
    }
    return null;
  }
  async findByExternalRef(externalRef: string): Promise<Division | null> {
    for (const d of this.rows.values()) {
      if (d.externalRef === externalRef) return d;
    }
    return null;
  }
  async findMany(): Promise<Division[]> {
    return Array.from(this.rows.values());
  }
  async findManyWithStats(range: DivisionStatsRange): Promise<DivisionWithStats[]> {
    this.ranges.push(range);
    return this.stats;
  }
  async findWithStats(id: string, range: DivisionStatsRange): Promise<DivisionWithStats | null> {
    this.ranges.push(range);
    return this.stats.find((row) => row.id === id) ?? null;
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
  async countReferences(): Promise<DivisionReferenceCounts> {
    return this.references;
  }
  async delete(id: string): Promise<boolean> {
    this.deleted.push(id);
    return this.rows.delete(id);
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

  it('updates the login email and records it in the audit trail', async () => {
    const { admin, harness } = setup();
    harness.users.seed(makeUser({ id: 'admin-1', role: 'super_admin', status: 'active' }));
    harness.users.seed(makeUser({ id: 'u1', email: 'old@corp.example', role: 'user' }));

    const updated = await admin.updateUser({
      id: 'u1',
      email: 'new@corp.example',
      caller: superAdminCaller,
    });

    expect(updated.email).toBe('new@corp.example');
    expect(harness.users.rows.get('u1')?.email).toBe('new@corp.example');
    expect(harness.audit.entries.at(-1)).toMatchObject({
      action: 'user.update',
      before: { email: 'old@corp.example' },
      after: { email: 'new@corp.example' },
    });
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

    it('lets a division admin change the email of a user in its own division', async () => {
      const { admin, harness } = setup();
      harness.users.seed(
        makeUser({ id: 'admin-div-1', role: 'admin', divisionId: 'div-1', status: 'active' }),
      );
      harness.users.seed(
        makeUser({ id: 'user-div-1', email: 'before@corp.example', role: 'user', divisionId: 'div-1' }),
      );

      const updated = await admin.updateUser({
        id: 'user-div-1',
        email: 'after@corp.example',
        caller: div1Caller,
      });

      expect(updated.email).toBe('after@corp.example');
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

  describe('division read model', () => {
    it('lists divisions with stats over an inclusive UTC day window', async () => {
      const { admin, divisions } = setup();
      divisions.stats.push({
        id: 'div-1',
        name: 'Engineering',
        externalRef: 'eng',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        memberCount: 3,
        tokens: 12_000,
        requests: 8,
        costUsd: 0.42,
        monthlyTokens: 1_000_000,
      });

      const rows = await admin.listDivisions(30);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.memberCount).toBe(3);
      expect(rows[0]?.monthlyTokens).toBe(1_000_000);
      expect(divisions.ranges[0]).toEqual({ from: '2026-04-02', to: '2026-05-01' });
    });

    it('returns a single division with stats', async () => {
      const { admin, divisions } = setup();
      divisions.stats.push({
        id: 'div-1',
        name: 'Engineering',
        externalRef: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        memberCount: 0,
        tokens: 0,
        requests: 0,
        costUsd: null,
        monthlyTokens: null,
      });

      const division = await admin.getDivision('div-1', 7);

      expect(division.name).toBe('Engineering');
      expect(division.monthlyTokens).toBeNull();
      expect(divisions.ranges[0]).toEqual({ from: '2026-04-25', to: '2026-05-01' });
    });

    it('rejects an unknown division id with not_found', async () => {
      const { admin } = setup();

      await expect(admin.getDivision('div-missing', 30)).rejects.toMatchObject({
        code: 'not_found',
      });
    });

    it('deletes an unreferenced division and records an audit log', async () => {
      const { admin, divisions, harness } = setup();
      divisions.rows.set('div-1', {
        id: 'div-1',
        name: 'Empty Team',
        externalRef: 'empty',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });

      await admin.deleteDivision({
        id: 'div-1',
        actorUserId: 'admin-1',
        meta: { ip: '127.0.0.1', requestId: 'req-1', userAgentHash: null },
      });

      expect(divisions.deleted).toContain('div-1');
      expect(divisions.rows.has('div-1')).toBe(false);
      expect(harness.audit.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'division.delete',
            targetType: 'division',
            targetId: 'div-1',
          }),
        ]),
      );
    });

    it('rejects deletion with conflict when the division still has members or usage', async () => {
      const { admin, divisions } = setup();
      divisions.rows.set('div-1', {
        id: 'div-1',
        name: 'Engineering',
        externalRef: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      divisions.references = { users: 3, quotaPolicies: 1, usageEvents: 0, usageDaily: 0 };

      await expect(
        admin.deleteDivision({
          id: 'div-1',
          actorUserId: 'admin-1',
          meta: { ip: '127.0.0.1', requestId: 'req-1', userAgentHash: null },
        }),
      ).rejects.toMatchObject({
        code: 'conflict',
        message: expect.stringContaining('3 users'),
      });

      expect(divisions.rows.has('div-1')).toBe(true);
    });
  });
});

describe('admin service importUsers', () => {
  const meta = { ip: '127.0.0.1', userAgentHash: 'hash', requestId: 'req-1' };

  function setup() {
    const harness = createHarness();
    const divisions = new InMemoryDivisionRepository();
    let nextId = 0;
    const admin = createAdminService({
      users: harness.users,
      divisions,
      sessions: harness.sessions,
      hasher: harness.hasher,
      audit: harness.audit,
      clock: harness.clock,
      idGen: { uuidv7: () => `gen-${++nextId}` },
      passwordPolicy: harness.deps.passwordPolicy,
    });
    return { harness, divisions, admin };
  }

  it('creates users with a shared temporary password and audit entries', async () => {
    const { admin, divisions, harness } = setup();
    divisions.rows.set('div-1', {
      id: 'div-1',
      name: 'Engineering',
      externalRef: 'ENG-01',
      createdAt: new Date(),
    });

    const result = await admin.importUsers({
      rows: [
        { email: 'a@corp.example', name: 'A', division: 'ENG-01' },
        { email: 'b@corp.example', name: 'B' },
      ],
      caller: { actorUserId: 'admin-1', role: 'super_admin', divisionId: null, meta },
    });

    expect(result.created).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.temporaryPassword).toBeTruthy();
    expect(result.created[0]?.divisionExternalRef).toBe('ENG-01');
    expect(result.created[1]?.divisionExternalRef).toBeNull();

    const a = await harness.users.findByEmail('a@corp.example');
    expect(a).not.toBeNull();
    expect(a?.mustChangePassword).toBe(true);
    expect(a?.divisionId).toBe('div-1');
    expect(a?.passwordHash).toBe(`plain$${result.temporaryPassword}`);

    expect(harness.audit.entries.filter((e) => e.action === 'user.create')).toHaveLength(2);
  });

  it('reports unknown division refs, duplicates, and existing emails as row errors', async () => {
    const { admin, harness } = setup();
    harness.users.seed(makeUser({ id: 'existing', email: 'taken@corp.example' }));

    const result = await admin.importUsers({
      rows: [
        { email: 'a@corp.example', name: 'A', division: 'NOPE' },
        { email: 'taken@corp.example', name: 'T' },
        { email: 'taken@corp.example', name: 'Dup' },
        { email: 'fresh@corp.example', name: 'F', division: 'NOPE' },
      ],
      caller: { actorUserId: 'admin-1', role: 'super_admin', divisionId: null, meta },
    });

    expect(result.created).toHaveLength(0);
    expect(result.errors.map((e) => e.reason)).toEqual([
      expect.stringContaining("NOPE"),
      'Email duplikat di dalam file.',
      expect.stringContaining("NOPE"),
      'Email sudah terdaftar di sistem.',
    ]);
  });

  it('forces division admins into their own division and rejects other refs', async () => {
    const { admin, divisions, harness } = setup();
    divisions.rows.set('div-1', {
      id: 'div-1',
      name: 'Engineering',
      externalRef: 'ENG-01',
      createdAt: new Date(),
    });
    divisions.rows.set('div-2', {
      id: 'div-2',
      name: 'Finance',
      externalRef: 'FIN-02',
      createdAt: new Date(),
    });

    const result = await admin.importUsers({
      rows: [
        { email: 'a@corp.example', name: 'A', division: 'ENG-01' },
        { email: 'b@corp.example', name: 'B', division: 'FIN-02' },
        { email: 'c@corp.example', name: 'C' },
      ],
      caller: { actorUserId: 'admin-1', role: 'admin', divisionId: 'div-1', meta },
    });

    expect(result.created.map((u) => u.email)).toEqual(['a@corp.example', 'c@corp.example']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.email).toBe('b@corp.example');

    for (const email of ['a@corp.example', 'c@corp.example']) {
      const user = await harness.users.findByEmail(email);
      expect(user?.divisionId).toBe('div-1');
    }
  });

  it('rejects division admins without a division', async () => {
    const { admin } = setup();
    await expect(
      admin.importUsers({
        rows: [{ email: 'a@corp.example', name: 'A' }],
        caller: { actorUserId: 'admin-1', role: 'admin', divisionId: null, meta },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('admin service deleteUser', () => {
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
      idGen: { uuidv7: () => 'gen-1' },
      passwordPolicy: harness.deps.passwordPolicy,
    });
    return { harness, divisions, admin };
  }

  it('soft deletes user, revokes sessions, and appends audit log', async () => {
    const { admin, harness } = setup();
    const target = makeUser({ id: 'target-1', role: 'user', status: 'active' });
    harness.users.seed(target);
    await harness.sessions.insert({
      id: 'session-1',
      userId: target.id,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      ip: null,
      userAgentHash: null,
      rotatedFrom: null,
    });

    await admin.deleteUser({
      id: target.id,
      caller: { actorUserId: 'admin-1', role: 'super_admin', divisionId: null, meta },
    });

    const updated = await harness.users.findById(target.id);
    expect(updated?.deletedAt).not.toBeNull();
    expect(updated?.status).toBe('disabled');

    const session = await harness.sessions.findById('session-1');
    expect(session?.revokedAt).not.toBeNull();

    expect(harness.audit.entries.some((e) => e.action === 'user.delete' && e.targetId === target.id)).toBe(true);
  });

  it('prevents self deletion', async () => {
    const { admin, harness } = setup();
    const me = makeUser({ id: 'admin-1', role: 'super_admin' });
    harness.users.seed(me);

    await expect(
      admin.deleteUser({
        id: 'admin-1',
        caller: { actorUserId: 'admin-1', role: 'super_admin', divisionId: null, meta },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('prevents deleting the last active super_admin', async () => {
    const { admin, harness } = setup();
    const soleSuperAdmin = makeUser({ id: 'sole-super', role: 'super_admin', status: 'active' });
    harness.users.seed(soleSuperAdmin);

    await expect(
      admin.deleteUser({
        id: 'sole-super',
        caller: { actorUserId: 'admin-2', role: 'super_admin', divisionId: null, meta },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('enforces division isolation for division admins', async () => {
    const { admin, harness } = setup();
    const otherDivUser = makeUser({ id: 'u-other', divisionId: 'div-2', role: 'user' });
    const sameDivAdmin = makeUser({ id: 'u-adm', divisionId: 'div-1', role: 'admin' });
    const sameDivUser = makeUser({ id: 'u-ok', divisionId: 'div-1', role: 'user' });
    harness.users.seed(otherDivUser);
    harness.users.seed(sameDivAdmin);
    harness.users.seed(sameDivUser);

    await expect(
      admin.deleteUser({
        id: otherDivUser.id,
        caller: { actorUserId: 'div-admin-1', role: 'admin', divisionId: 'div-1', meta },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    await expect(
      admin.deleteUser({
        id: sameDivAdmin.id,
        caller: { actorUserId: 'div-admin-1', role: 'admin', divisionId: 'div-1', meta },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    await expect(
      admin.deleteUser({
        id: sameDivUser.id,
        caller: { actorUserId: 'div-admin-1', role: 'admin', divisionId: 'div-1', meta },
      }),
    ).resolves.toBeUndefined();
  });
});
