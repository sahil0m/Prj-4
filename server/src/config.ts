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

  /** This server's own public URL, used to build the OAuth redirect URI. */
  SERVER_ORIGIN: z.string().url().default('http://localhost:4000'),

  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
  JOIN_ORIGIN: z.string().url().default('http://localhost:5174'),

  /**
   * Google sign-in. Optional: leaving these unset simply hides the Google
   * button rather than breaking the server, so a fresh clone runs without
   * anyone having to register an OAuth app first.
   */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  /**
   * AI providers. All free tiers; the server never calls a paid endpoint.
   *
   * Every one is optional. With none set, the AI features report themselves
   * as unavailable and the rest of the product is unaffected.
   */
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-flash-lite-latest'),

  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),

  /** Local model. Needs no key; simply fails fast when not running. */
  OLLAMA_URL: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('llama3.2'),

  /** Cookie domain in production. Leave unset for localhost. */
  COOKIE_DOMAIN: z.string().optional(),
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
