/**
 * Creates the FIRST super_admin from SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD (env vars, never CLI args or files in git).
 *   npm run seed:super-admin              create if missing (idempotent, never touches an existing account)
 *   npm run seed:super-admin -- --reset-password   rotate the password of the existing seeded super_admin
 * Further admins are added through POST /v1/admin-auth/grant-access by a super_admin.
 */
import 'dotenv/config';
import { z } from 'zod';
import { connectDb, disconnectDb } from '../src/config/db';
import { getEnv } from '../src/config/env';
import { recordAudit } from '../src/modules/audit/audit.service';
import { UserModel } from '../src/modules/users/user.model';
import { revokeAllForUser } from '../src/modules/users/token.service';
import { hashSecret } from '../src/utils/password';

export async function seedSuperAdmin(opts: { resetPassword?: boolean } = {}) {
  const env = getEnv();
  const parsed = z
    .object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(12, 'SUPER_ADMIN_PASSWORD must be at least 12 characters').max(128) })
    .safeParse({ email: env.SUPER_ADMIN_EMAIL, password: env.SUPER_ADMIN_PASSWORD });
  if (!parsed.success) throw new Error(`SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  const { email, password } = parsed.data;

  await connectDb();
  const existing = await UserModel.findOne({ email });
  if (existing) {
    if (existing.role !== 'super_admin') throw new Error(`A different account already uses ${email} (role ${existing.role}); refusing to promote it`);
    if (!opts.resetPassword) return { created: false, message: 'super_admin already exists - nothing changed' };
    existing.passwordHash = await hashSecret(password);
    await existing.save();
    await revokeAllForUser(existing._id); // a rotated password must end every existing session
    await recordAudit({ actor: { id: existing._id, email, role: 'super_admin' }, action: 'admin.super_admin.password_reset', entity: 'User', entityId: String(existing._id) });
    return { created: false, message: 'super_admin password rotated; all sessions revoked' };
  }
  if ((await UserModel.countDocuments({ role: 'super_admin' })) > 0) {
    throw new Error('A super_admin already exists under a different e-mail; refusing to create a second one via the seed script');
  }
  const user = await UserModel.create({ role: 'super_admin', name: 'Super Admin', email, passwordHash: await hashSecret(password), isActive: true });
  await recordAudit({ actor: { id: user._id, email, role: 'super_admin' }, action: 'admin.super_admin.seeded', entity: 'User', entityId: String(user._id) });
  return { created: true, message: `super_admin ${email} created` };
}

if (require.main === module) {
  seedSuperAdmin({ resetPassword: process.argv.includes('--reset-password') })
    .then((r) => console.log(r.message))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => disconnectDb());
}
