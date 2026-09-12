/**
 * Verifies that the database credentials in .env actually work.
 *
 *   npm run db:ping -w server
 *
 * Prints a clear explanation for the two mistakes people hit most often:
 * a wrong password, and an IP address that Atlas has not been told to allow.
 */
import mongoose from 'mongoose';
import { connectDb, disconnectDb, pingDb } from '../lib/db.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

async function main() {
  process.stdout.write(`${DIM}Connecting to MongoDB...${RESET}\n`);

  await connectDb();
  const { latencyMs } = await pingDb();

  const conn = mongoose.connection;
  const collections = await conn.db!.listCollections().toArray();

  process.stdout.write(
    [
      '',
      `${GREEN}${BOLD}  Connected.${RESET}`,
      '',
      `  ${DIM}Host       ${RESET}${conn.host}`,
      `  ${DIM}Database   ${RESET}${conn.name}`,
      `  ${DIM}Ping       ${RESET}${latencyMs} ms`,
      `  ${DIM}Collections${RESET}${collections.length === 0 ? ' none yet (expected on a fresh cluster)' : ` ${collections.map((c) => c.name).join(', ')}`}`,
      '',
    ].join('\n'),
  );

  await disconnectDb();
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);

    process.stderr.write(`\n${RED}${BOLD}  Could not connect.${RESET}\n\n`);
    process.stderr.write(`  ${message}\n\n`);

    if (/authentication failed|bad auth/i.test(message)) {
      process.stderr.write(
        [
          `  ${BOLD}Most likely cause: wrong username or password.${RESET}`,
          '',
          '  Check MONGODB_URI in your .env file. In MongoDB Atlas go to',
          '  Database Access, then Edit on your user, then Edit Password.',
          '',
        ].join('\n'),
      );
    } else if (/ETIMEOUT|ServerSelection|ENOTFOUND|querySrv/i.test(message)) {
      process.stderr.write(
        [
          `  ${BOLD}Most likely cause: your IP address is not allowed yet.${RESET}`,
          '',
          '  In MongoDB Atlas, open Network Access in the left menu,',
          '  click Add IP Address, then Allow Access From Anywhere.',
          '  Wait about a minute for it to turn green, then run this again.',
          '',
        ].join('\n'),
      );
    }

    process.exit(1);
  });
