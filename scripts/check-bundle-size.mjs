#!/usr/bin/env node
/**
 * Bundle size budget.
 *
 * The participant page has to open in under a second on a bad phone
 * connection. That is not a nice-to-have: if joining is slow, a large part
 * of the room gives up and the results become worthless.
 *
 * A budget that is only written in a document gets quietly broken. This
 * script fails the build instead.
 *
 * The budget is on the first load -- the entry chunk and everything
 * index.html tells the browser to fetch alongside it -- not the sum of
 * every file in dist. Once routes are split, that sum is the cost of
 * visiting every page in the product, which nobody does in one sitting,
 * and budgeting against it would punish splitting work up properly.
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { gzipSync } from 'node:zlib';

/** Gzipped budgets for the first load, in kilobytes. */
const BUDGETS = {
  join: { js: 50, css: 15 },
  client: { js: 300, css: 45 },
};

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function gzippedKb(file) {
  return gzipSync(readFileSync(file)).length / 1024;
}

/**
 * What the browser fetches to show the first screen.
 *
 * Vite lists exactly this in index.html: the entry script, a modulepreload
 * for each chunk it statically imports, and the stylesheet. Anything
 * reached through a dynamic import is absent, which is the distinction
 * that matters.
 */
function firstLoad(dist) {
  const html = join(dist, 'index.html');
  const totals = { js: 0, css: 0 };

  if (!existsSync(html)) return totals;

  const markup = readFileSync(html, 'utf8');

  for (const match of markup.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    const file = join(dist, match[1]);
    if (!existsSync(file)) continue;

    const ext = extname(file);
    if (ext === '.js' || ext === '.mjs') totals.js += gzippedKb(file);
    else if (ext === '.css') totals.css += gzippedKb(file);
  }

  return totals;
}

let failed = false;
const rows = [];

/** Everything else, reported but not budgeted. */
const deferred = new Map();

for (const [app, budget] of Object.entries(BUDGETS)) {
  const dist = join(app, 'dist');
  if (!existsSync(dist)) {
    rows.push([app, 'not built', '', '', DIM]);
    continue;
  }

  const totals = firstLoad(dist);
  const everything = { js: 0, css: 0 };

  for (const file of walk(dist)) {
    const ext = extname(file);
    if (ext === '.js' || ext === '.mjs') everything.js += gzippedKb(file);
    else if (ext === '.css') everything.css += gzippedKb(file);
  }

  deferred.set(app, {
    js: everything.js - totals.js,
    css: everything.css - totals.css,
  });

  for (const kind of ['js', 'css']) {
    const actual = totals[kind];
    const limit = budget[kind];
    const over = actual > limit;
    if (over) failed = true;
    rows.push([
      `${app} ${kind}`,
      `${actual.toFixed(1)} KB`,
      `limit ${limit} KB`,
      over ? 'OVER BUDGET' : 'ok',
      over ? RED : GREEN,
    ]);
  }
}

process.stdout.write(`\n${BOLD}Bundle size (gzipped)${RESET}\n\n`);
for (const [name, actual, limit, verdict, colour] of rows) {
  process.stdout.write(
    `  ${colour}${verdict.padEnd(12)}${RESET}${name.padEnd(14)}${DIM}${actual.padEnd(12)}${limit}${RESET}\n`,
  );
}

// Reported, not budgeted: this is what a visitor pays only if they open
// the page in question, which is the whole point of splitting it out.
for (const [app, extra] of deferred) {
  if (extra.js < 1) continue;
  process.stdout.write(
    `  ${DIM}${''.padEnd(12)}${`${app} routes`.padEnd(14)}` +
      `${`+${extra.js.toFixed(1)} KB`.padEnd(12)}fetched when opened${RESET}\n`,
  );
}

process.stdout.write('\n');

if (failed) {
  process.stderr.write(
    `${RED}${BOLD}Bundle budget exceeded.${RESET}\n` +
      `Run a bundle analysis and remove what crept in. The join page in\n` +
      `particular must stay tiny — it is the difference between a room that\n` +
      `participates and a room that gives up.\n\n`,
  );
  process.exit(1);
}
