export const AI_PORT = 18109;
// The preview WebUI is the only page that talks to the bridge. The stable WeFlow on 18108 never does.
export const AI_ORIGINS = new Set(['http://127.0.0.1:18110']);
export const MAX_PROMPT = 28_000;
export const MAX_MESSAGES = 64;

export function validHost(host, port = AI_PORT) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function validOrigin(origin) {
  return typeof origin === 'string' && AI_ORIGINS.has(origin);
}

/**
 * The conversation of a completion request, or null when the request is not one: a model name, then either
 * `messages` (user and assistant turns, the last one the user's) or the single `prompt` of earlier pages.
 * All text together is at most MAX_PROMPT characters.
 */
export function completionMessages(body) {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.model !== 'string' || !/^[a-zA-Z0-9._:-]{1,120}$/.test(body.model)) return null;
  const messages = typeof body.prompt === 'string' ? [{ role: 'user', content: body.prompt }] : body.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) return null;
  let size = 0;
  const clean = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') return null;
    if (message.role !== 'user' && message.role !== 'assistant') return null;
    if (typeof message.content !== 'string' || !message.content) return null;
    size += message.content.length;
    if (size > MAX_PROMPT) return null;
    clean.push({ role: message.role, content: message.content });
  }
  return clean[clean.length - 1].role === 'user' ? clean : null;
}

export function validCompletion(body) {
  return completionMessages(body) !== null;
}
