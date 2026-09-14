import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { isProduction, env } from '../config.js';
import { logger } from './logger.js';

/**
 * Working out the address a phone should use.
 *
 * The join URL and the QR code are built on the server, because the tab
 * showing them may have been opened on localhost, which is not reachable
 * from anyone else's device. That only helps if the address the server
 * picks is the right one.
 *
 * A laptop usually has several: a Wi-Fi address, a VirtualBox or WSL
 * adapter, a phone hotspot, sometimes a VPN. Picking the wrong one
 * produces a QR code that scans cleanly and then times out, which is a
 * miserable thing to debug in front of a room.
 */

/**
 * Asks the operating system which interface it would actually route
 * through, by opening a UDP socket towards a public address and reading
 * back the local address chosen for it.
 *
 * No packet is ever sent -- connect() on a UDP socket only fixes the
 * route -- so this costs nothing and needs no internet connection, just a
 * routing table. It is the only approach that reliably distinguishes real
 * Wi-Fi from a virtual adapter, because guessing from interface names
 * breaks on every machine that names them differently.
 */
function routedAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;

    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // Already closed; nothing to do.
      }
      resolve(value);
    };

    // A machine with no route at all would otherwise hang here.
    const timer = setTimeout(() => {
      done(null);
    }, 1000);
    timer.unref();

    socket.on('error', () => {
      clearTimeout(timer);
      done(null);
    });

    try {
      // 8.8.8.8 is a well-known address, used purely as a routing target.
      socket.connect(53, '8.8.8.8', () => {
        clearTimeout(timer);
        const address = socket.address().address;
        done(isPrivate(address) ? address : null);
      });
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}

/** The private ranges a router hands out, and nothing routable publicly. */
function isPrivate(host: string): boolean {
  return (
    host.startsWith('10.') || host.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/**
 * Every private IPv4 this machine has, as a fallback.
 *
 * Ordered so a real network beats a virtual one where the name gives it
 * away, but the routing lookup above is what usually decides.
 */
function candidates(): string[] {
  const found: { address: string; virtual: boolean }[] = [];

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (!isPrivate(entry.address)) continue;

      const virtual = /virtualbox|vmware|hyper-v|wsl|loopback|docker/i.test(name);
      found.push({ address: entry.address, virtual });
    }
  }

  return found.sort((a, b) => Number(a.virtual) - Number(b.virtual)).map((f) => f.address);
}

let resolved: string | null = null;
let alternatives: string[] = [];

/**
 * The origin a phone should open, decided once at startup.
 *
 * In production JOIN_ORIGIN is authoritative and nothing here runs: the
 * join app is behind a real hostname, and guessing a private address
 * would be wrong. In development a configured non-loopback address still
 * wins, so someone who has deliberately set one keeps it -- but a
 * loopback value is replaced, because localhost on a phone means the
 * phone.
 */
export async function resolveJoinOrigin(): Promise<string> {
  if (isProduction) {
    resolved = env.JOIN_ORIGIN;
    return resolved;
  }

  const configured = new URL(env.JOIN_ORIGIN);
  const port = configured.port === '' ? '5174' : configured.port;

  const routed = await routedAddress();
  const everyAddress = candidates();

  /*
   * Every address, not just the best guess.
   *
   * A laptop on Wi-Fi and a phone hotspot at once has two, and only one of
   * them reaches any given phone. Guessing wrong puts an address on the
   * projector that nobody in the room can open, with no clue why -- which
   * is exactly what happened. The presenter can now switch to another.
   */
  const ordered = routed ? [routed, ...everyAddress.filter((a) => a !== routed)] : everyAddress;
  const detected = ordered[0] ?? null;

  if (detected === null) {
    // No network at all. Localhost at least works for someone testing on
    // the same machine, which is better than failing to start.
    resolved = env.JOIN_ORIGIN;
    logger.warn(
      { joinOrigin: resolved },
      'No local network address found; phones will not be able to join',
    );
    return resolved;
  }

  resolved = `http://${detected}:${port}`;
  alternatives = ordered.map((address) => `http://${address}:${port}`);

  if (resolved !== env.JOIN_ORIGIN) {
    logger.info(
      { joinOrigin: resolved, configured: env.JOIN_ORIGIN },
      'Phones will join at this address',
    );
  }

  return resolved;
}

/**
 * The resolved origin.
 *
 * Falls back to the configured value if called before startup finished,
 * so nothing can throw on a request path.
 */
export function joinOrigin(): string {
  return resolved ?? env.JOIN_ORIGIN;
}

/**
 * Every address this machine can be reached at, best guess first.
 *
 * The presenter screen shows the first and lets someone pick another when
 * the room cannot reach it. One entry means there is nothing to choose.
 */
export function joinOrigins(): string[] {
  if (alternatives.length > 0) return alternatives;
  return [joinOrigin()];
}
