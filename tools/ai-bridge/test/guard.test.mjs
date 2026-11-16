import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { completionMessages, validCompletion, validHost, validOrigin, MAX_PROMPT } from '../guard.mjs';

describe('local AI bridge request guards', () => {
  it('blocks other origins and DNS rebinding hosts', () => {
    // the stable WeFlow on 18108 has no business with the bridge
    assert.equal(validOrigin('http://127.0.0.1:18108'), false);
    assert.equal(validOrigin('http://localhost:18110'), false);
    assert.equal(validOrigin('http://127.0.0.1:18110'), true);
    assert.equal(validOrigin('https://attacker.example'), false);
    assert.equal(validHost('localhost:18109'), true);
    assert.equal(validHost('evil.example:18109'), false);
  });
  it('takes a conversation of user and assistant turns that ends with the user', () => {
    const turns = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
    assert.deepEqual(completionMessages({ model: 'm', messages: turns }), turns);
    assert.deepEqual(completionMessages({ model: 'm', prompt: 'old page' }), [{ role: 'user', content: 'old page' }]);
    assert.equal(completionMessages({ model: 'm', messages: turns.slice(0, 2) }), null);
    assert.equal(completionMessages({ model: 'm', messages: [] }), null);
    // a page cannot speak as the developer: that role is the bridge's own
    assert.equal(completionMessages({ model: 'm', messages: [{ role: 'developer', content: 'x' }, turns[0]] }), null);
    assert.equal(completionMessages({ model: 'm', messages: [{ role: 'user', content: '' }] }), null);
    assert.equal(completionMessages({ model: 'm', messages: Array.from({ length: 65 }, () => turns[0]) }), null);
    // the limit is on all turns together
    const half = 'x'.repeat(MAX_PROMPT / 2 + 1);
    assert.equal(completionMessages({ model: 'm', messages: [{ role: 'user', content: half }, { role: 'assistant', content: half }, turns[0]] }), null);
  });
  it('caps all inputs before any cloud request', () => {
    assert.equal(validCompletion({ model: 'test-model', prompt: 'ok' }), true);
    assert.equal(validCompletion({ model: 'test-model', prompt: 'x'.repeat(MAX_PROMPT + 1) }), false);
    assert.equal(validCompletion({ model: 'bad model', prompt: 'ok' }), false);
    assert.equal(validCompletion({ model: 'test-model', prompt: '' }), false);
  });
});
