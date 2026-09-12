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
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { gzipSync } from 'node:zlib';

/** Gzipped JavaScript budgets, in kilobytes. */
const BUDGETS = {
  join: { js: 50, css: 15 },
  client: { js: 400, css: 60 },
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

let failed = false;
const rows = [];

for (const [app, budget] of Object.entries(BUDGETS)) {
  const dist = join(app, 'dist');
  if (!existsSync(dist)) {
    rows.push([app, 'not built', '', '', DIM]);
    continue;
  }

  const files = walk(dist);
  const totals = { js: 0, css: 0 };

  for (const file of files) {
    const ext = extname(file);
    if (ext === '.js' || ext === '.mjs') totals.js += gzippedKb(file);
    else if (ext === '.css') totals.css += gzippedKb(file);
  }

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
