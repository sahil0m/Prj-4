/**
 * Image uploads, against a running server.
 *
 * A route that accepts files from the internet is the most dangerous
 * surface in the product, so most of these drive something that must be
 * refused rather than something that must work.
 *
 * Run the server first, then:
 *   npm run images:verify --workspace @pulse/server
 */
import sharp from 'sharp';
import { and, eq, like } from 'drizzle-orm';
import { connectDb, disconnectDb, db } from '../lib/db.js';
import { users, images } from '../db/schema.js';

const BASE = process.env.PULSE_URL ?? 'http://localhost:4000';
const API = `${BASE}/api`;

const G = '\x1b[32m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const B = '\x1b[1m';
const X = '\x1b[0m';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    process.stdout.write(`  ${G}PASS${X}  ${name}\n`);
    return;
  }
  failed += 1;
  process.stdout.write(`  ${R}FAIL${X}  ${name}\n${detail ? `        ${D}${detail}${X}\n` : ''}`);
}

/** A real image of a given size, as a camera would produce one. */
function picture(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 60, b: 30 } },
  })
    .jpeg()
    .toBuffer();
}

async function upload(
  token: string,
  bytes: Buffer,
  filename: string,
  type: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(bytes)], { type }), filename);

  const response = await fetch(`${API}/images`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });

  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as never) };
}

async function main(): Promise<void> {
  process.stdout.write(`\n${B}Image uploads, against ${BASE}${X}\n\n`);

  const stamp = Date.now();
  const email = `images-verify-${String(stamp)}@example.test`;

  const registered = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'a-strong-passphrase-here', name: 'Images' }),
  });

  if (registered.status !== 201) throw new Error('could not register a presenter');
  const token = ((await registered.json()) as { accessToken: string }).accessToken;

  /* ---------------- the ordinary path ---------------- */

  const photo = await picture(4000, 3000);
  const result = await upload(token, photo, 'holiday.jpg', 'image/jpeg');

  check('a photo uploads', result.status === 201, JSON.stringify(result.body));
  check(
    'the address is one a slide can store',
    typeof result.body.url === 'string' && /^\/api\/images\/[0-9a-f]{24}$/.test(result.body.url),
    String(result.body.url),
  );

  /*
   * The reason for re-encoding: a phone photo is several megabytes, and a
   * room full of phones downloading that over mobile data is the slowest
   * thing in the product.
   */
  check(
    'a huge photo is shrunk to something a phone can load',
    typeof result.body.bytes === 'number' && result.body.bytes < photo.length / 10,
    `${String(photo.length)} bytes in, ${String(result.body.bytes)} out`,
  );
  check(
    'it is resized to fit the longest edge',
    result.body.width === 1600 && result.body.height === 1200,
    `${String(result.body.width)}x${String(result.body.height)}`,
  );

  /* ---------------- serving it ---------------- */

  const url = String(result.body.url);
  const fetched = await fetch(`${BASE}${url}`);
  const served = Buffer.from(await fetched.arrayBuffer());

  check('the image is served back', fetched.status === 200, `status ${String(fetched.status)}`);
  check(
    'it is served as the image it is',
    fetched.headers.get('content-type') === 'image/webp',
    String(fetched.headers.get('content-type')),
  );
  check(
    'a browser is told never to sniff the type',
    fetched.headers.get('x-content-type-options') === 'nosniff',
    String(fetched.headers.get('x-content-type-options')),
  );
  check(
    'it is cached, so a phone fetches it once',
    (fetched.headers.get('cache-control') ?? '').includes('immutable'),
    String(fetched.headers.get('cache-control')),
  );
  check('the bytes really are an image', (await sharp(served).metadata()).width === 1600);

  // The audience has no account, so this cannot require one.
  check('the audience can load it without signing in', fetched.status === 200);

  /* ---------------- the small copy ---------------- */

  const thumbResponse = await fetch(`${BASE}${url}?size=thumb`);
  const thumb = Buffer.from(await thumbResponse.arrayBuffer());
  const thumbMeta = await sharp(thumb).metadata();

  check(
    'a small copy is served',
    thumbResponse.status === 200,
    `status ${String(thumbResponse.status)}`,
  );
  check(
    'it is small enough for a phone showing four of them',
    thumb.length < served.length / 4,
    `${String(served.length)} full, ${String(thumb.length)} small`,
  );
  check(
    'it is still the same picture, scaled down',
    thumbMeta.width === 320,
    String(thumbMeta.width),
  );

  /* ---------------- what must be refused ---------------- */

  const noAuth = await fetch(`${API}/images`, { method: 'POST', body: new FormData() });
  check(
    'uploading without signing in is refused',
    noAuth.status === 401,
    `got ${String(noAuth.status)}`,
  );

  /*
   * The dangerous one: a file that claims to be an image and is not.
   * Stored as sent and served back, this is how a script ends up running
   * on the viewer's page.
   */
  const script = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  const disguised = await upload(token, script, 'picture.png', 'image/png');
  check(
    'a script dressed up as a PNG is refused',
    disguised.status === 422,
    `got ${String(disguised.status)}: ${JSON.stringify(disguised.body)}`,
  );

  const html = Buffer.from('<!doctype html><script>alert(1)</script>');
  const asHtml = await upload(token, html, 'page.html', 'text/html');
  check('a web page is refused', asHtml.status === 422, `got ${String(asHtml.status)}`);

  const empty = await upload(token, Buffer.alloc(0), 'nothing.png', 'image/png');
  check('an empty file is refused', empty.status === 422, `got ${String(empty.status)}`);

  const missing = await fetch(`${BASE}/api/images/${'0'.repeat(24)}`);
  check('an unknown id is a plain 404', missing.status === 404, `got ${String(missing.status)}`);

  const malformed = await fetch(`${BASE}/api/images/not-an-id`);
  check(
    'a malformed id is a plain 404',
    malformed.status === 404,
    `got ${String(malformed.status)}`,
  );

  /* ---------------- what is actually stored ---------------- */

  await connectDb();

  const [stored] = await db
    .select({ mime: images.mime, bytes: images.bytes })
    .from(images)
    .where(eq(images.id, url.slice('/api/images/'.length)));

  check(
    'it is stored as webp whatever arrived',
    stored?.mime === 'image/webp',
    String(stored?.mime),
  );
  check(
    'the recorded size matches the bytes served',
    stored?.bytes === served.length,
    `${String(stored?.bytes)} recorded, ${String(served.length)} served`,
  );

  /* ---------------- tidy up ---------------- */

  // Deleting the account takes its images with it, which is itself the
  // check that the cascade works.
  await db.delete(users).where(and(eq(users.email, email), like(users.email, '%@example.test')));

  const left = await db
    .select({ id: images.id })
    .from(images)
    .where(eq(images.id, url.slice('/api/images/'.length)));
  check('removing an account removes its images', left.length === 0);

  await disconnectDb();

  process.stdout.write(
    `\n  ${passed > 0 ? G : D}${String(passed)} passed${X}` +
      (failed > 0 ? `   ${R}${B}${String(failed)} failed${X}` : '') +
      '\n\n',
  );

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err: unknown) => {
  process.stderr.write(`\n${R}${B}The run itself failed${X}\n${String(err)}\n\n`);
  process.stderr.write(`${D}Is the server running? npm run dev${X}\n\n`);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
