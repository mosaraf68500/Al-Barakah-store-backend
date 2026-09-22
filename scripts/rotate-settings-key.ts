/**
 * Rotate the key that encrypts integration secrets in MongoDB (SETTINGS_ENCRYPTION_KEY).
 *
 *   1. generate a new key:   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   2. run WITH the old key in OLD_SETTINGS_ENCRYPTION_KEY (or in SETTINGS_ENCRYPTION_KEY_PREVIOUS) and the NEW key in SETTINGS_ENCRYPTION_KEY:
 *        OLD_SETTINGS_ENCRYPTION_KEY=<old> SETTINGS_ENCRYPTION_KEY=<new> npm run rotate-settings-key            # do it
 *        OLD_SETTINGS_ENCRYPTION_KEY=<old> SETTINGS_ENCRYPTION_KEY=<new> npm run rotate-settings-key -- --dry-run   # only count
 *   3. deploy the new SETTINGS_ENCRYPTION_KEY, then discard the old key.
 * Every secret is decrypted with whichever key encrypted it and re-encrypted under the CURRENT key; already-current values are untouched,
 * so the script is idempotent (a second run reports 0). No secret value is ever printed.
 */
import 'dotenv/config';
import { connectDb, disconnectDb } from '../src/config/db';
import { resetEnvCacheForTests } from '../src/config/env';
import { reencryptSecrets } from '../src/modules/settings/settings.service';

export async function rotateSettingsKey(opts: { dryRun?: boolean } = {}) {
  const old = process.env.OLD_SETTINGS_ENCRYPTION_KEY?.trim();
  if (old) {
    const prev = process.env.SETTINGS_ENCRYPTION_KEY_PREVIOUS?.trim();
    process.env.SETTINGS_ENCRYPTION_KEY_PREVIOUS = prev ? `${prev},${old}` : old;
    resetEnvCacheForTests();
  }
  await connectDb();
  return reencryptSecrets({ dryRun: opts.dryRun });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  rotateSettingsKey({ dryRun })
    .then((r) => console.log(dryRun ? `dry run: ${r.reencrypted} secret(s) would be re-encrypted` : `re-encrypted ${r.reencrypted} secret(s) under the current key`))
    .catch((e) => {
      console.error(e.message); // messages never contain secret values
      process.exitCode = 1;
    })
    .finally(() => disconnectDb());
}
