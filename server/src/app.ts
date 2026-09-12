import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { allowedOrigins, isProduction } from './config.js';
import { logger } from './lib/logger.js';
import { MulterError } from 'multer';
import { AiError } from './services/ai/providers.js';
import { pingDb } from './lib/db.js';
import { authRoutes } from './routes/auth.js';
import { deckRoutes } from './routes/decks.js';
import { sessionRoutes } from './routes/sessions.js';
import { aiRoutes } from './routes/ai.js';
import { adminRoutes } from './routes/admin.js';

/**
 * Builds the Express application.
 *
 * Kept separate from the listener so tests can mount the app without
 * binding a port.
 */

/** Errors we raise deliberately, carrying a status the client should see. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'error',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function createApp(): Express {
  const app = express();

  // Behind a proxy in production (Render, Fly), so rate limiting and
  // protocol detection read the forwarded headers rather than the proxy IP.
  if (isProduction) app.set('trust proxy', 1);

  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON, never HTML, so a restrictive policy costs
      // nothing and closes off a whole class of mistake.
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin requests and server-to-server calls carry no Origin.
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new HttpError(403, 'Origin not allowed', 'cors_denied'));
      },
      credentials: true,
    }),
  );

  // A 1MB ceiling. Nothing the API accepts is legitimately larger, and an
  // unbounded parser is a trivial denial-of-service vector.
  /*
   * Node's own query parser rather than express's extended `qs` mode.
   *
   * Every query string this API takes is flat — ?code=123456, ?format=csv —
   * so the nested-object support `qs` adds is unused, while its advisories
   * (an array-limit bypass and a denial of service) are not. Choosing the
   * simple parser removes that surface entirely rather than tracking it.
   */
  app.set('query parser', 'simple');

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  /**
   * Global rate limit. Deliberately generous, because a single live session
   * produces a lot of legitimate traffic from one venue's shared IP. The
   * tight per-action limits live on the routes that need them.
   */
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many requests. Please slow down.', code: 'rate_limited' },
    }),
  );

  /* ---------------- health ---------------- */

  /** Liveness. Answers even when the database is down. */
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  /** Readiness. Fails when a dependency is unavailable, so a deploy rolls back. */
  app.get('/health/ready', (_req, res) => {
    void (async () => {
      try {
        const db = await pingDb();
        if (!db.ok) throw new Error('database ping failed');
        res.json({ status: 'ready', database: { ok: true, latencyMs: db.latencyMs } });
      } catch (err) {
        logger.error({ err }, 'Readiness check failed');
        res.status(503).json({ status: 'unavailable', database: { ok: false } });
      }
    })();
  });

  /* ---------------- routes ---------------- */

  app.use('/api/auth', authRoutes());
  app.use('/api/decks', deckRoutes());
  app.use('/api/sessions', sessionRoutes());
  app.use('/api/ai', aiRoutes());
  app.use('/api/admin', adminRoutes());

  /* ---------------- 404 ---------------- */

  app.use((req, res) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.path}`, code: 'not_found' });
  });

  /* ---------------- errors ---------------- */

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Validation failures are the client's fault and safe to describe.
    if (err instanceof ZodError) {
      res.status(400).json({
        error: 'That request was not valid.',
        code: 'validation_failed',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }

    // An AI failure is an upstream problem, not a bug here, and its message
    // is already written for a person to read — "every provider is busy" is
    // far more useful than "something went wrong on our side".
    // Multer rejects an oversized or malformed upload with its own error
    // type. Without this it reaches the catch-all below and the user is
    // told "something went wrong on our side" for a file they can simply
    // make smaller.
    if (err instanceof MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'That file is too large. The limit is 10MB.'
          : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
            ? 'Upload one file at a time.'
            : 'That upload was not valid.';

      res.status(413).json({ error: message, code: 'file_too_large' });
      return;
    }

    if (err instanceof AiError) {
      res.status(503).json({ error: err.message, code: err.code });
      return;
    }

    // Anything else is ours. Log the detail, tell the client nothing —
    // stack traces and driver messages leak structure to an attacker.
    logger.error({ err }, 'Unhandled error');
    res.status(500).json({ error: 'Something went wrong on our side.', code: 'internal_error' });
  });

  return app;
}
