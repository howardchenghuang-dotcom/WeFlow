import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export const BROWSER_SESSION_DAYS = 90;
export const COOKIE_NAME = 'weflow_ai_session';
export const COOKIE_PATH = '/ai-auth';
export const BROWSER_SESSION_MS = BROWSER_SESSION_DAYS * 24 * 60 * 60 * 1000;

/** Pairing this browser with the local service, not an OpenAI credential. */
export function newBrowserSession(now = Date.now()) {
  return {
    secret: randomBytes(32).toString('base64url'),
    createdAt: now,
    expiresAt: now + BROWSER_SESSION_MS,
  };
}

export function validBrowserSession(cookieHeader, session, now = Date.now()) {
  if (!session || !Number.isFinite(session.expiresAt) ||
      session.expiresAt <= now || typeof session.secret !== 'string') return false;
  if (typeof cookieHeader !== 'string') return false;
  const cookie = cookieHeader.split(';').map(x => x.trim())
    .find(x => x.startsWith(COOKIE_NAME + '='));
  if (!cookie) return false;
  const actual = Buffer.from(cookie.slice(COOKIE_NAME.length + 1), 'utf8');
  const expected = Buffer.from(session.secret, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * HttpOnly pairing cookie, restricted to /ai-auth to avoid sending it on normal
 * WeFlow API requests. Browser persistence is at most 90 days; the ChatGPT SDK
 * still controls actual OAuth refresh, revocation and subscription eligibility.
 */
export function sessionCookie(session, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((session.expiresAt - now) / 1000));
  return [
    COOKIE_NAME + '=' + session.secret,
    'HttpOnly', 'SameSite=Strict', 'Path=' + COOKIE_PATH, 'Max-Age=' + seconds,
  ].join('; ');
}

export function clearSessionCookie() {
  return [COOKIE_NAME + '=', 'HttpOnly', 'SameSite=Strict',
    'Path=' + COOKIE_PATH, 'Max-Age=0'].join('; ');
}

/**
 * A tiny persistence layer for the browser-pairing secret. Both the file and
 * ChatGPT OAuth credentials are encrypted using Windows safeStorage. This
 * function deliberately has no plaintext fallback; encrypt/decrypt are injected
 * so tests can exercise the persistence without installing Electron.
 */
export function encryptedSessionStore({ filePath, encrypt, decrypt }) {
  return {
    async read() {
      let bytes;
      try {
        bytes = await readFile(filePath);
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
      const decrypted = await decrypt(bytes);
      const data = JSON.parse(decrypted);
      if (!data || typeof data.secret !== 'string' ||
          !Number.isFinite(data.createdAt) || !Number.isFinite(data.expiresAt)) {
        throw new Error('Invalid encrypted browser session data');
      }
      return data;
    },
    async write(data) {
      const bytes = await encrypt(JSON.stringify(data));
      await mkdir(dirname(filePath), { recursive: true });
      const temporary = filePath + '.new';
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, filePath);
    },
    async clear() {
      try { await unlink(filePath); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  };
}
