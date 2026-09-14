/**
 * Verifies that the database settings in .env actually work.
 *
 *   npm run db:ping -w server
 *
 * Prints a plain explanation for the mistakes people hit most often: a wrong
 * password, the wrong port, a database that has not been created, and a
 * server that is not running.
 */
import { sql } from 'drizzle-orm';
import { connectDb, disconnectDb, pingDb, db } from '../lib/db.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

async function main(): Promise<void> {
  process.stdout.write(`${DIM}Connecting to PostgreSQL...${RESET}\n`);

  // Also applies any pending migrations, exactly as the server does on boot.
  await connectDb();
  const { latencyMs } = await pingDb();

  const info = await db.execute<{ db: string; host: string | null; version: string }>(
    sql`SELECT current_database() AS db, host(inet_server_addr()) AS host, current_setting('server_version') AS version`,
  );

  const tables = await db.execute<{ name: string; rows: number }>(sql`
    SELECT c.relname AS name, c.reltuples::bigint::int AS rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE '__drizzle%'
    ORDER BY c.relname
  `);

  const row = info.rows[0];

  process.stdout.write(
    [
      '',
      `${GREEN}${BOLD}  Connected.${RESET}`,
      '',
      `  ${DIM}Database  ${RESET}${row?.db ?? '?'}`,
      `  ${DIM}Server    ${RESET}PostgreSQL ${row?.version ?? '?'}${row?.host ? ` at ${row.host}` : ''}`,
      `  ${DIM}Ping      ${RESET}${String(latencyMs)} ms`,
      `  ${DIM}Tables    ${RESET}${tables.rows.map((t) => t.name).join(', ') || 'none'}`,
      '',
    ].join('\n'),
  );

  await disconnectDb();
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code ?? '';

    process.stderr.write(`\n${RED}${BOLD}  Could not connect.${RESET}\n\n`);
    // The URL carries the password, so it is never echoed back.
    process.stderr.write(
      `  ${message.replace(/postgres(ql)?:\/\/[^\s@]*@/gi, 'postgresql://***@')}\n\n`,
    );

    const hint = (() => {
      if (code === '28P01' || /password authentication failed/i.test(message)) {
        return [
          'Most likely cause: wrong username or password.',
          '',
          'Check DATABASE_URL in .env. It is the password you use to connect',
          'in pgAdmin. If it contains @ : / # ? or %, write it URL-encoded.',
        ];
      }
      if (code === '3D000' || /database .* does not exist/i.test(message)) {
        return [
          'Most likely cause: the database has not been created yet.',
          '',
          'In pgAdmin, right-click Databases, then Create, then Database,',
          'and give it the name at the end of DATABASE_URL.',
        ];
      }
      if (code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
        return [
          'Most likely cause: PostgreSQL is not running, or it is on another port.',
          '',
          'Check the port in DATABASE_URL matches the one PostgreSQL listens on',
          '(5432 by default; a second installation is often 5433), and that its',
          'Windows service is running.',
        ];
      }
      return [];
    })();

    if (hint.length > 0) {
      process.stderr.write(
        `  ${BOLD}${hint[0] ?? ''}${RESET}\n${hint
          .slice(1)
          .map((l) => `  ${l}`)
          .join('\n')}\n\n`,
      );
    }

    process.exit(1);
  });
