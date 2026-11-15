import { randomBytes, timingSafeEqual } from 'node:crypto';

export const BROWSER_SESSION_DAYS = 90;
export const COOKIE_NAME = 'weflow_ai_session';
export const BROWSER_SESSION_MS = BROWSER_SESSION_DAYS * 24 * 60 * 60 * 1000;

export function newBrowserSession(now = Date.now()) {
  return {
    secret: randomBytes(32).toString('base64url'),
    createdAt: now,
    expiresAt: now + BROWSER_SESSION_MS,
  };
}

export function validBrowserSession(cookieHeader, session, now = Date.now()) {
  if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt <= now ||
      typeof session.secret !== 'string') return false;
  if (typeof cookieHeader !== 'string') return false;
  const cookie = cookieHeader.split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE_NAME + '='));
  if (!cookie) return false;
  const actual = Buffer.from(cookie.slice(COOKIE_NAME.length + 1), 'utf8');
  const expected = Buffer.from(session.secret, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * This is a browser pairing lifetime, NOT a guarantee about the model provider's
 * OAuth refresh-token lifetime or subscription eligibility.
 * HttpOnly prevents JavaScript from reading this local-session secret.
 */
export function sessionCookie(session) {
  return [
    COOKIE_NAME + '=' + session.secret,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=' + Math.floor(BROWSER_SESSION_MS / 1000),
  ].join('; ');
}

export function trustedPairRequest(origin, expected = 'http://127.0.0.1:18109') {
  return origin === expected;
}
