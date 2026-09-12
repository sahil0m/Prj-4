import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

// Load .env from the repo root, regardless of where the process was started.
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../.env') });

/**
 * Every environment variable the server needs, validated once at boot.
 *
 * A missing or malformed value stops the process immediately with a clear
 * message, rather than surfacing as a confusing runtime error later.
 */
const zEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  MONGODB_URI: z
    .string()
    .min(1, 'MONGODB_URI is required')
    .refine(
      (v) => v.startsWith('mongodb://') || v.startsWith('mongodb+srv://'),
      'MONGODB_URI must start with mongodb:// or mongodb+srv://',
    ),

  AUTH_SECRET: z
    .string()
    .min(32, 'AUTH_SECRET must be at least 32 characters')
    .refine((v) => v !== 'replace-me', 'AUTH_SECRET still holds its placeholder value'),

  PRESENTER_TOKEN_SECRET: z
    .string()
    .min(32, 'PRESENTER_TOKEN_SECRET must be at least 32 characters')
    .refine((v) => v !== 'replace-me', 'PRESENTER_TOKEN_SECRET still holds its placeholder value'),

  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
  JOIN_ORIGIN: z.string().url().default('http://localhost:5174'),
});

export type Env = z.infer<typeof zEnv>;

function loadEnv(): Env {
  const parsed = zEnv.safeParse(process.env);

  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    console.error(
      [
        '',
        'Configuration error. The server cannot start.',
        '',
        ...lines,
        '',
        'Copy .env.example to .env and fill in the missing values.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Origins allowed to call the API from a browser. */
export const allowedOrigins = [env.CLIENT_ORIGIN, env.JOIN_ORIGIN];
