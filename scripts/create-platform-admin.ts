/**
 * Create a platform admin (SaaS phase 5) — how the very first one comes to exist; after that,
 * admins with `platform:admins` add others from the platform screens.
 *
 *   npm run platform:create-admin -- --email you@example.com --name "Your Name"
 *
 * The password is read from PLATFORM_ADMIN_PASSWORD, never from the command line (where it would
 * sit in shell history). Without it, a strong one is generated, printed once, and the admin must
 * change it at first sign-in. The new admin gets every platform permission.
 *
 * Refuses if the email already has a platform admin; add `--reset-password` to set a new password
 * on that account instead (it then has to be changed at next sign-in).
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { PlatformAdmin } from '../src/modules/platform/platformAdmin.model.js';
import { PLATFORM_PERMISSIONS } from '../src/shared/platform.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    'reset-password': { type: 'boolean', default: false },
  },
});

const email = values.email?.trim().toLowerCase();
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Usage: npm run platform:create-admin -- --email you@example.com --name "Your Name"');
  process.exit(2);
}

const given = process.env.PLATFORM_ADMIN_PASSWORD;
if (given !== undefined && given.length < 8) {
  console.error('PLATFORM_ADMIN_PASSWORD must be at least 8 characters.');
  process.exit(2);
}
const password = given ?? randomBytes(12).toString('base64url');

await connectDatabase();
try {
  const existing = await PlatformAdmin.findOne({ email }).select('+passwordHash');

  if (existing && !values['reset-password']) {
    console.error(`A platform admin with ${email} already exists. Add --reset-password to reset it.`);
    process.exitCode = 1;
  } else if (existing) {
    existing.passwordHash = password;
    existing.mustChangePassword = true;
    existing.isActive = true;
    existing.tokenVersion += 1;
    await existing.save();
    console.log(`\nPassword reset for platform admin ${email}.`);
  } else {
    await new PlatformAdmin({
      name: values.name?.trim() || email,
      email,
      passwordHash: password,
      permissions: [...PLATFORM_PERMISSIONS],
      mustChangePassword: given === undefined,
    }).save();
    console.log(`\nPlatform admin created: ${email} (every platform permission).`);
  }

  if (process.exitCode !== 1 && given === undefined) {
    console.log(`Temporary password (shown once — change it after signing in): ${password}\n`);
  }
} finally {
  await disconnectDatabase();
}
