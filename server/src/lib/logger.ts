import pino from 'pino';
import { env, isProduction } from '../config.js';

/**
 * Structured logging. Pretty and colourful in development, plain JSON in
 * production so a log service can parse it.
 *
 * Anything that could contain a secret is redacted centrally here rather
 * than relying on every call site to remember.
 */
export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : isProduction ? 'info' : 'debug',
  redact: {
    paths: [
      'password',
      'passwordHash',
      '*.password',
      '*.passwordHash',
      'authorization',
      'req.headers.authorization',
      'req.headers.cookie',
      'MONGODB_URI',
      'AUTH_SECRET',
      'PRESENTER_TOKEN_SECRET',
    ],
    censor: '[redacted]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }),
});

export type Logger = typeof logger;
