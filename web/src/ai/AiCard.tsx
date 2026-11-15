import { useEffect, useRef, useState } from 'react';
import { getMessages } from '../api/messages';
import { prepareAiExcerpt } from './context';
import { PROVIDERS } from './providers';

const BRIDGE = 'http://127.0.0.1:18109';
const MAX_QUESTION = 800;

type Model = { slug: string; displayName: string };
type CloudState = { status: string; sharing: boolean };

async function bridgeRequest<T>(path: string, bridgeToken: string, signal: AbortSignal, body?: object): Promise<T> {
  const response = await fetch(BRIDGE + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + bridgeToken,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal,
  });
  if (!response.ok) throw new Error('AI 本地桥接失败（HTTP ' + response.status + '）');
  return await response.json() as T;
}

function fromDate(days: number): number {
  return Math.floor(Date.now() / 1000) - days * 86400;
}

/**
 * This card is intentionally not an OAuth client. Authentication belongs only to the trusted
 * Electron bridge process. A manually copied bridge token is held in component memory, not stored.
 */
export function AiCard({ sessionId, sessionName }: { sessionId: string; sessionName: string }) {
  const [bridgeToken, setBridgeToken] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [connected, setConnected] = useState(false);
  const [days, setDays] = useState(30);
  const [question, setQuestion] = useState('请总结这些聊天记录的主要内容，并标出有依据的待办事项。');
  const [consent, setConsent] = useState(false);
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<{ localId: number; createTime: number; sender: string }[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [epoch, setEpoch] = useState(0);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    activeRequest.current?.abort();
    setAnswer(''); setCitations([]); setConsent(false); setError(''); setBusy(false);
    return () => { activeRequest.current?.abort(); };
  }, [sessionId]);

  const connect = async () => {
    setError('');
    setConnected(false);
    const controller = new AbortController();
    try {
      const session = await bridgeRequest<CloudState>('/session', bridgeToken.trim(), controller.signal);
      if (session.status !== 'connected' || !session.sharing) {
        throw new Error('请先在 WeFlow AI 桥接窗口中使用 ChatGPT 登录并授权订阅共享。');
      }
      const result = await bridgeRequest<{ models: Model[] }>('/models', bridgeToken.trim(), controller.signal);
      if (!result.models.length) throw new Error('当前订阅未返回可用模型。');
      setModels(result.models);
      setModel(result.models[0].slug);
      setConnected(true);
      setEpoch(value => value + 1);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '本地 AI 桥接未连接。');
    }
  };

  const ask = async () => {
    if (!sessionId || !connected || !consent || !question.trim() || busy) return;
    if (question.length > MAX_QUESTION) { setError('问题文字过长。'); return; }
    setBusy(true); setError(''); setAnswer(''); setCitations([]);
    const controller = new AbortController();
    activeRequest.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 135_000);
    try {
      // Only the newest 200 entries of the selected conversation are fetched, not the account history.
      const messages = await getMessages(sessionId, null, controller.signal, 200);
      const result = prepareAiExcerpt({
        sessionId, messages: messages.filter(item => item.localType === 1),
        start: fromDate(days), end: Math.floor(Date.now() / 1000),
        maxMessages: 80, maxCharacters: 12_000,
      });
      if (!result.citations.length) throw new Error('选定时间内最近的记录没有可分析的文本消息。');
      const prompt = result.prompt + '\n\nUSER QUESTION: ' + question.trim();
      const data = await bridgeRequest<{ text: string }>('/complete', bridgeToken.trim(), controller.signal, { model, prompt });
      setAnswer(data.text);
      setCitations(result.citations);
      setTruncated(result.truncated || messages.length >= 200);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'AI 分析失败，请检查本地桥接程序。');
    } finally {
      window.clearTimeout(timeout);
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  };

  return <div className="ai-assistant">
    <p className="card-lead">AI 助手 · {sessionName}</p>
    <div className="form-row">
      <label className="field-label" htmlFor="ai-provider">订阅提供商</label>
      <select id="ai-provider" defaultValue="chatgpt" aria-label="订阅提供商">
        {PROVIDERS.map(provider => <option value={provider.id} key={provider.id} disabled={provider.status !== 'available'}>
          {provider.title}{provider.status === 'available' ? ' · 已支持' : ' · 暂未支持'}
        </option>)}
      </select>
    </div>
    <p className="card-note">目前仅 ChatGPT 支持本工具的订阅登录。Claude、Gemini、GLM、Kimi 已纳入模型目录，待官方授权方式验证后才会开放。</p>
    <p className="card-note">请先在 Windows 启动 WeFlow AI 桥接程序并通过 ChatGPT 订阅登录；仅在你点击“分析”时发送所选聊天片段。</p>
    {!connected && <>
      <div className="form-row"><label className="field-label" htmlFor="ai-bridge-token">本地桥接令牌</label>
        <input id="ai-bridge-token" type="password" autoComplete="off" value={bridgeToken}
          placeholder="在 AI 桥接窗口复制" onChange={e => setBridgeToken(e.target.value)} /></div>
      <button type="button" className="secondary-button" onClick={() => void connect()} disabled={!bridgeToken.trim()}>连接本地 AI 桥接</button>
    </>}
    {connected && <>
      <p className="card-note" role="status">ChatGPT 订阅已连接（连接 #{epoch}）</p>
      <div className="form-row"><label className="field-label" htmlFor="ai-model">模型</label>
        <select id="ai-model" value={model} onChange={e => setModel(e.target.value)}>
          {models.map(item => <option key={item.slug} value={item.slug}>{item.displayName}</option>)}
        </select></div>
      <div className="form-row"><label className="field-label" htmlFor="ai-days">查看范围</label>
        <select id="ai-days" value={days} onChange={e => setDays(Number(e.target.value))}>
          <option value={7}>最近 7 天</option><option value={30}>最近 30 天</option>
          <option value={90}>最近 90 天</option><option value={365}>最近一年</option>
        </select></div>
      <p className="card-note">最多读取当前会话最近 200 条，发送其中最多 80 条文字消息；不包含图片、语音、其他会话。</p>
      <div className="form-row"><label className="field-label" htmlFor="ai-question">向 AI 提问</label>
        <textarea id="ai-question" rows={4} maxLength={MAX_QUESTION} value={question} onChange={e => setQuestion(e.target.value)} /></div>
      <label className="card-note"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
        我同意仅将上述选定消息发送至 ChatGPT 云端进行本次分析</label>
      <button type="button" className="primary-button" onClick={() => void ask()}
        disabled={!consent || !model || busy || !question.trim()}>{busy ? '分析中…' : '使用 ChatGPT Pro 分析'}</button>
      {truncated && <p className="card-note">此次仅分析了部分聊天消息，不能代表完整会话历史。</p>}
      {answer && <div className="card-note" style={{ whiteSpace: 'pre-wrap' }} role="status">{answer}</div>}
      {citations.length > 0 && <details><summary>本次引用范围（{citations.length} 条）</summary>
        <p className="card-note">引用格式：[消息ID@Unix时间戳]。模型生成的引用仍需要人工核对。</p>
        <div style={{ maxHeight: 180, overflow: 'auto' }}>
          {citations.map(item => <p className="card-note" key={item.localId + ':' + item.createTime}>
            [{item.localId}@{item.createTime}] {new Date(item.createTime * 1000).toLocaleString()} · {item.sender}
          </p>)}
        </div>
      </details>}
    </>}
    {error && <p role="alert" className="card-note">{error}</p>}
  </div>;
}
