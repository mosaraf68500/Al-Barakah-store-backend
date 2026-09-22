import bcrypt from 'bcryptjs';
import { getEnv } from '../config/env';

export const hashSecret = (plain: string) => bcrypt.hash(plain, getEnv().BCRYPT_COST);
export const compareSecret = (plain: string, hash: string) => bcrypt.compare(plain, hash);

let dummy: Promise<string> | undefined;
/**
 * Compare against a throw-away hash when the account does not exist, so "unknown user" and "wrong secret" cost the same time
 * (no account enumeration through response timing).
 */
export async function burnComparison(plain: string): Promise<void> {
  dummy ??= bcrypt.hash('not-a-real-secret-' + Math.random(), getEnv().BCRYPT_COST);
  await bcrypt.compare(plain, await dummy);
}
