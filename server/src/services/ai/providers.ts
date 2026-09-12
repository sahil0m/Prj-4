import { env } from '../../config.js';
import { logger } from '../../lib/logger.js';

/**
 * AI providers, all free.
 *
 * Three of them, tried in order, because a free tier is a free tier: it has
 * a daily cap, it occasionally rate-limits, and it can be down. One provider
 * means the feature is broken whenever that provider is. Falling through to
 * the next means the feature keeps working and nobody is ever asked to pay.
 *
 *   gemini  Google's free tier. Best quality of the three, and the default.
 *   groq    Llama 3.3 70B, far faster, useful when latency matters.
 *   ollama  Runs on the presenter's own machine. Unlimited and offline,
 *           lower quality, and needs nothing configured at all.
 *
 * Nothing here ever calls a paid endpoint. If every provider is exhausted
 * the caller is told plainly rather than being silently upgraded to a
 * billable tier.
 */

export type ProviderName = 'gemini' | 'groq' | 'ollama';

export interface CompletionRequest {
  /** Sets the model's role and rules. */
  system: string;
  /** The actual task. */
  prompt: string;
  /** Lower is more predictable; generation wants a little variety. */
  temperature?: number;
  maxTokens?: number;
  /** Ask for strict JSON. Providers that support it enforce it natively. */
  json?: boolean;
}

/** A short pause, so a retry does not arrive while the model is still busy. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CompletionResult {
  text: string;
  provider: ProviderName;
  /** Round trip in milliseconds, so slow providers can be deprioritised. */
  latencyMs: number;
}

export class AiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Whether trying a different provider might succeed. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/* ------------------------------------------------------------------ */
/* Gemini                                                              */
/* ------------------------------------------------------------------ */

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Models to try, in order.
 *
 * Google's free tier returns 503 when a particular model is busy, and the
 * popular ones are busy often. Falling through to a quieter model is the
 * difference between a feature that works and one that fails in front of a
 * room. Aliases rather than pinned versions, because Google retires specific
 * versions and a hard-coded one breaks silently months later.
 */
function geminiModels(): string[] {
  const configured = env.GEMINI_MODEL;
  const fallbacks = ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-3-flash-preview'];

  return [configured, ...fallbacks.filter((m) => m !== configured)];
}

async function callGemini(request: CompletionRequest): Promise<string> {
  if (!env.GEMINI_API_KEY) {
    throw new AiError('not_configured', 'Gemini is not configured.', true);
  }

  let lastError: AiError | null = null;

  for (const model of geminiModels()) {
    try {
      return await callGeminiModel(request, model);
    } catch (err) {
      const error = err instanceof AiError ? err : new AiError('unknown', String(err), true);

      // A refusal or a bad key will not improve on another model.
      if (!error.retryable || error.code === 'bad_key' || error.code === 'blocked') throw error;

      lastError = error;
    }
  }

  throw lastError ?? new AiError('provider_error', 'Gemini could not be reached.', true);
}

