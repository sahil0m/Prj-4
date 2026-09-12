/**
 * Backfills User.role and the AI counters for accounts created before those
 * fields existed.
 *
 * Mongoose defaults apply to new documents, not to rows already in the
 * collection, so an older account reads back with role undefined. That is
 * not merely cosmetic: code that compares role === 'admin' is fine, but the
 * admin list showed "undefined" and any future check for role === 'user'
 * would silently not match.
 *
 * Safe to run repeatedly: it only fills values that are missing.
 */
import { connectDb, disconnectDb } from '../lib/db.js';
import { User } from '../models/index.js';
import { logger } from '../lib/logger.js';

async function main(): Promise<void> {
  await connectDb();

  const roles = await User.collection.updateMany(
    { role: { $exists: false } },
    { $set: { role: 'user' } },
  );

  const suspension = await User.collection.updateMany(
    { suspendedAt: { $exists: false } },
    { $set: { suspendedAt: null, suspendedReason: '' } },
  );

  const counters = await User.collection.updateMany(
    { aiRequestsToday: { $exists: false } },
    { $set: { aiRequestsToday: 0, aiRequestsResetAt: null } },
  );

  logger.info(
    {
      roles: roles.modifiedCount,
      suspension: suspension.modifiedCount,
      counters: counters.modifiedCount,
    },
    'Role backfill complete',
  );

  await disconnectDb();
}

void main().catch((err: unknown) => {
  logger.error({ err }, 'Backfill failed');
  process.exitCode = 1;
});
