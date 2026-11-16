// Talking to the local AI bridge (tools/ai-bridge, 127.0.0.1:18109). The page holds no secret of it: the pairing
// is an HttpOnly cookie, and the ChatGPT credentials never leave the bridge.
import { t } from '../i18n';

const BRIDGE = 'http://127.0.0.1:18109';

export type AiMessage = { role: 'user' | 'assistant'; content: string };

/** A refusal of the bridge, said in the reader's language where the cause is known. */
export class BridgeError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, body: unknown) {
    const detail = body && typeof body === 'object' ? body as { error?: unknown; code?: unknown } : {};
    const code = typeof detail.code === 'string' ? detail.code : null;
    const known: Record<string, () => string> = {
      bridge_busy: () => t('上一个 AI 请求还在进行，请稍候再试。'),
      pairing_declined: () => t('本机配对被拒绝。请在弹出的「WeFlow AI」窗口中选择「允许」。'),
      not_paired: () => t('本机配对已失效，请重新启用本机 AI 登录。'),
      sharing_not_enabled: () => t('ChatGPT 未登录或未授权订阅共享，请重新登录。'),
      timeout: () => t('ChatGPT 没有在限定时间内回答，请重试。'),
      stream_interrupted: () => t('回答中途断开了，可以重试。'),
      network_error: () => t('连不上 ChatGPT，请检查网络后重试。'),
      subscription_sharing_usage_limit_exceeded: () => t('ChatGPT 订阅额度已用完。请在 ChatGPT 设置 > Usage 中查看用量。'),
    };
    const reason = (code && known[code]?.()) || (typeof detail.error === 'string' ? detail.error : '');
    super(reason || t('AI 本地服务出错（HTTP {status}）', { status }));
    this.status = status;
    this.code = code;
  }
}

function send(path: string, signal: AbortSignal, body?: object): Promise<Response> {
  return fetch(BRIDGE + '/ai-auth' + path, {
    method: body ? 'POST' : 'GET',
    credentials: 'include',
    headers: {
      'X-WeFlow-AI-Request': '1',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal,
  });
}

export async function bridgeRequest<T>(path: string, signal: AbortSignal, body?: object): Promise<T> {
  const response = await send(path, signal, body);
  if (!response.ok) throw new BridgeError(response.status, await response.json().catch(() => null));
  return await response.json() as T;
}

type Line = { delta?: unknown; done?: unknown; error?: unknown; code?: unknown; text?: unknown };

/**
 * Asks the model and hands the answer over as it is written: `onDelta` gets each piece. The bridge sends one JSON
 * object a line; an `error` line after some pieces is thrown, the pieces before it stay with the caller.
 */
export async function bridgeComplete(model: string, messages: AiMessage[], signal: AbortSignal, onDelta: (piece: string) => void, purpose?: 'plan'): Promise<void> {
  const response = await send('/complete', signal, { model, messages, ...(purpose ? { purpose } : {}) });
  if (!response.ok) throw new BridgeError(response.status, await response.json().catch(() => null));
  const take = (line: Line) => {
    if (typeof line.error === 'string') throw new BridgeError(502, line);
    if (typeof line.delta === 'string' && line.delta) onDelta(line.delta);
    // a bridge older than the streaming one answers with the whole text at once
    else if (typeof line.text === 'string' && line.text) onDelta(line.text);
  };
  if (!response.headers.get('content-type')?.startsWith('application/x-ndjson') || !response.body) {
    take(await response.json() as Line);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rest = '';
  let finished = false;
  for (;;) {
    const { done, value } = await reader.read();
    rest += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = rest.split('\n');
    rest = done ? '' : lines.pop() ?? '';
    for (const text of lines) {
      if (!text.trim()) continue;
      const line = JSON.parse(text) as Line;
      if (line.done === true) finished = true;
      else take(line);
    }
    if (done) break;
  }
  // the connection closed without the bridge saying the answer was whole
  if (!finished) throw new BridgeError(502, { code: 'stream_interrupted' });
}
