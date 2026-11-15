import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validBridgeToken, validCompletion, validHost, validOrigin, MAX_PROMPT } from '../guard.mjs';

describe('local AI bridge request guards', () => {
  it('blocks other origins and DNS rebinding hosts', () => {
    assert.equal(validOrigin('http://127.0.0.1:18108'), true);
    assert.equal(validOrigin('https://attacker.example'), false);
    assert.equal(validHost('localhost:18109'), true);
    assert.equal(validHost('evil.example:18109'), false);
  });
  it('compares bridge secrets without a timing-sensitive short-circuit', () => {
    assert.equal(validBridgeToken('abc', 'abc'), true);
    assert.equal(validBridgeToken('abc', 'abcd'), false);
    assert.equal(validBridgeToken('bad', 'abc'), false);
  });
  it('caps all inputs before any cloud request', () => {
    assert.equal(validCompletion({ model: 'test-model', prompt: 'ok' }), true);
    assert.equal(validCompletion({ model: 'test-model', prompt: 'x'.repeat(MAX_PROMPT + 1) }), false);
    assert.equal(validCompletion({ model: 'bad model', prompt: 'ok' }), false);
    assert.equal(validCompletion({ model: 'test-model', prompt: '' }), false);
  });
});
