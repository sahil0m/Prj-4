/**
 * Promotes an account to admin.
 *
 * A deliberate command rather than a signup checkbox or a magic first-user
 * rule: an admin flag that anyone can set by registering is not an admin
 * flag. Whoever runs the server decides, from the server.
 *
 *   npm run admin:grant --workspace @pulse/server -- someone@example.com
 */
import { connectDb, disconnectDb } from '../lib/db.js';
import { User } from '../models/index.js';

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();

  if (!email) {
    process.stdout.write('Usage: npm run admin:grant --workspace @pulse/server -- <email>\n');
    process.exitCode = 1;
    return;
  }

  await connectDb();

  const user = await User.findOne({ email, deletedAt: null });

  if (!user) {
    process.stdout.write(`No account found for ${email}. Sign up first, then run this.\n`);
    process.exitCode = 1;
    await disconnectDb();
    return;
  }

  if (user.role === 'admin') {
    process.stdout.write(`${email} is already an admin.\n`);
    await disconnectDb();
    return;
  }

  user.role = 'admin';
  await user.save();

  process.stdout.write(`${email} is now an admin. Sign out and back in to see the admin area.\n`);
  await disconnectDb();
}

void main().catch((err: unknown) => {
  process.stdout.write(`Failed: ${String(err)}\n`);
  process.exitCode = 1;
});
