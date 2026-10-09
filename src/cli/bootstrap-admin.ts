import { AUDIT_ACTIONS } from '../audit/actions.ts';
import { DrizzleAuditLogRepository } from '../audit/infrastructure/drizzle-audit-log-repository.ts';
import { generateTemporaryPassword } from '../admin/domain/password-generator.ts';
import { passwordProblemMessage, validatePassword } from '../auth/domain/password-policy.ts';
import { BunPasswordHasher } from '../auth/infrastructure/bun-password-hasher.ts';
import { DrizzleUserRepository } from '../auth/infrastructure/drizzle-user-repository.ts';
import { systemClock, uuidv7Generator } from '../clock/index.ts';
import { getConfig } from '../config/index.ts';
import { withTransaction } from '../db/index.ts';

export interface BootstrapAdminArgs {
  email: string;
  displayName?: string | undefined;
  password?: string | undefined;
  force?: boolean | undefined;
}

export function parseBootstrapAdminArgs(args: string[]): BootstrapAdminArgs {
  let email = '';
  let displayName = 'System Admin';
  let password: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--email') {
      const val = args[++i];
      if (val !== undefined) email = val;
    } else if (arg === '--display-name') {
      const val = args[++i];
      if (val !== undefined) displayName = val;
    } else if (arg === '--password') {
      const val = args[++i];
      if (val !== undefined) password = val;
    } else if (arg === '--force') {
      force = true;
    }
  }

  if (!email || !email.includes('@')) {
    throw new Error('Valid --email is required. Usage: bun run cli bootstrap-admin --email admin@corp.example');
  }

  return { email: email.trim(), displayName: displayName.trim(), password, force };
}

export async function runBootstrapAdmin(parsed: BootstrapAdminArgs): Promise<number> {
  const config = getConfig();
  const users = new DrizzleUserRepository();
  const audit = new DrizzleAuditLogRepository();
  const hasher = new BunPasswordHasher();

  const activeAdminCount = await users.countActiveAdmins();
  if (activeAdminCount > 0 && !parsed.force) {
    console.error(
      `Active admin user(s) already exist (${activeAdminCount} found). Use --force to add or upgrade an admin anyway.`,
    );
    return 1;
  }

  let passwordToSet = parsed.password;
  let generated = false;
  if (!passwordToSet) {
    passwordToSet = generateTemporaryPassword();
    generated = true;
  }

  const problem = validatePassword(passwordToSet, { minLength: config.PASSWORD_MIN_LENGTH });
  if (problem !== null) {
    console.error(`Password policy error: ${passwordProblemMessage(problem, { minLength: config.PASSWORD_MIN_LENGTH })}`);
    return 1;
  }

  const passwordHash = await hasher.hash(passwordToSet);
  const now = systemClock.now();
  const existingUser = await users.findByEmail(parsed.email);

  let userId = '';
  let createdNew = false;

  await withTransaction(async (tx) => {
    if (existingUser) {
      userId = existingUser.id;
      await users.update(
        {
          id: existingUser.id,
          displayName: parsed.displayName ?? existingUser.displayName,
          role: 'admin',
          status: 'active',
          at: now,
        },
        tx,
      );
      await users.setPassword(
        {
          id: existingUser.id,
          passwordHash,
          mustChangePassword: true,
          at: now,
        },
        tx,
      );

      await audit.append(
        {
          actorUserId: null,
          action: AUDIT_ACTIONS.userUpdate,
          targetType: 'user',
          targetId: existingUser.id,
          before: { role: existingUser.role, status: existingUser.status },
          after: { role: 'admin', status: 'active', bootstrapped: true },
        },
        tx,
      );
    } else {
      userId = uuidv7Generator.uuidv7();
      createdNew = true;
      await users.create(
        {
          id: userId,
          email: parsed.email,
          displayName: parsed.displayName ?? 'System Admin',
          passwordHash,
          role: 'admin',
          status: 'active',
          mustChangePassword: true,
        },
        tx,
      );

      await audit.append(
        {
          actorUserId: null,
          action: AUDIT_ACTIONS.userCreate,
          targetType: 'user',
          targetId: userId,
          after: { email: parsed.email, role: 'admin', status: 'active', bootstrapped: true },
        },
        tx,
      );
    }
  });

  console.log(`✓ Admin user ${createdNew ? 'created' : 'upgraded'}:`);
  console.log(`  ID:                 ${userId}`);
  console.log(`  Email:              ${parsed.email}`);
  console.log(`  Role:               admin`);
  console.log(`  Must change pass:   true`);
  if (generated) {
    console.log(`  Temporary password: ${passwordToSet}`);
    console.log(`\nNote: Save this temporary password. It will not be shown again.`);
  } else {
    console.log(`  Password:           (the value you supplied via --password)`);
  }

  return 0;
}
