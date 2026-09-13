/**
 * Which address a phone should open.
 *
 * "The QR code does not work" is nearly always the wrong network address,
 * and it is hard to see from the presenter screen because the laptop can
 * reach everything. This prints what the server would hand out, next to
 * every address the machine has, so the mismatch is visible.
 */
import { networkInterfaces } from 'node:os';
import { resolveJoinOrigin } from '../lib/network.js';
import { env } from '../config.js';

const G = '\x1b[32m';
const Y = '\x1b[33m';
const D = '\x1b[2m';
const X = '\x1b[0m';

async function main(): Promise<void> {
  const chosen = await resolveJoinOrigin();
  const chosenHost = new URL(chosen).hostname;

  process.stdout.write(`\n${D}Addresses on this machine${X}\n\n`);

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const mark = entry.address === chosenHost ? `${G}  <- phones use this${X}` : '';
      process.stdout.write(`  ${entry.address.padEnd(16)}${D}${name}${X}${mark}\n`);
    }
  }

  process.stdout.write(`\n${D}Join address${X}\n\n  ${G}${chosen}${X}\n`);

  if (chosen !== env.JOIN_ORIGIN) {
    process.stdout.write(
      `\n  ${Y}JOIN_ORIGIN in .env says ${env.JOIN_ORIGIN}${X}\n` +
        `  ${D}Detected instead, because that value is not reachable from a phone${X}\n`,
    );
  }

  process.stdout.write(
    `\n  ${D}A phone must be on the same network. If it cannot load this,${X}\n` +
      `  ${D}check that the two are on the same Wi-Fi and not a guest network.${X}\n\n`,
  );
}

void main();
