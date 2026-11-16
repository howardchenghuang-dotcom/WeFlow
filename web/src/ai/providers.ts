/**
 * Subscription-only AI providers for a personal local WeFlow installation.
 * "Available" means the provider itself documents a way for a local third-party tool to use the plan.
 * An API key for metered billing must never be requested or used as a fallback.
 * The reasons are what each provider's own pages said on 2026-11-15; see tools/ai-bridge/README.md.
 */
import { msg } from '../i18n';

export type ProviderId = 'chatgpt' | 'claude' | 'gemini' | 'glm' | 'kimi';

export interface Provider {
  id: ProviderId;
  title: string;
  status: 'available' | 'unsupported';
  /** Shown to the reader; a text of the page, translated where it is drawn. */
  reason: string;
}

export const PROVIDERS: readonly Provider[] = [
  { id: 'chatgpt', title: 'ChatGPT', status: 'available',
    reason: msg('通过 OpenAI 官方的 Sign in with ChatGPT 接入，使用你自己的订阅额度。') },
  { id: 'claude', title: 'Claude', status: 'unsupported',
    reason: msg('Anthropic 只允许在它自己的客户端里用订阅登录，第三方工具不能提供 Claude 登录。') },
  { id: 'gemini', title: 'Gemini', status: 'unsupported',
    reason: msg('Google 的订阅不包含 API 用量，条款禁止第三方软件使用 Gemini CLI 的登录。') },
  { id: 'glm', title: 'GLM', status: 'unsupported',
    reason: msg('智谱 Coding Plan 只能在官方指定的编程工具里使用，自建应用须另走按量计费的 API。') },
  { id: 'kimi', title: 'Kimi', status: 'unsupported',
    reason: msg('Kimi Code 的权益限于编程场景和个人交互式使用，不适用于分析聊天记录。') },
];
