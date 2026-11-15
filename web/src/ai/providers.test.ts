import { describe, expect, it } from '#test';
import { PROVIDERS, SUPPORTED_PROVIDERS } from './providers';

describe('subscription-only provider catalogue', () => {
  it('lists five requested providers and does not misrepresent unsupported subscriptions', () => {
    expect(PROVIDERS.map(p => p.id)).toEqual(['chatgpt', 'claude', 'gemini', 'glm', 'kimi']);
    expect(SUPPORTED_PROVIDERS.map(p => p.id)).toEqual(['chatgpt']);
    expect(PROVIDERS.filter(p => p.status === 'unsupported')).toHaveLength(4);
  });
});
