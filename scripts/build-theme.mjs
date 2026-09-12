#!/usr/bin/env node
/**
 * Writes the generated stylesheet into the apps that consume it.
 * Run automatically before dev and build, so the CSS can never drift
 * away from the tokens it is derived from.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateStylesheet } from '../shared/dist/index.js';

const css = generateStylesheet();
const targets = ['client/src/styles/theme.css', 'join/src/styles/theme.css'];

for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, css);
  console.log(`theme -> ${target}  (${(css.length / 1024).toFixed(1)} KB)`);
}
