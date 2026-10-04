import type { S3Client } from '@aws-sdk/client-s3';
import { env } from '../config.js';
import { logger } from './logger.js';

/**
 * Where uploaded image bytes are kept.
 *
 * Two backends, chosen by whether object storage is configured.
 *
 * The database is the default because it needs nothing set up: clone the
 * repository, point it at PostgreSQL, and uploads work. For a laptop in a
 * lecture room, which is what this product is for, that is the whole
 * story and there is nothing else to run.
 *
 * Object storage exists for a hosted deployment, where the free database
 * tiers are measured in hundreds of megabytes and a few hundred slide
 * images would fill one. Setting the four R2 variables switches to it;
 * leaving them empty keeps the database. Nothing else in the application
 * knows which is in use.
 *
 * Anything S3-compatible works. Cloudflare R2 is the one this was written
 * against, because it does not charge for reading the bytes back out, and
 * an image on a slide is read once per phone in the room.
 */

export interface StoredImage {
  /** The bytes, or null when they live in object storage. */
  data: Buffer | null;
  /** The key they were written under, or null when they live in the database. */
  key: string | null;
}

/** True when object storage is configured and will be used. */
export const usingObjectStorage = Boolean(
  env.R2_ACCOUNT_ID && env.R2_BUCKET && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY,
);

/*
 * The S3 client is created once and only when it is needed. Importing it
 * at module load would pull the SDK into every process that touches this
 * file, including the test scripts, which have no use for it.
 */
let client: S3Client | null = null;

async function s3(): Promise<S3Client> {
  if (client) return client;

  const { S3Client } = await import('@aws-sdk/client-s3');

  client = new S3Client({
    region: 'auto',
    endpoint: `https://${String(env.R2_ACCOUNT_ID)}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: String(env.R2_ACCESS_KEY_ID),
      secretAccessKey: String(env.R2_SECRET_ACCESS_KEY),
    },
  });

  return client;
}

/**
 * Writes image bytes and says where they went.
 *
 * `variant` separates the full image from its thumbnail under one id.
 */
export async function putImage(
  id: string,
  variant: 'full' | 'thumb',
  bytes: Buffer,
  mime: string,
): Promise<StoredImage> {
  if (!usingObjectStorage) return { data: bytes, key: null };

  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const key = `images/${id}/${variant}.webp`;

  await (
    await s3()
  ).send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      Body: bytes,
      ContentType: mime,
      // The bytes at a key never change, so a browser may keep them.
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );

  return { data: null, key };
}

/** Reads image bytes back. Null when the key is gone. */
export async function getImage(key: string): Promise<Buffer | null> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');

  try {
    const result = await (
      await s3()
    ).send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));

    if (!result.Body) return null;
    return Buffer.from(await result.Body.transformToByteArray());
  } catch (err) {
    logger.warn({ err, key }, 'Image could not be read from object storage');
    return null;
  }
}

/**
 * Removes the stored objects for an image.
 *
 * A failure here is logged rather than thrown. The row is the record of
 * what exists; an object left behind costs a few kilobytes, where a
 * failed delete that aborted the request would leave the account
 * half-removed.
 */
export async function deleteImage(keys: (string | null)[]): Promise<void> {
  const present = keys.filter((k): k is string => k !== null);
  if (!usingObjectStorage || present.length === 0) return;

  const { DeleteObjectsCommand } = await import('@aws-sdk/client-s3');

  try {
    await (
      await s3()
    ).send(
      new DeleteObjectsCommand({
        Bucket: env.R2_BUCKET,
        Delete: { Objects: present.map((Key) => ({ Key })) },
      }),
    );
  } catch (err) {
    logger.warn({ err, keys: present }, 'Image objects could not be removed');
  }
}
