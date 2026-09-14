import { defineConfig } from 'drizzle-kit';

/**
 * Migration generation.
 *
 * `npm run db:generate -w server` compares src/db/schema.ts with the last
 * migration and writes the SQL for the difference into ./drizzle. That SQL
 * is committed and reviewed like any other code, and the server applies
 * whatever is pending when it boots.
 *
 * No database connection is needed to generate, so the URL is only read
 * for drizzle-kit's own inspection commands.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
