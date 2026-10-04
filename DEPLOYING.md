# Deploying Pulse

Pulse is built to run on a laptop in the room, and that remains the simplest
way to use it. These notes are for putting it on the internet instead, so a
link can be shared.

Everything below is free and nothing expires.

| Piece         | Host          | Free allowance                         |
| ------------- | ------------- | -------------------------------------- |
| Presenter app | Vercel        | 100 GB bandwidth a month               |
| Audience app  | Vercel        | same project allowance                 |
| Server        | Fly.io        | one small machine, always on           |
| PostgreSQL    | Neon          | 0.5 GB, scales to zero when idle       |
| Images        | Cloudflare R2 | 10 GB, no charge for reading them back |

## Why the server is not on Vercel

Vercel runs functions that start per request and are killed seconds later.
Pulse holds a WebSocket open for every phone in the room for the length of the
lecture, keeps the broadcast scheduling in memory between answers, and groups
connections into rooms inside one process. None of that survives on a platform
that discards the process. The two front ends are static files and deploy to
Vercel perfectly; the server needs a host that leaves it running.

Fly.io is used here rather than Render because Render's free tier stops the
machine after fifteen minutes idle and takes about fifty seconds to wake. A
hall waiting on that is worse than it sounds.

---

## 1. The database

Create a project at [neon.tech](https://neon.tech) and copy the connection
string. It looks like:

```
postgresql://user:password@ep-something.region.aws.neon.tech/neondb?sslmode=require
```

Nothing needs to be created inside it. The server applies its own migrations
at startup, under a lock, so the tables appear the first time it runs.

## 2. Image storage

In the Cloudflare dashboard, create an R2 bucket, then an API token with
**Object Read & Write** on it. You need four values: the account id, the
bucket name, the access key id and the secret.

This step is optional. Without it, images are stored in PostgreSQL, which
works but will fill a 0.5 GB database after a few hundred slide photographs.

## 3. The server, on Fly

Install [flyctl](https://fly.io/docs/flyctl/install/), then from the
repository root:

```bash
fly launch --no-deploy
```

Answer no when it offers to create a database — Neon is already handling that.
Edit `app` in `fly.toml` to whatever name it registered, then set the secrets:

```bash
fly secrets set \
  DATABASE_URL="postgresql://...neon.tech/neondb?sslmode=require" \
  AUTH_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
  PRESENTER_TOKEN_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
  CLIENT_ORIGIN="https://YOUR-CLIENT.vercel.app" \
  JOIN_ORIGIN="https://YOUR-JOIN.vercel.app" \
  SERVER_ORIGIN="https://YOUR-APP.fly.dev" \
  R2_ACCOUNT_ID="..." R2_BUCKET="..." \
  R2_ACCESS_KEY_ID="..." R2_SECRET_ACCESS_KEY="..."
```

The two Vercel URLs do not exist yet. Deploy the front ends first if you
prefer, or set these again afterwards — `fly secrets set` restarts the machine
with the new values.

```bash
fly deploy
```

Check it came up:

```bash
curl https://YOUR-APP.fly.dev/health/ready
```

### Keep it to one machine

`fly.toml` pins the count to one deliberately. Socket.IO rooms and the
broadcast scheduling live in that process's memory, so a second machine would
hold half the room and neither half would see the other's answers. Scaling out
needs a shared adapter first; one machine already carried 1,500 simultaneous
phones in testing, which is larger than any lecture hall.

## 4. The front ends, on Vercel

Two projects from the same repository, differing only in root directory.

**Presenter app**

| Setting              | Value                                             |
| -------------------- | ------------------------------------------------- |
| Root Directory       | `client`                                          |
| Framework Preset     | Vite                                              |
| Environment variable | `VITE_SERVER_ORIGIN` = `https://YOUR-APP.fly.dev` |

**Audience app**

| Setting              | Value                                             |
| -------------------- | ------------------------------------------------- |
| Root Directory       | `join`                                            |
| Framework Preset     | Vite                                              |
| Environment variable | `VITE_SERVER_ORIGIN` = `https://YOUR-APP.fly.dev` |

Each directory has a `vercel.json` that builds from the repository root, which
the workspace layout requires, and rewrites unknown paths to `index.html` so
the six-digit join URLs resolve.

`VITE_SERVER_ORIGIN` is read at build time, not at run time. Changing it means
redeploying.

## 5. Point the server back at them

Once both Vercel URLs exist:

```bash
fly secrets set \
  CLIENT_ORIGIN="https://YOUR-CLIENT.vercel.app" \
  JOIN_ORIGIN="https://YOUR-JOIN.vercel.app"
```

The server refuses browser origins it does not recognise, so this is what
makes the two front ends able to call it at all.

## 6. The join code on the projector

The presenter view builds its QR code from `JOIN_ORIGIN`. With that set to the
Vercel URL, the code a student scans points at the hosted audience app rather
than at a laptop address, which is the point of hosting it.

---

## Checking it works

1. Open the presenter URL and register an account.
2. Build a deck with one word cloud slide and press Start.
3. Scan the QR code with a phone, or open the audience URL and type the code.
4. Answer. The word should appear on the presenter screen within a second.

If the phone connects and immediately disconnects, `CLIENT_ORIGIN` or
`JOIN_ORIGIN` does not match the URL actually being used. If signing in works
but you are signed out on every refresh, `CROSS_SITE_COOKIES` is not set —
`fly.toml` sets it, so check the deploy picked it up.

## Costs

Nothing, at the sizes above. Watch two limits: Neon's 0.5 GB, which is why
images belong in R2, and Vercel's 100 GB of bandwidth, which a lecture does
not come close to.
