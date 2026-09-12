# Pulse — how the system works

A live audience response tool. A presenter builds a deck of questions, shows
it on a screen, and the room answers on their phones while the results
appear live.

This document describes what exists, how the pieces fit, and why each
decision was made. It is written to be read by someone picking the codebase
up cold.

---

## 1. The shape of it

Four workspaces in one repository:

```
shared/   Types, schemas and pure logic used by everything else
server/   Express API, Socket.IO gateway, MongoDB models
client/   The presenter app — sign in, build decks, present
join/     The participant app — what a phone opens
```

`shared` is the spine. Slide definitions, answer schemas, results
aggregation, quiz scoring and the realtime protocol all live there, so the
server and both clients compile against one definition of every shape. A
mismatch becomes a compile error rather than a silent failure in a room
full of people.

### Why two front-end apps

The presenter app carries React, Radix, Motion and a chart layer — about
217KB gzipped, loaded once on a laptop.

The participant app is 27KB. It loads on a phone, on conference wifi, for a
hundred people at once. It uses Preact rather than React (identical API for
what it needs, a tenth of the weight), no component library, and inline SVG
instead of an icon package. On slow 3G that is a five second wait instead of
fifteen — which decides whether the room actually joins.

Sharing one app would have forced the phone to download the editor.

---

## 2. The data model

Five collections, each with a reason to exist separately.

### Deck — the template

What an author builds and edits. Slides are embedded rather than stored
separately: a deck is always read and written whole, so embedding means one
round trip instead of a join, and the 16MB document limit is far beyond any
realistic deck.

Slide order uses **fractional positions**. Slides sit at 1000, 2000, 3000,
so inserting between two writes one number rather than renumbering the rest.
When repeated inserts at the same point shrink the gap below float
precision, the deck renumbers itself — a path a test drives with 40 inserts.

### Session — one live run

Created when Present is pressed. Its critical field is `deckSnapshot`: a
frozen copy of the deck at that moment. Editing the deck afterwards cannot
change what a past session's numbers mean.

Two ways in, deliberately separate:

- `joinCode` — six digits, read aloud or typed. Unique only among sessions
  that are currently joinable, so codes are recycled when a session closes
  and six digits never run out.
- `joinSlug` — permanent, safe to print on a handout.

Join codes are random rather than sequential: sequential codes would let
anyone who joined one session guess the next.

### Participant — someone in the audience

Identified by a `deviceToken` the phone generates for itself and keeps in
local storage. That token is meaningless outside the session and is never
derived from anything personal. It lets someone refresh without becoming a
second voter, and enforces one-answer-per-device.

### Response — one answer

The highest-volume collection by a wide margin, so the shape is lean and
every index earns its place. Two decisions matter:

- **`clientMsgId` makes writes idempotent.** The phone generates it before
  sending, so a retry after a dropped connection is recognised and counted
  once. This is what makes the offline queue safe.
- **Deletions are soft.** A presenter removing an inappropriate answer sets
  `deletedAt`; live aggregates skip it but the record survives.

### User — an account

Password (Argon2id) or Google, or both linked. Carries `role`,
`suspendedAt`, and a rolling AI request count.

---

## 3. Authentication

Access tokens are short-lived JWTs held **in memory only** — never in
localStorage, which any injected script can read. The refresh token sits in
an httpOnly cookie the browser sends automatically and JavaScript cannot
touch.

**Refresh rotation with reuse detection.** Every refresh issues a new token
and marks the old one used. If a used token appears again, the whole token
family is revoked — a stolen refresh token gets one use before the theft is
detected and the session is killed.

**`tokenVersion`** on the user is compared against a claim in every access
token. Bumping it invalidates every outstanding token instantly, which is
how "log out everywhere", "password changed" and "account suspended" take
effect immediately rather than whenever a token happens to expire.

**Constant-time login.** A failed login runs a verification against a decoy
hash, so response time does not reveal whether an account exists.

**Google sign-in** uses Authorization Code + PKCE + state, and verifies the
ID token's RS256 signature against Google's JWKS. A social email only links
to an existing account when the provider says it is verified — otherwise
anyone could claim an address they do not own.

---

## 4. The realtime layer

Socket.IO, with presenters and participants in **separate rooms**. Nothing
presenter-only is ever broadcast to a phone, because the phone is not in the
room it would be sent to.

### What a phone can and cannot see

A quiz slide is stripped of its answer key before it reaches a participant.
Without that, anyone with developer tools could read the correct answer off
the wire before the countdown ended.

