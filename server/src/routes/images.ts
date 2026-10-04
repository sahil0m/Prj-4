import { Router } from 'express';
import multer, { MulterError } from 'multer';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { newId, isId } from '../db/ids.js';
import { images } from '../db/schema.js';
import { requireAuth, type AuthedRequest } from '../middleware/requireAuth.js';
import { putImage, getImage } from '../lib/storage.js';
import { HttpError } from '../app.js';
import { logger } from '../lib/logger.js';

/**
 * Pictures on slides.
 *
 * Authors have images on their laptop, not on a web server, so asking for
 * a URL asked them to publish the image somewhere first. This takes the
 * file.
 *
 * Every upload is re-encoded before it is stored, which does three things
 * at once: a six-megabyte phone photo becomes tens of kilobytes, so a room
 * on mobile data is not waiting on it; the stored bytes are an image this
 * server produced rather than a file someone else chose, so a crafted file
 * dressed up as a PNG never reaches a browser; and the metadata, including
 * where the photo was taken, is dropped on the way through.
 */

/** Generous for a photo, small enough that the parse cannot be an attack. */
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/**
 * The longest edge an image is stored at.
 *
 * A projector is rarely more than 1920 across and an image never fills one
 * alone; 1600 leaves room to crop without anyone seeing the difference.
 */
const MAX_EDGE = 1600;

/**
 * The size kept for where an image is shown small.
 *
 * A choice option is about fifty pixels on a phone; four of those at full
 * size is megabytes to draw thumbnails. 320 covers a retina screen at that
 * size and costs a few kilobytes.
 */
const THUMB_EDGE = 320;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

/** Formats a browser can show and sharp can read. */
const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);

export function imageRoutes(): Router {
  const router = Router();

  /**
   * The image itself.
   *
   * Public on purpose: the audience has no account, and an image on a
   * slide is shown to the whole room. Ids are random, so one cannot be
   * found by guessing. Declared before requireAuth for that reason.
   */
  router.get('/:imageId', (req, res, next) => {
    void (async () => {
      try {
        if (!isId(req.params.imageId)) {
          throw new HttpError(404, 'That image was not found.', 'image_not_found');
        }

        const [image] = await db
          .select({
            mime: images.mime,
            data: images.data,
            thumb: images.thumb,
            dataKey: images.dataKey,
            thumbKey: images.thumbKey,
          })
          .from(images)
          .where(eq(images.id, req.params.imageId));

        if (!image) {
          throw new HttpError(404, 'That image was not found.', 'image_not_found');
        }

        // ?size=thumb for the places an image is shown small, so a phone
        // showing four choices downloads kilobytes rather than megabytes.
        const small = req.query.size === 'thumb';

        /*
         * The bytes are in one place or the other, never both. A row
         * written while the server used the database is still served
         * from it after object storage is switched on, which is what
         * makes that switch safe to make on a running installation.
         */
        const inline = small ? image.thumb : image.data;
        const key = small ? image.thumbKey : image.dataKey;
        const bytes = inline ?? (key === null ? null : await getImage(key));

        if (!bytes) {
          throw new HttpError(404, 'That image was not found.', 'image_not_found');
        }

        res.setHeader('Content-Type', image.mime);
        // The bytes at an id never change, so a phone fetches each image
        // once however many times a slide is shown.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        // Belt and braces: never let a stored file be treated as markup.
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'inline');
        res.send(bytes);
      } catch (err) {
        next(err);
      }
    })();
  });

  router.use(requireAuth);

  /** Takes a file and gives back the address to put in a slide. */
  router.post('/', upload.single('image'), (req, res, next) => {
    void (async () => {
      try {
        const file = req.file;

        if (!file) {
          throw new HttpError(422, 'Choose an image to upload.', 'no_file');
        }

        if (!ACCEPTED.has(file.mimetype)) {
          throw new HttpError(
            422,
            'That file is not an image Pulse can use. Try a PNG, JPEG or WebP.',
            'unsupported_image',
          );
        }

        /*
         * Re-encoded rather than stored as sent.
         *
         * sharp reads the actual bytes, so a file claiming to be a PNG
         * that is not one fails here rather than reaching a browser. The
         * result is always WebP: one format to serve, good compression,
         * and transparency kept where the original had it.
         */
        let processed;
        let thumbnail;
        try {
          const source = sharp(file.buffer, { animated: false }).rotate();

          processed = await source
            .clone()
            .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 82 })
            .toBuffer({ resolveWithObject: true });

          thumbnail = await source
            .clone()
            .resize({
              width: THUMB_EDGE,
              height: THUMB_EDGE,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .webp({ quality: 72 })
            .toBuffer();
        } catch {
          throw new HttpError(
            422,
            'That image could not be read. It may be damaged or in an unusual format.',
            'unreadable_image',
          );
        }

        const id = newId();
        const ownerId = (req as AuthedRequest).user.id;

        // Returns the bytes to store inline, or the key they were
        // written under, depending on how the server is configured.
        const full = await putImage(id, 'full', processed.data, 'image/webp');
        const thumb = await putImage(id, 'thumb', thumbnail, 'image/webp');

        await db.insert(images).values({
          id,
          ownerId,
          mime: 'image/webp',
          width: processed.info.width,
          height: processed.info.height,
          bytes: processed.data.length,
          data: full.data,
          dataKey: full.key,
          thumb: thumb.data,
          thumbKey: thumb.key,
          thumbBytes: thumbnail.length,
        });

        logger.info({ imageId: id, from: file.size, to: processed.data.length }, 'Image uploaded');

        res.status(201).json({
          url: `/api/images/${id}`,
          width: processed.info.width,
          height: processed.info.height,
          bytes: processed.data.length,
        });
      } catch (err) {
        // Multer reports an oversized file as its own error type, which
        // would otherwise surface as a 500 with no explanation.
        if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
          next(
            new HttpError(
              413,
              `That image is larger than ${String(MAX_UPLOAD_BYTES / (1024 * 1024))}MB.`,
              'image_too_large',
            ),
          );
          return;
        }
        next(err);
      }
    })();
  });

  return router;
}
