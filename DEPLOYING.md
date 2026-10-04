# Deploying Pulse

Pulse is built to run on a laptop in the room, and that remains the simplest
way to use it. These notes are for putting it on the internet instead, so a
link can be shared.

Everything below is free and nothing expires.

| Piece         | Host          | Free allowance                         |
| ------------- | ------------- | -------------------------------------- |
| Presenter app | Vercel        | 100 GB bandwidth a month               |
| Audience app  | Vercel        | same project allowance                 |
| Server        | Render        | free instance, no card asked           |
| PostgreSQL    | Neon          | 0.5 GB, scales to zero when idle       |
| Images        | Cloudflare R2 | 10 GB, no charge for reading them back |

## Why the server is not on Vercel

Vercel runs functions that start per request and are killed seconds later.
Pulse holds a WebSocket open for every phone in the room for the length of the
lecture, keeps the broadcast scheduling in memory between answers, and groups
connections into rooms inside one process. None of that survives on a platform
that discards the process. The two front ends are static files and deploy to
Vercel perfectly; the server needs a host that leaves it running.

Render is used here because it asks for no card and is not going anywhere.
Fly.io holds new accounts until a card is added. Koyeb was the better
technical fit, having no idle timeout, but it is being absorbed into Mistral
and its free tier is no longer something to build on.

The cost is that Render stops a free instance after fifteen minutes without a
request, and starting it again takes about fifty seconds. Open the URL a
minute before a lecture and nobody in the room sees it.

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

## 3. The server, on Render

Sign in at [render.com](https://render.com) with GitHub. No card is asked for.

The repository carries a `render.yaml`, so the quickest route is **New →
Blueprint**, pick `Prj-4`, and Render reads the settings from it. Otherwise
**New → Web Service** and fill in:

| Setting           | Value                          |
| ----------------- | ------------------------------ |
| Repository        | `sahil0m/Prj-4`                |
| Branch            | `main`                         |
| Language          | **Docker**                     |
| Dockerfile path   | `./Dockerfile`                 |
| Instance type     | Free                           |
| Region            | Singapore, beside the database |
| Health check path | `/health/ready`                |

Docker matters here. Render's other options inspect the repository and guess
how to build it; this is a workspace of four packages and the guess is wrong.
The Dockerfile builds the server alone.

Then add the environment variables:

| Variable                 | Value                                      |
| ------------------------ | ------------------------------------------ |
| `DATABASE_URL`           | the Neon string, without `channel_binding` |
| `NODE_ENV`               | `production`                               |
| `CROSS_SITE_COOKIES`     | `true`                                     |
| `AUTH_SECRET`            | click **Generate**                         |
| `PRESENTER_TOKEN_SECRET` | click **Generate**                         |

Render's generated values are 64 characters, comfortably over the 32 the
server requires. Leave `CLIENT_ORIGIN` and `JOIN_ORIGIN` until step 5, when
the Vercel URLs exist.

The first build takes several minutes: it compiles TypeScript and installs
libvips for image processing. When it reports live:

```bash
curl https://YOUR-APP.onrender.com/health/ready
```

### The sleep

A free instance stops after fifteen minutes without a request. The next
request starts it again, which takes about fifty seconds, and the browser
simply waits. For a lecture this is a non-issue as long as the URL is opened
beforehand. A free uptime pinger such as UptimeRobot, hitting `/health` every
ten minutes, avoids it entirely.

### Keep it to one instance

The instance count is pinned to one on purpose. Socket.IO rooms and the
broadcast scheduling live in that process's memory, so a second instance
would hold half the room and neither half would see the other's answers.
Scaling out needs a shared adapter first; one instance already carried 1,500
simultaneous phones in testing, which is larger than any lecture hall.

## 4. The front ends, on Vercel

Two projects from the same repository, differing only in root directory.

**Presenter app**

| Setting              | Value                                                  |
| -------------------- | ------------------------------------------------------ |
| Root Directory       | `client`                                               |
| Framework Preset     | Vite                                                   |
| Environment variable | `VITE_SERVER_ORIGIN` = `https://YOUR-APP.onrender.com` |

**Audience app**

| Setting              | Value                                                  |
| -------------------- | ------------------------------------------------------ |
| Root Directory       | `join`                                                 |
| Framework Preset     | Vite                                                   |
| Environment variable | `VITE_SERVER_ORIGIN` = `https://YOUR-APP.onrender.com` |

Each directory has a `vercel.json` that builds from the repository root, which
the workspace layout requires, and rewrites unknown paths to `index.html` so
the six-digit join URLs resolve.

`VITE_SERVER_ORIGIN` is read at build time, not at run time. Changing it means
redeploying.

## 5. Point the server back at them

Once both Vercel URLs exist, add these to the Render service, which redeploys itself:

| Variable        | Value                            |
| --------------- | -------------------------------- |
| `CLIENT_ORIGIN` | `https://YOUR-CLIENT.vercel.app` |
| `JOIN_ORIGIN`   | `https://YOUR-JOIN.vercel.app`   |
| `SERVER_ORIGIN` | `https://YOUR-APP.onrender.com`  |

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
but you are signed out on every refresh, `CROSS_SITE_COOKIES` is not set on
the service.

## Costs

Nothing, at the sizes above. Watch two limits: Neon's 0.5 GB, which is why
images belong in R2, and Vercel's 100 GB of bandwidth, which a lecture does
not come close to.
