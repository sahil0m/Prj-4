/**
 * Where the server is.
 *
 * In development the Vite proxy forwards /api and /socket.io to the
 * server on port 4000, so a relative path is correct and nothing needs
 * configuring.
 *
 * A hosted deployment splits the two: this page is served from a static
 * host and the server runs somewhere else entirely, so a relative path
 * would ask the static host for the API and get the index page back.
 * Setting VITE_SERVER_ORIGIN at build time points both the API calls and
 * the socket at the right place.
 *
 * Empty is the default, which keeps the relative paths, so a clone that
 * sets nothing behaves exactly as it did before this existed.
 */
const configured = (import.meta.env.VITE_SERVER_ORIGIN ?? '').trim();

/** The origin to prefix API paths with. Empty string in development. */
export const SERVER_ORIGIN = configured.replace(/\/+$/, '');

/** Where the socket should connect. Undefined means "this page's origin". */
export const SOCKET_URL = SERVER_ORIGIN === '' ? undefined : SERVER_ORIGIN;
