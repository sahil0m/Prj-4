import mongoose from 'mongoose';
import { env, isProduction } from '../config.js';
import { logger } from './logger.js';

/**
 * A single shared connection to MongoDB.
 *
 * Mongoose keeps its own connection pool, so the whole server shares one
 * connection object. Queries issued before the connection is ready are
 * buffered by Mongoose and flushed once it opens.
 */

let connecting: Promise<typeof mongoose> | null = null;

export async function connectDb(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === mongoose.ConnectionStates.connected) return mongoose;
  if (connecting) return connecting;

  mongoose.set('strictQuery', true);
  // Surface schema mistakes loudly in development instead of silently
  // dropping fields that are not in the schema.
  mongoose.set('strict', 'throw');

  if (!isProduction) {
    mongoose.set('debug', false); // flip to true when chasing a query bug
  }

  connecting = mongoose
    .connect(env.MONGODB_URI, {
      // Fail fast with a clear message rather than hanging for 30 seconds.
      serverSelectionTimeoutMS: 10_000,
      socketTimeoutMS: 45_000,
      // Keep the pool small; the free Atlas tier caps connections.
      maxPoolSize: 10,
      minPoolSize: 1,
      retryWrites: true,
      appName: 'pulse',
    })
    .then((m) => {
      logger.info({ host: m.connection.host, db: m.connection.name }, 'Connected to MongoDB');
      return m;
    })
    .catch((err: unknown) => {
      connecting = null;
      throw err;
    });

  return connecting;
}

export async function disconnectDb(): Promise<void> {
  if (mongoose.connection.readyState === mongoose.ConnectionStates.disconnected) return;
  await mongoose.disconnect();
  connecting = null;
  logger.info('Disconnected from MongoDB');
}

/** Health probe used by the /health endpoint and the smoke tests. */
export async function pingDb(): Promise<{ ok: boolean; latencyMs: number }> {
  const started = Date.now();
  const admin = mongoose.connection.db?.admin();
  if (!admin) return { ok: false, latencyMs: Date.now() - started };
  await admin.ping();
  return { ok: true, latencyMs: Date.now() - started };
}

/* Connection lifecycle logging — these fire on network blips too, which is
   exactly when you want to see them. */
mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB connection lost');
});
mongoose.connection.on('reconnected', () => {
  logger.info('MongoDB reconnected');
});
mongoose.connection.on('error', (err) => {
  logger.error({ err }, 'MongoDB connection error');
});
