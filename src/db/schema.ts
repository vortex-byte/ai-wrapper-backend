import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  customType,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const divisions = pgTable('divisions', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  externalRef: text('external_ref'),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: citext('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    passwordUpdatedAt: timestamptz('password_updated_at')
      .notNull()
      .default(sql`now()`),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamptz('locked_until'),
    role: text('role').notNull().default('user'),
    status: text('status').notNull().default('active'),
    divisionId: uuid('division_id').references(() => divisions.id),
    idpSubject: text('idp_subject'),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .default(sql`now()`),
    lastLoginAt: timestamptz('last_login_at'),
    deletedAt: timestamptz('deleted_at'),
  },
  (table) => [
    uniqueIndex('users_idp_subject_uq')
      .on(table.idpSubject)
      .where(sql`${table.idpSubject} IS NOT NULL`),
  ],
);

export const sessions = pgTable('sessions', {
  id: char('id', { length: 64 }).primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
  lastSeenAt: timestamptz('last_seen_at')
    .notNull()
    .default(sql`now()`),
  expiresAt: timestamptz('expires_at').notNull(),
  revokedAt: timestamptz('revoked_at'),
  rotatedFrom: char('rotated_from', { length: 64 }),
  ip: inet('ip'),
  userAgentHash: text('user_agent_hash'),
});

export const auditLogs = pgTable('audit_logs', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  requestId: text('request_id'),
  ip: inet('ip'),
  userAgentHash: text('user_agent_hash'),
  prevHash: char('prev_hash', { length: 64 }),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
});
