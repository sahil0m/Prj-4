/*
 * Stops whatever is still holding the development ports.
 *
 * On Windows, Ctrl+C on `npm run dev` asks "Terminate batch job (Y/N)?"
 * for every nested npm wrapper. Closing the terminal instead of answering
 * leaves the real servers running with nothing attached to them, and the
 * next `npm run dev` then fails with EADDRINUSE, or worse, quietly slides
 * the join app to a port the QR code does not point at.
 *
 * Only the three ports this project uses are touched, and every kill is
 * printed, so nothing disappears silently.
 */
import { execFileSync } from 'node:child_process';

const PORTS = [4000, 5173, 5174];

/** PIDs listening on a port, on either platform. */
function listeners(port) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
      return [
        ...new Set(
          out
            .split('\n')
            .filter((line) => line.includes('LISTENING') && line.includes(`:${port} `))
            .map((line) => line.trim().split(/\s+/).pop())
            .filter((pid) => pid && pid !== '0'),
        ),
      ];
    }

    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
    });
    return [
      ...new Set(
        out
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      ),
    ];
  } catch {
    // Nothing listening: both tools exit non-zero when they find no match.
    return [];
  }
}

let killed = 0;

for (const port of PORTS) {
  for (const pid of listeners(port)) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', pid, '/F', '/T']);
      else process.kill(Number(pid), 'SIGKILL');
      process.stdout.write(`  freed port ${port} (pid ${pid})\n`);
      killed += 1;
    } catch {
      process.stdout.write(`  could not stop pid ${pid} on port ${port}\n`);
    }
  }
}

process.stdout.write(killed === 0 ? '  Nothing was running.\n' : `  Stopped ${killed}.\n`);
