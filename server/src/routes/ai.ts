import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Session, Response } from '../models/index.js';
import { HttpError } from '../app.js';
import { requireAuth, type AuthedRequest } from '../middleware/requireAuth.js';
import * as ai from '../services/ai/features.js';
import { availableProviders, isAiConfigured } from '../services/ai/providers.js';
import * as sessions from '../services/sessions.js';
import * as decks from '../services/decks.js';

/**
 * The AI endpoints.
 *
 * Rate limited per user rather than per IP. These calls spend a shared free
 * quota, so one enthusiastic user must not exhaust the day's allowance for
 * everyone else on the same server.
 */

const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthedRequest).user.id,
  message: {
    error: 'You have used a lot of AI requests this hour. Try again shortly.',
    code: 'ai_rate_limited',
  },
});

const zGenerate = z.object({
  topic: z.string().trim().min(3).max(300),
  slideCount: z.number().int().min(1).max(15).default(6),
  audience: z.string().trim().max(120).optional(),
  style: z.enum(['mixed', 'quiz', 'discussion', 'feedback']).default('mixed'),
  /** When set, the slides are appended to this deck instead of a new one. */
  deckId: z.string().max(64).optional(),
});

const zImprove = z.object({
  deckId: z.string().max(64),
  slideId: z.string().max(64),
});

const zSummarise = z.object({
  sessionId: z.string().max(64),
  slideId: z.string().max(64),
});

export function aiRoutes(): Router {
  const router = Router();

  /** Lets the client hide the AI controls rather than offer a dead button. */
  router.get('/status', (_req, res) => {
    res.json({
      available: isAiConfigured(),
      providers: availableProviders(),
    });
  });

  router.use(requireAuth);
  router.use(aiLimiter);

  const ownerOf = (req: unknown): string => (req as AuthedRequest).user.id;

  /** Builds a deck, or adds slides to an existing one. */
  router.post('/generate-deck', (req, res, next) => {
    void (async () => {
      try {
        const input = zGenerate.parse(req.body);
        const ownerId = ownerOf(req);

        const generated = await ai.generateDeck(input);

        // Appending to an open deck is the common case: an author has begun
        // and wants help continuing, not a second deck to merge by hand.
        if (input.deckId) {
          let deck = await decks.getDeck(input.deckId, ownerId);

          for (const slide of generated.slides) {
            const result = await decks.addSlide(input.deckId, ownerId, {
              kind: slide.kind,
              config: slide.config,
            });
            deck = result.deck;
          }

          res.json({ deck: decks.toPublicDeck(deck), provider: generated.provider });
          return;
        }

        const deck = await decks.createDeck(ownerId, { title: generated.title });

        for (const slide of generated.slides) {
          await decks.addSlide(deck._id.toString(), ownerId, {
            kind: slide.kind,
            config: slide.config,
          });
        }

        const complete = await decks.getDeck(deck._id.toString(), ownerId);
        res.status(201).json({ deck: decks.toPublicDeck(complete), provider: generated.provider });
      } catch (err) {
        next(err);
      }
    })();
  });

  /** Suggests better wording for one slide. */
  router.post('/improve-slide', (req, res, next) => {
    void (async () => {
      try {
        const { deckId, slideId } = zImprove.parse(req.body);

        const deck = await decks.getDeck(deckId, ownerOf(req));
        const slide = decks.toPublicDeck(deck).slides.find((s) => s.id === slideId);

        if (!slide) throw new HttpError(404, 'That slide was not found.', 'slide_not_found');

        const config = slide.config as { prompt?: string; options?: { label: string }[] };

        const result = await ai.improveSlide({
          kind: slide.kind,
          prompt: config.prompt ?? '',
          options: config.options?.map((o) => o.label),
        });

        res.json(result);
      } catch (err) {
        next(err);
      }
    })();
  });

  /** Groups a wall of open text into themes, live. */
  router.post('/summarise', (req, res, next) => {
    void (async () => {
      try {
        const { sessionId, slideId } = zSummarise.parse(req.body);

        const session = await Session.findOne({ _id: sessionId, ownerId: ownerOf(req) });
        if (!session) {
          throw new HttpError(404, 'That session was not found.', 'session_not_found');
        }

        const slide = sessions.slideOf(session, slideId);
        if (!slide) throw new HttpError(404, 'That slide was not found.', 'slide_not_found');

        const rows = await Response.find({ sessionId: session._id, slideId, deletedAt: null })
          .select('payload')
          .lean();

        const answers = rows
          .map((row) => {
            const payload = row.payload as { text?: unknown; words?: unknown };
            if (typeof payload.text === 'string') return payload.text;
            if (Array.isArray(payload.words)) return payload.words.join(', ');
            return '';
          })
          .filter((text) => text.trim() !== '');

        const prompt = typeof slide.config.prompt === 'string' ? slide.config.prompt : '';
        const summary = await ai.summariseResponses(prompt, answers);

        res.json({ summary });
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}
