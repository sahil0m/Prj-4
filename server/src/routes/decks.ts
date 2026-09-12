import { Router } from 'express';
import { z } from 'zod';
import { SLIDE_KINDS } from '@pulse/shared';
import { requireAuth, type AuthedRequest } from '../middleware/requireAuth.js';
import * as decks from '../services/decks.js';

/* ------------------------------------------------------------------ */
/* Input schemas                                                       */
/* ------------------------------------------------------------------ */

const zSlideKind = z.enum(SLIDE_KINDS);

const zCreateDeck = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  slideKinds: z.array(zSlideKind).max(50).optional(),
});

const zUpdateDeck = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  theme: z
    .object({
      preset: z.string().max(40).optional(),
      accent: z.string().max(16).optional(),
      background: z.string().max(16).optional(),
      fontFamily: z.string().max(120).optional(),
      logoUrl: z.string().max(2000).optional(),
      mode: z.enum(['dark', 'light']).optional(),
    })
    .optional(),
  settings: z
    .object({
      mode: z.enum(['presenter_paced', 'audience_paced']).optional(),
      collectNames: z.boolean().optional(),
      showResultsToParticipants: z.boolean().optional(),
      profanityFilter: z.boolean().optional(),
      reactions: z.boolean().optional(),
      chat: z.boolean().optional(),
      oneAnswerPerDevice: z.boolean().optional(),
    })
    .optional(),
});

const zAddSlide = z.object({
  kind: zSlideKind,
  afterSlideId: z.string().max(64).optional(),
  // Shape is checked by the kind's own schema in the service, because only
  // the registry knows what a given kind's config may contain.
  config: z.unknown().optional(),
});

const zMoveSlide = z.object({ toIndex: z.number().int().min(0).max(999) });

const zListQuery = z.object({
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  search: z.string().max(200).optional(),
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function deckRoutes(): Router {
  const router = Router();

  // Every deck route requires a signed-in user; ownership is then enforced
  // inside each service call by scoping the query to that user.
  router.use(requireAuth);

  const ownerOf = (req: unknown): string => (req as AuthedRequest).user.id;

  /** The dashboard list. */
  router.get('/', (req, res, next) => {
    void (async () => {
      try {
        const query = zListQuery.parse(req.query);
        const list = await decks.listDecks(ownerOf(req), query);
        res.json({ decks: list });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.post('/', (req, res, next) => {
    void (async () => {
      try {
        const input = zCreateDeck.parse(req.body);
        const deck = await decks.createDeck(ownerOf(req), input);
        res.status(201).json({ deck: decks.toPublicDeck(deck) });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/:deckId', (req, res, next) => {
    void (async () => {
      try {
        const deck = await decks.getDeck(req.params.deckId, ownerOf(req));
        res.json({ deck: decks.toPublicDeck(deck) });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.patch('/:deckId', (req, res, next) => {
    void (async () => {
      try {
        const input = zUpdateDeck.parse(req.body);
        const deck = await decks.updateDeck(req.params.deckId, ownerOf(req), input);
        res.json({ deck: decks.toPublicDeck(deck) });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.delete('/:deckId', (req, res, next) => {
    void (async () => {
      try {
        await decks.deleteDeck(req.params.deckId, ownerOf(req));
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    })();
  });

  router.post('/:deckId/duplicate', (req, res, next) => {
    void (async () => {
      try {
        const deck = await decks.duplicateDeck(req.params.deckId, ownerOf(req));
        res.status(201).json({ deck: decks.toPublicDeck(deck) });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.post('/:deckId/archive', (req, res, next) => {
    void (async () => {
      try {
        const { archived } = z.object({ archived: z.boolean() }).parse(req.body);
        const deck = await decks.archiveDeck(req.params.deckId, ownerOf(req), archived);
        res.json({ deck: decks.toPublicDeck(deck) });
      } catch (err) {
        next(err);
      }
    })();
  });

  /* ---------------- slides ---------------- */

  router.post('/:deckId/slides', (req, res, next) => {
    void (async () => {
      try {
        const input = zAddSlide.parse(req.body);
        const { deck, slideId } = await decks.addSlide(req.params.deckId, ownerOf(req), input);
        res.status(201).json({ deck: decks.toPublicDeck(deck), slideId });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.put('/:deckId/slides/:slideId', (req, res, next) => {
    void (async () => {
      try {
        const deck = await decks.updateSlide(
          req.params.deckId,
          ownerOf(req),
          req.params.slideId,
          req.body,
        );
        res.json({ deck: decks.toPublicDeck(deck) });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.delete('/:deckId/slides/:slideId', (req, res, next) => {
    void (async () => {
      try {
        const deck = await decks.deleteSlide(req.params.deckId, ownerOf(req), req.params.slideId);
        res.json({ deck: decks.toPublicDeck(deck) });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.post('/:deckId/slides/:slideId/duplicate', (req, res, next) => {
    void (async () => {
      try {
        const { deck, slideId } = await decks.duplicateSlide(
          req.params.deckId,
          ownerOf(req),
          req.params.slideId,
        );
        res.status(201).json({ deck: decks.toPublicDeck(deck), slideId });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.post('/:deckId/slides/:slideId/move', (req, res, next) => {
    void (async () => {
      try {
        const { toIndex } = zMoveSlide.parse(req.body);
        const deck = await decks.moveSlide(
          req.params.deckId,
          ownerOf(req),
          req.params.slideId,
          toIndex,
        );
        res.json({ deck: decks.toPublicDeck(deck) });
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}