A phone also never receives the presenter's response feed, participant names,
or the full leaderboard mid-question.

### Answers survive a bad connection

The phone queues answers in localStorage and retries them. A tap during a
dropped connection is not lost — the person tapped, they believe they voted,
and they will not tap again. Each carries a message id generated before
sending, so the retry is counted exactly once.

The queue drains oldest-first and drops anything the server refuses
permanently, so one dead answer cannot block everything behind it.

### Rate limits

Per socket rather than per IP, because a lecture hall shares one IP.

---

## 5. Slides

34 kinds, defined once in `shared/src/slides/registry.ts`. Each definition
carries its label, description, icon, family, whether it takes answers,
whether it is a quiz, its Zod schema, its defaults, and its export columns.

**One registry drives everything**: the add-slide menu, the settings form,
validation on the server, results aggregation, the CSV exporter, and what
the AI is allowed to generate. Adding a kind in one place makes it appear
everywhere.

### Generated settings forms

The settings panel is derived from each kind's Zod schema rather than
hand-written 34 times. Hand-written forms drift from their validation and
produce controls that look fine and fail on save; here a field's limits in
the form are literally the numbers the server enforces. A test round-trips
every derived field of every kind through the real validator.

### Validation

Slide configs and answers are both validated by schema. Two specific guards
came from finding real holes:

- **URL scheme allowlist.** Zod's `.url()` accepts `javascript:`, which is
  an XSS vector. Only `http:` and `https:` are allowed.
- **Finite numbers.** `NaN` and `Infinity` pass a plain number check and
  would poison every average computed from them.

---

## 6. Results

`shared/src/slides/results.ts` turns raw answers into chart-ready tallies.
It lives in shared because the presenter recomputes locally as answers
stream in — re-aggregating a thousand rows server-side on every submission
would be wasteful, and two implementations would eventually disagree about
what a room voted.

Malformed rows are skipped rather than throwing: one bad answer must never
take down the results a room is watching.

Charts are hand-drawn SVG rather than a chart library — these are simple
shapes, and a general-purpose library would cost more in bundle size than
the drawing code costs to write. Bars scale to the leader rather than to
100%, so a close race still fills the screen.

---

## 7. Quizzes and scoring

Two rules decide every score:

1. **A wrong answer scores nothing.** Partial credit for a guess makes the
   leaderboard meaningless.
2. **A correct answer scores more the faster it arrives**, between a floor
   and a ceiling. Without the speed component the first ten people are
   indistinguishable from the last ten and the room stops racing; with too
   steep a curve, one slow answer ends someone's session and they
   disengage. The floor is what keeps them playing.

**Elapsed time is measured by the server**, against the countdown it
started, because a device clock is something a participant can change. The
phone sends its own measurement as a hint for when no countdown is running.

**Ties share a rank** and the next rank skips accordingly — two people on
second are both second, and the next is fourth. Ranking them arbitrarily
would be visibly unfair to a room that can see the scores.

**Names are required for quizzes.** Whether a session asks for a name is
derived from the deck's content, not only from a setting: any deck with a
quiz or leaderboard slide asks, because a scoreboard of anonymous rows tells
the room nothing. The name is kept on the device so a refresh mid-quiz does
not create a second, nameless player.

---

## 8. AI

Three providers, all free tiers, tried in order:

| Provider | Role | Why |
|---|---|---|
| Gemini | Primary | Best quality on the free tier |
| Groq | Fallback | Much faster; used where latency matters |
| Ollama | Last resort | Local, unlimited, offline, needs no key |

**Nothing here ever calls a paid endpoint.** If every provider is exhausted
the caller is told plainly rather than being silently upgraded to a billable
tier.

### Three layers of fallback

Free tiers are capped, rate limited and occasionally down, so one provider
means a feature that is broken whenever that provider is. Testing found real
failures rather than hypothetical ones:

1. **Model fallback within a provider.** Gemini returned 503 "high demand"
   on the popular flash model; the call now falls through a list of models.
2. **Retry on transient failure.** Overload and rate limiting usually clear
   within a second, so one retry after a short pause turns most of them into
   a success.
3. **Provider fallback.** Only after a provider exhausts its models.

Model names are **aliases, not pinned versions**. The first implementation
used `gemini-2.0-flash`, which Google had already retired — a pinned version
breaks silently months later.

### What the AI does

- **Build a deck from a topic or a document.** Picks slide kinds, writes
  questions and options, marks correct answers.