async function callGeminiModel(request: CompletionRequest, model: string): Promise<string> {
  const response = await fetch(
    `${GEMINI_URL}/${model}:generateContent?key=${env.GEMINI_API_KEY ?? ''}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
        generationConfig: {
          temperature: request.temperature ?? 0.7,
          maxOutputTokens: request.maxTokens ?? 2048,
          // Native JSON mode: the model cannot return prose around the object,
          // which removes a whole class of parsing failure.
          ...(request.json ? { responseMimeType: 'application/json' } : {}),
        },
        // The default thresholds block ordinary material — a quiz about
        // history or medicine trips them. This is a presenter writing their
        // own slides, so the useful setting is the permissive one.
        safetySettings: [
          'HARM_CATEGORY_HARASSMENT',
          'HARM_CATEGORY_HATE_SPEECH',
          'HARM_CATEGORY_SEXUALLY_EXPLICIT',
          'HARM_CATEGORY_DANGEROUS_CONTENT',
        ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    const body = await response.text();

    if (response.status === 429) {
      throw new AiError('rate_limited', 'Gemini is rate limited right now.', true);
    }
    if (response.status === 503 || response.status === 500) {
      throw new AiError('overloaded', 'Gemini is busy right now.', true);
    }
    if (response.status === 400 && body.includes('API_KEY_INVALID')) {
      throw new AiError('bad_key', 'The Gemini API key is not valid.', true);
    }
    if (response.status === 404) {
      throw new AiError(
        'model_missing',
        `Gemini has no model named "${model}". Check GEMINI_MODEL.`,
        true,
      );
    }
    throw new AiError('provider_error', `Gemini returned ${String(response.status)}.`, true);
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  };

  const candidate = data.candidates?.[0];

  if (candidate?.finishReason === 'SAFETY') {
    throw new AiError('blocked', 'That request was blocked by the safety filter.', false);
  }

  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) throw new AiError('empty', 'Gemini returned nothing.', true);

  return text;
}

/* ------------------------------------------------------------------ */
/* Groq                                                                */
/* ------------------------------------------------------------------ */

async function callGroq(request: CompletionRequest): Promise<string> {
  if (!env.GROQ_API_KEY) {
    throw new AiError('not_configured', 'Groq is not configured.', true);
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.GROQ_MODEL,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? 2048,
      ...(request.json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new AiError('rate_limited', 'Groq is rate limited right now.', true);
    }
    if (response.status === 503 || response.status === 500) {
      throw new AiError('overloaded', 'Groq is busy right now.', true);
    }
    throw new AiError('provider_error', `Groq returned ${String(response.status)}.`, true);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };

  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new AiError('empty', 'Groq returned nothing.', true);

  return text;
}

/* ------------------------------------------------------------------ */
/* Ollama                                                              */
/* ------------------------------------------------------------------ */

async function callOllama(request: CompletionRequest): Promise<string> {
  const response = await fetch(`${env.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.OLLAMA_MODEL,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
      stream: false,
      ...(request.json ? { format: 'json' } : {}),
      options: {
        temperature: request.temperature ?? 0.7,
        num_predict: request.maxTokens ?? 2048,
      },
    }),
    // A local model on a laptop is slower than a hosted one, so this is
    // generous. It is the last resort anyway.
    signal: AbortSignal.timeout(120_000),
  }).catch(() => {
    // Not running is the normal case, not an error worth logging loudly.
    throw new AiError('not_configured', 'Ollama is not running.', true);
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new AiError(
        'model_missing',
        `Ollama does not have "${env.OLLAMA_MODEL}". Run: ollama pull ${env.OLLAMA_MODEL}`,
        true,
      );
    }
    throw new AiError('provider_error', `Ollama returned ${String(response.status)}.`, true);
  }

  const data = (await response.json()) as { message?: { content?: string } };
  const text = data.message?.content;
  if (!text) throw new AiError('empty', 'Ollama returned nothing.', true);

  return text;
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

const CALLERS: Record<ProviderName, (request: CompletionRequest) => Promise<string>> = {
  gemini: callGemini,
  groq: callGroq,
  ollama: callOllama,
};

/** Which providers could serve a request, in the order they should be tried. */
export function availableProviders(): ProviderName[] {
  const available: ProviderName[] = [];
  if (env.GEMINI_API_KEY) available.push('gemini');
  if (env.GROQ_API_KEY) available.push('groq');
  // Always a candidate: it needs no key, and a failed connection simply
  // falls through in a few milliseconds.
  available.push('ollama');
  return available;
}

/**
 * Whether the AI features should be offered at all.
 *
 * OLLAMA_URL is deliberately not counted: it has a default, so including it
 * made this always true and put an AI button in front of users who had
 * nothing configured. Ollama is still tried at request time — it simply
 * does not by itself justify showing the controls.
 */
export function isAiConfigured(): boolean {
  const keys = [env.GEMINI_API_KEY, env.GROQ_API_KEY];
  return keys.some((key) => typeof key === 'string' && key.length > 0);
}

/**
 * Runs a request against the first provider that succeeds.
 *
 * `prefer` moves one provider to the front without removing the others, so
 * a latency-sensitive caller can ask for Groq and still be covered if it is
 * rate limited.
 */
export async function complete(
  request: CompletionRequest,
  prefer?: ProviderName,
): Promise<CompletionResult> {
  const order = availableProviders();

  if (prefer) {
    const index = order.indexOf(prefer);
    if (index > 0) order.splice(0, 0, ...order.splice(index, 1));
  }

  const failures: string[] = [];

  for (const provider of order) {
    // Overload and rate limiting are the normal failure modes of a free
    // tier, and both usually clear within a second or two. One retry with a
    // short pause turns most of them into a success rather than an error in
    // front of an audience.
    const attempts = 2;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const started = Date.now();

      try {
        const text = await CALLERS[provider](request);
        const latencyMs = Date.now() - started;

        logger.info({ provider, latencyMs, attempt }, 'AI request served');
        return { text, provider, latencyMs };
      } catch (err) {
        const error = err instanceof AiError ? err : new AiError('unknown', String(err), true);

        // A refusal is a real answer; retrying it, here or on another
        // provider, wastes the room's time and will be refused again.
        if (!error.retryable) throw error;

        const worthRetrying = error.code === 'overloaded' || error.code === 'rate_limited';

        if (worthRetrying && attempt < attempts) {
          await wait(1200);
          continue;
        }

        failures.push(`${provider}: ${error.message}`);
        break;
      }
    }
  }

  logger.warn({ failures }, 'Every AI provider failed');

  throw new AiError(
    'all_failed',
    'No AI provider is available right now. Check the keys in your settings, or try again shortly.',
    false,
  );
}
