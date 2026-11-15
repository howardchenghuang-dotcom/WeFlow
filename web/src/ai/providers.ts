/**
 * Subscription-only AI providers for a personal local WeFlow installation.
 * "Available" means a supported plan-authenticated integration exists in this app.
 * An API key for metered billing must never be requested or used as a fallback.
 */
export type ProviderId = 'chatgpt' | 'claude' | 'gemini' | 'glm' | 'kimi';

export interface Provider {
  id: ProviderId;
  title: string;
  status: 'available' | 'unsupported';
  description: string;
}

export const PROVIDERS: readonly Provider[] = [
  { id: 'chatgpt', title: 'ChatGPT', status: 'available',
    description: 'Sign in with ChatGPT · Uses eligible subscription entitlements.' },
  { id: 'claude', title: 'Claude', status: 'unsupported',
    description: 'Claude subscription login is not a verified third-party chat integration.' },
  { id: 'gemini', title: 'Gemini', status: 'unsupported',
    description: 'Subscription-based integration for this personal tool has not been validated.' },
  { id: 'glm', title: 'GLM', status: 'unsupported',
    description: 'Coding-plan entitlement must not be assumed to cover general chat analysis.' },
  { id: 'kimi', title: 'Kimi', status: 'unsupported',
    description: 'Coding-plan entitlement must not be assumed to cover general chat analysis.' },
];

export const SUPPORTED_PROVIDERS = PROVIDERS.filter(p => p.status === 'available');
