import { timingSafeEqual } from 'node:crypto';

export const AI_PORT = 18109;
export const AI_ORIGINS = new Set([
  'http://127.0.0.1:18108', 'http://localhost:18108',
  // Preview WebUI: keep the user's stable WeFlow on port 18108 untouched.
  'http://127.0.0.1:18110', 'http://localhost:18110',
]);
export const MAX_PROMPT = 28_000;

export function validHost(host) {
  return host === `127.0.0.1:${AI_PORT}` || host === `localhost:${AI_PORT}`;
}

export function validOrigin(origin) {
  return typeof origin === 'string' && AI_ORIGINS.has(origin);
}

export function validBridgeToken(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const received = Buffer.from(value);
  const desired = Buffer.from(expected);
  return received.length === desired.length && timingSafeEqual(received, desired);
}

export function validCompletion(body) {
  return body && typeof body === 'object'
    && typeof body.model === 'string' && /^[a-zA-Z0-9._:-]{1,120}$/.test(body.model)
    && typeof body.prompt === 'string'
    && body.prompt.length > 0 && body.prompt.length <= MAX_PROMPT;
}
