/**
 * Backfills User.hasPassword for accounts created before the field existed.
 *
 * Safe to run repeatedly: it only writes the value the hash already implies.
 * Uses the raw collection so the select:false projection on passwordHash
 * does not hide the field we are reading.
 */
import { connectDb, disconnectDb } from '../lib/db.js';
import { User } from '../models/User.js';
import { logger } from '../lib/logger.js';

async function main(): Promise<void> {
  await connectDb();

  const withHash = await User.collection.updateMany(
    { passwordHash: { $type: 'string', $ne: '' }, hasPassword: { $ne: true } },
    { $set: { hasPassword: true } },
  );

  const withoutHash = await User.collection.updateMany(
    {
      $or: [{ passwordHash: null }, { passwordHash: { $exists: false } }, { passwordHash: '' }],
      hasPassword: { $ne: false },
    },
    { $set: { hasPassword: false } },
  );

  logger.info(
    { setTrue: withHash.modifiedCount, setFalse: withoutHash.modifiedCount },
    'hasPassword backfill complete',
  );

  await disconnectDb();
}

void main().catch((err: unknown) => {
  logger.error({ err }, 'Backfill failed');
  process.exitCode = 1;
});
