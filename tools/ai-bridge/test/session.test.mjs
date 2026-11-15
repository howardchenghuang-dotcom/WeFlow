import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_SESSION_MS, COOKIE_NAME, newBrowserSession, sessionCookie,
  trustedPairRequest, validBrowserSession,
} from '../session.mjs';

describe('90-day locally encrypted browser pairing', () => {
  it('has a bounded ninety-day lifetime, never an unlimited login', () => {
    const now = 1000000;
    const session = newBrowserSession(now);
    assert.equal(session.expiresAt - session.createdAt, BROWSER_SESSION_MS);
    assert.equal(validBrowserSession(COOKIE_NAME + '=' + session.secret, session, now + BROWSER_SESSION_MS - 1), true);
    assert.equal(validBrowserSession(COOKIE_NAME + '=' + session.secret, session, now + BROWSER_SESSION_MS), false);
  });
  it('never accepts missing, altered or unrelated cookies', () => {
    const s = newBrowserSession();
    assert.equal(validBrowserSession(undefined, s), false);
    assert.equal(validBrowserSession('foo=' + s.secret, s), false);
    assert.equal(validBrowserSession(COOKIE_NAME + '=not-the-session', s), false);
  });
  it('sets an HttpOnly same-site browser cookie', () => {
    const cookie = sessionCookie(newBrowserSession());
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Max-Age=7776000/);
  });
  it('only accepts the local pairing page origin', () => {
    assert.equal(trustedPairRequest('http://127.0.0.1:18109'), true);
    assert.equal(trustedPairRequest('https://random.example'), false);
  });
});
