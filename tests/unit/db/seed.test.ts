import { describe, expect, it } from 'vitest';
import { EXAMPLE_MODELS, EXAMPLE_PROVIDERS, runExampleSeed } from '@/db/seed.ts';
import { getConfig, resetConfigForTests, setConfigForTests } from '@/config/index.ts';
import {
  SEED_DIVISIONS,
  SEED_USERS,
  SEED_QUOTA_POLICIES,
  FLAGSHIP_USER_EMAIL,
} from '@/db/seed-data/divisions-users.ts';
import {
  FLAGSHIP_CONVERSATION_ID,
  SEED_ATTACHMENTS,
  buildSeedConversations,
  buildSeedMessages,
} from '@/db/seed-data/conversations-messages.ts';
import {
  buildSeedAuditLogs,
  buildSeedErrorEvents,
  buildSeedDailyUsage,
} from '@/db/seed-data/reporting-data.ts';

describe('example registry seed data', () => {
  it('references providers only by env var name, never a secret value', () => {
    for (const provider of EXAMPLE_PROVIDERS) {
      expect(provider.secretRef).toMatch(/_API_KEY$/);
      expect(provider.secretRef).not.toMatch(/sk-|key-|secret-/i);
    }
  });

  it('every example model points at a declared provider', () => {
    const providerKeys = new Set(EXAMPLE_PROVIDERS.map((p) => p.key));
    for (const model of EXAMPLE_MODELS) {
      expect(providerKeys.has(model.providerKey)).toBe(true);
    }
  });

  it('includes a keyless FakeProvider model for local end-to-end streaming', () => {
    expect(EXAMPLE_PROVIDERS).toContainEqual({
      key: 'fake',
      displayName: 'Fake Provider',
      adapter: 'fake',
      secretRef: 'FAKE_API_KEY',
    });
    expect(EXAMPLE_MODELS).toContainEqual({
      providerKey: 'fake',
      apiModelId: 'fake-model',
      displayName: 'Fake Model (development)',
    });
  });

  it('has unique provider keys and unique (provider, apiModelId) model pairs', () => {
    const providerKeys = EXAMPLE_PROVIDERS.map((p) => p.key);
    const modelPairs = EXAMPLE_MODELS.map((m) => `${m.providerKey}:${m.apiModelId}`);
    expect(new Set(providerKeys).size).toBe(providerKeys.length);
    expect(new Set(modelPairs).size).toBe(modelPairs.length);
  });
});

describe('enterprise seed data volumes and constraints', () => {
  it('provides at least 10 enterprise divisions with non-empty names', () => {
    expect(SEED_DIVISIONS.length).toBeGreaterThanOrEqual(10);
    const divisionNames = new Set(SEED_DIVISIONS.map((d) => d.name));
    expect(divisionNames.size).toBe(SEED_DIVISIONS.length);
    for (const div of SEED_DIVISIONS) {
      expect(div.name.trim().length).toBeGreaterThan(0);
    }
  });

  it('provides > 50 users to trigger pagination, satisfying role and division invariants', () => {
    expect(SEED_USERS.length).toBeGreaterThan(50);
    const emails = new Set(SEED_USERS.map((u) => u.email.toLowerCase()));
    expect(emails.size).toBe(SEED_USERS.length);

    for (const user of SEED_USERS) {
      expect(['user', 'admin', 'super_admin']).toContain(user.role);
      expect(['active', 'disabled']).toContain(user.status);

      // Invariant: admin role requires a division
      if (user.role === 'admin') {
        expect(user.divisionName).toBeTruthy();
      }

      expect(typeof user.mustChangePassword).toBe('boolean');
      expect(user.createdAt).toBeInstanceOf(Date);
      expect(user.lastLoginAt).toBeInstanceOf(Date);
    }
  });

  it('provides quota policies for global, division, and flagship user scopes', () => {
    expect(SEED_QUOTA_POLICIES.some((p) => p.scope === 'global')).toBe(true);
    expect(SEED_QUOTA_POLICIES.some((p) => p.scope === 'division')).toBe(true);
    expect(SEED_QUOTA_POLICIES.some((p) => p.scope === 'user')).toBe(true);
  });

  it('provides > 50 conversations for the flagship user to trigger conversation pagination', () => {
    const conversations = buildSeedConversations();
    expect(conversations.length).toBeGreaterThan(50);

    const flagshipConvs = conversations.filter((c) => c.userEmail === FLAGSHIP_USER_EMAIL);
    expect(flagshipConvs.length).toBeGreaterThan(50);

    // Ensure IDs are unique
    const convIds = new Set(conversations.map((c) => c.id));
    expect(convIds.size).toBe(conversations.length);
  });

  it('provides a flagship message thread with > 50 turns and monotonic seq numbering', () => {
    const messages = buildSeedMessages();

    const flagshipMessages = messages.filter((m) => m.conversationId === FLAGSHIP_CONVERSATION_ID);
    expect(flagshipMessages.length).toBeGreaterThan(50);

    // Verify monotonic seq
    for (let i = 0; i < flagshipMessages.length; i++) {
      expect(flagshipMessages[i]!.seq).toBe(i + 1);
      if (i % 2 === 0) {
        expect(flagshipMessages[i]!.role).toBe('user');
      } else {
        expect(flagshipMessages[i]!.role).toBe('assistant');
      }
    }
  });

  it('provides attachments and extractions linked properly', () => {
    expect(SEED_ATTACHMENTS.length).toBeGreaterThan(0);
    for (const att of SEED_ATTACHMENTS) {
      expect(att.storageKey).toMatch(/^files\/\d{4}\//);
      expect(att.sha256).toHaveLength(64);
      expect(att.sizeBytes).toBeGreaterThan(0);
    }
  });

  it('provides > 50 audit logs to trigger audit pagination', () => {
    const auditLogs = buildSeedAuditLogs();
    expect(auditLogs.length).toBeGreaterThan(50);
    for (const log of auditLogs) {
      expect(log.action.length).toBeGreaterThan(0);
      expect(log.createdAt).toBeInstanceOf(Date);
    }
  });

  it('provides > 50 error events to trigger error explorer pagination', () => {
    const errorEvents = buildSeedErrorEvents();
    expect(errorEvents.length).toBeGreaterThan(50);
    for (const event of errorEvents) {
      expect(event.component.length).toBeGreaterThan(0);
      expect(event.category.length).toBeGreaterThan(0);
      expect(event.occurredAt).toBeInstanceOf(Date);
    }
  });

  it('provides daily usage rollups over multiple days', () => {
    const usageDaily = buildSeedDailyUsage();
    expect(usageDaily.length).toBeGreaterThan(0);
    const days = new Set(usageDaily.map((d) => d.day));
    expect(days.size).toBeGreaterThanOrEqual(25);
  });

  it('refuses execution when NODE_ENV === "production"', async () => {
    const current = getConfig();
    try {
      setConfigForTests({ ...current, NODE_ENV: 'production' });
      await expect(runExampleSeed()).rejects.toThrow(/never run against production/);
    } finally {
      resetConfigForTests();
    }
  });
});

