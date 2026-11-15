import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROWSER_SESSION_MS, COOKIE_NAME, newBrowserSession, sessionCookie,
  validBrowserSession, encryptedSessionStore, clearSessionCookie,
} from '../session.mjs';

describe('90-day browser pairing rules', () => {
  it('expires after ninety days and does not silently extend', () => {
    const now = 1000000;
    const session = newBrowserSession(now);
    assert.equal(session.expiresAt - session.createdAt, BROWSER_SESSION_MS);
    assert.equal(validBrowserSession(COOKIE_NAME + '=' + session.secret, session, now + BROWSER_SESSION_MS - 1), true);
    assert.equal(validBrowserSession(COOKIE_NAME + '=' + session.secret, session, now + BROWSER_SESSION_MS), false);
  });
  it('rejects missing or altered cookies', () => {
    const s = newBrowserSession();
    assert.equal(validBrowserSession(undefined, s), false);
    assert.equal(validBrowserSession('foo=' + s.secret, s), false);
    assert.equal(validBrowserSession(COOKIE_NAME + '=not-the-session', s), false);
  });
  it('issues HttpOnly same-site restricted-path cookies, with a clearing rule', () => {
    const cookie = sessionCookie(newBrowserSession());
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/ai-auth/);
    assert.match(cookie, /Max-Age=7776000/);
    assert.match(clearSessionCookie(), /Max-Age=0/);
  });
  it('stores pairing data encrypted and restores across restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weflow-auth-'));
    try {
      const filePath = join(dir, 'session.enc');
      const encrypt = async plain => Buffer.from('ENC:' + plain).reverse();
      const decrypt = async bytes => {
        const original = Buffer.from(bytes).reverse().toString();
        assert.ok(original.startsWith('ENC:'));
        return original.slice(4);
      };
      const store = encryptedSessionStore({ filePath, encrypt, decrypt });
      assert.equal(await store.read(), null);
      const s = newBrowserSession();
      await store.write(s);
      const reloaded = encryptedSessionStore({ filePath, encrypt, decrypt });
      assert.deepEqual(await reloaded.read(), s);
      await reloaded.clear();
      assert.equal(await store.read(), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
