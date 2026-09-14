import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { env, isProduction } from '../config.js';
import { logger } from './logger.js';
import * as schema from '../db/schema.js';

/**
 * The PostgreSQL connection.
 *
 * One pool for the whole process. Queries borrow a connection and return it,
 * so nothing here needs opening or closing per request.
 */

export type Database = NodePgDatabase<typeof schema>;

/** A transaction handle, which accepts every query the database does. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Either, for helpers that work inside or outside a transaction. */
export type Executor = Database | Transaction;

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  // Small on purpose: the free hosted tiers cap connections, and one server
  // process never needs more than this at once.
  max: 10,
  // Fail with a clear message rather than hanging while a request waits.
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  application_name: 'pulse',
  // Hosted Postgres requires TLS; a local server usually does not offer it.
  // sslmode in the URL is honoured by pg itself, so this only sets the
  // default when the URL says nothing.
  ...(isProduction && !env.DATABASE_URL.includes('sslmode=')
    ? { ssl: { rejectUnauthorized: true } }
    : {}),
});

/*
 * An idle connection that dies -- the database restarted, a laptop slept --
 * surfaces here rather than on a query. Without a listener Node treats it as
 * an unhandled error and takes the whole server down with it.
 */
pool.on('error', (err) => {
  logger.error({ err }, 'PostgreSQL connection error');
});

export const db: Database = drizzle(pool, { schema });

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

const here = dirname(fileURLToPath(import.meta.url));

/** Where drizzle-kit writes migrations; the same folder in src and in dist. */
const MIGRATIONS = resolve(here, '../../drizzle');

/**
 * An arbitrary constant naming this app's migration lock.
 *
 * Two server instances starting at once would otherwise both try to apply
 * the same migration. The advisory lock makes the second wait until the
 * first is done, and then find nothing left to do.
 */
const MIGRATION_LOCK = 718_245_031;

let ready: Promise<void> | null = null;

/**
 * Connects, and brings the schema up to date.
 *
 * Migrations run on boot rather than as a step someone has to remember.
 * "The server started but the table does not exist" is a failure that only
 * happens in front of people; applying pending migrations first removes it.
 */
export function connectDb(): Promise<void> {
  ready ??= (async () => {
    const client = await pool.connect();

    try {
      const { rows } = await client.query<{ db: string; version: string }>(
        'SELECT current_database() AS db, current_setting($1) AS version',
        ['server_version'],
      );

      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
      try {
        await migrate(drizzle(client, { schema }), {
          migrationsFolder: MIGRATIONS,
        });
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
      }

      const info = rows[0];
      logger.info({ db: info?.db, version: info?.version }, 'Connected to PostgreSQL');
    } finally {
      client.release();
    }
  })().catch((err: unknown) => {
    ready = null;
    throw err;
  });

  return ready;
}

export async function disconnectDb(): Promise<void> {
  await pool.end();
  ready = null;
  logger.info('Disconnected from PostgreSQL');
}

/** Health probe used by /health/ready and the admin overview. */
export async function pingDb(): Promise<{ ok: boolean; latencyMs: number }> {
  const started = Date.now();

  try {
    await db.execute(sql`SELECT 1`);
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: Date.now() - started };
  }
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * Whether an error is a unique-constraint violation.
 *
 * Drizzle wraps driver errors, so the Postgres code may be on the error
 * itself or on its cause. Checking only one would make a duplicate submit
 * look like a crash.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  for (let current: unknown = err, depth = 0; current && depth < 4; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };

    if (candidate.code === '23505') {
      return constraint === undefined || candidate.constraint === constraint;
    }

    current = candidate.cause;
  }

  return false;
}
