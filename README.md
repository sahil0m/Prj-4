# Pulse

A live audience response system you run on your own machine.

Put a question on the projector, let the room answer from their phones, and watch the
results appear as they arrive. It does what Mentimeter and Slido do, except that it runs
on a laptop in the room, costs nothing, and keeps every response on your own hardware.

There is no account tier, no per-presenter licence, and no external service in the
request path. On a departmental network it will run a full lecture with the internet
unplugged.

---

## What it does

**For the presenter.** Sign in, build a deck from 34 kinds of interactive slide, set the
colours and fonts, and press Start. The projector shows a six-digit join code and a QR
code. Answers appear on your screen as they arrive, and everything downloads as CSV
afterwards.

**For the audience.** Scan the code. No app to install, no account to create. The phone
shows whichever slide the presenter is on and changes by itself when they move on.

### The 34 slide types

| Group | Types |
| --- | --- |
| Free response | word cloud, open text, question and answer, drawing |
| Choice | multiple choice, image choice, true or false, who will win, quick form |
| Scales and ordering | scales, ranking, star rating, net promoter score, guess the number, compare |
| Scored quiz | select an answer, type an answer, match pairs, put in order, leaderboard |
| Spatial | pin on an image, pin on a map |
| Content | heading, paragraph, bullets, big number, quote, image, video, instructions, section break, embed, text, choice, rating |

---

## It handles a full lecture hall

Measured with simulated phones against one laptop, all on the same machine. The budget is
what each measurement has to stay under for the room to feel live.

| | 800 phones | 1,500 phones | Budget |
| --- | --- | --- | --- |
| Everyone joins at once (95th percentile) | 392 ms | 669 ms | 3,000 ms |
| Everyone answers at once (95th percentile) | 590 ms | 907 ms | 3,000 ms |
| Everyone answers a quiz (95th percentile) | 645 ms | 1,729 ms | 4,000 ms |
| Moving to the next slide (95th percentile) | 55 ms | 81 ms | 2,000 ms |
| Answers stored per second | 1,266 | 1,533 | |

Nothing was refused at either size. Run it yourself:

```bash
npm run load:test -w @pulse/server -- --phones 800
```

---

## Running it

You need [Node.js 20+](https://nodejs.org) and [PostgreSQL 17](https://www.postgresql.org).

```bash
git clone https://github.com/sahil0m/Prj-4.git
cd Prj-4
npm install
```

Create a database, then copy the example environment file and fill it in:

```bash
cp .env.example .env
```

At minimum set `DATABASE_URL` and generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Then start everything:

```bash
npm run dev
```

| | |
| --- | --- |
| Presenter | http://localhost:5173 |
| Audience | http://localhost:5174 |
| API | http://localhost:4000 |

Database tables are created automatically on first start. Nothing else to set up.

### Letting phones connect

Phones need to reach your laptop, so both must be on the same network. The presenter view
shows the address to use and generates a QR code for it. If the laptop has several network
addresses, it offers a list so you can pick the one the room can actually reach.

---

## Built with

| | |
| --- | --- |
| Server | Node.js 20, Express 5, Socket.IO |
| Database | PostgreSQL 17 with Drizzle ORM |
| Presenter | React 19, Vite |
| Audience | Preact, for a much smaller download on a phone |
| Validation | Zod, shared between server and both clients |
| Passwords | Argon2id |
| Images | sharp, re-encoding uploads to WebP |

Four npm workspaces — `shared`, `server`, `client`, `join` — written in TypeScript under
`strict` with `noUncheckedIndexedAccess`. Every slide type is declared once in `shared`
and used by the server to validate answers and by both clients to draw them.

---

## Tests

178 automated checks run against a live server and a real database, not mocks.

```bash
npm run dev                            # in one terminal

npm run db:verify        -w @pulse/server   # schema and cascades
npm run auth:verify      -w @pulse/server   # sign-in, tokens, rate limits
npm run decks:verify     -w @pulse/server   # decks and every slide type
npm run realtime:verify  -w @pulse/server   # joining, answering, results
npm run session:verify   -w @pulse/server   # session lifecycle
npm run images:verify    -w @pulse/server   # upload, resizing, refusals
npm run cleanup:verify   -w @pulse/server   # expiry of old data
```

Formatting, linting, types and unit tests together:

```bash
npm run verify
```

---

## Optional extras

AI-assisted slide suggestions work with Gemini, Groq or a local Ollama model — all free
tiers. Leave the keys empty in `.env` and the features are simply hidden. Google sign-in
is optional in the same way.

---

## Licence

No licence has been chosen yet, so all rights are reserved by default.