- **Rewrite a question.** Three alternatives plus better option labels.
- **Summarise open text live.** Two hundred free-text answers are unreadable
  on a projector and a presenter cannot group them mid-session; this turns
  them into themes with counts and a headline in about a second.

### Documents

PDF, Word, Markdown and plain text. **Nothing is stored** — the file is
parsed in memory, the text handed to the model, and both discarded. Keeping
copies of someone's internal documents would create a real privacy
obligation in exchange for no benefit to them.

The declared format is verified against the file's own magic bytes before a
parser runs, so a file named `.txt` cannot be fed to the PDF parser.

Extraction is followed by cleanup that removes page numbers, repeated
headers and mid-sentence line breaks — left in, they cost context window and
lead the model towards summarising the formatting rather than the content.

### Everything is validated

A generated slide is rebuilt through the same defaults and schema the editor
uses, so an AI deck cannot carry a field that fails to save. If the model
produces something subtly wrong, the defaults stand rather than a broken
slide.

### Quota

A per-user daily cap, applied in one place before any provider is called, so
no endpoint added later can forget it. The free tiers are shared across
everyone on the server, and one user generating fifty decks would leave the
rest without AI for the day — discovered mid-presentation.

---

## 9. Admin

Four questions an administrator actually needs to answer, and a screen for
each. Screens nobody opens are a maintenance cost, not a feature.

1. **Who is using it** — users, signups, activity
2. **Is anyone abusing it** — suspend an account, effective immediately
3. **Is the AI quota about to run out** — usage per user and in total
4. **Is anything broken** — database latency, live sessions, uptime

Admin routes return **404 rather than 403** to a non-admin: confirming that
an admin area exists tells an attacker where to aim.

The first admin is created by a command on the server
(`npm run admin:grant --workspace @pulse/server -- you@example.com`), not by
a signup checkbox. An admin flag anyone can set by registering is not an
admin flag.

An admin cannot suspend themselves or remove their own admin access —
either would lock the system with no way back in.

---

## 10. Export

Results belong to the person who ran the session. Three formats:

- **CSV, one row per answer** — long rather than wide, because a wide sheet
  needs a column per slide and breaks whenever a deck changes.
- **CSV leaderboard** — final standings.
- **JSON** — everything, for anything else.

CSV fields starting with `=`, `+`, `-` or `@` are prefixed with a quote. A
spreadsheet treats such a cell as a formula, so an answer of `=1+1` becomes
a live calculation and a crafted one can run a command on the reader's
machine.

Output carries a UTF-8 BOM, without which Excel mangles every accented name.

---

## 11. Testing

| Suite | What it covers |
|---|---|
| Unit (vitest) | Schemas, aggregation, scoring, theme contrast, QR encoding, AI parsing |
| `verify-models` | Indexes and constraints against the real database |
| `verify-auth` | Rotation, reuse detection, social linking, account takeover |
| `verify-decks` | Ownership boundaries, ordering, partial edits |
| `verify-realtime` | Real socket clients: join, answer, retry, room isolation |

The realtime suite drives actual Socket.IO connections rather than calling
the service layer, because room isolation and broadcast fan-out only exist
over a live connection.

Several tests exist because a real bug got through:

- A quiz answer with no `elapsedMs` was rejected, which broke every quiz on
  a real phone while passing every test that constructed the field by hand.
- An XSS test used the wrong field name and silently tested nothing.
- `hasPassword` was derived from a field the database does not load by
  default, so refresh reported a password account as passwordless.

---

## 12. Running it

```bash
npm install
npm run theme:build          # generates CSS variables from design tokens

# three terminals
npm run dev --workspace @pulse/server    # :4000
npm run dev --workspace @pulse/client    # :5173
npm run dev --workspace @pulse/join      # :5174
```

Configuration lives in `.env` at the repository root — see `.env.example`.
The only required values are `MONGODB_URI`, `AUTH_SECRET` and
`PRESENTER_TOKEN_SECRET`. Google sign-in and the AI providers are optional;
without them those features hide themselves rather than failing.

For phones to reach the join page, `JOIN_ORIGIN` must be the machine's
network address rather than `localhost`.

---

## 13. What is deliberately not here

- **No file storage.** Uploaded documents are parsed and discarded.
- **No analytics or tracking.** Participants are anonymous by default and
  the anonymity is real: no IP, no user agent, no fingerprint.
- **No paid dependencies.** Every service used has a free tier that is a
  product rather than a trial.
