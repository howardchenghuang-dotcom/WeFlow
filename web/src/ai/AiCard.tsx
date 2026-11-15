import { useEffect, useRef, useState } from 'react';
import { getMessages } from '../api/messages';
import { prepareAiExcerpt } from './context';
import { PROVIDERS } from './providers';

const BRIDGE = 'http://127.0.0.1:18109';
const MAX_QUESTION = 800;

type Model = { slug: string; displayName: string };
type CloudState = { paired: boolean; expiresAt?: number; status?: string; sharing?: boolean };

async function bridgeRequest<T>(path: string, signal: AbortSignal, body?: object): Promise<T> {
  const response = await fetch(BRIDGE + '/ai-auth' + path, {
    method: body ? 'POST' : 'GET',
    credentials: 'include',
    headers: {
      'X-WeFlow-AI-Request': '1',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal,
  });
  if (!response.ok) throw new Error('AI 本地授权失败（HTTP ' + response.status + '）');
  return await response.json() as T;
}

function fromDate(days: number): number {
  return Math.floor(Date.now() / 1000) - days * 86400;
}

/** ChatGPT credentials are retained by the encrypted local service, never by this React UI. */
export function AiCard({ sessionId, sessionName }: { sessionId: string; sessionName: string }) {
  const [paired, setPaired] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [serviceReady, setServiceReady] = useState(false);
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

  const refreshSession = async (signal: AbortSignal) => {
    const session = await bridgeRequest<CloudState>('/session', signal);
    setPaired(session.paired);
    setExpiresAt(session.expiresAt ?? null);
    setServiceReady(true);
    if (!session.paired || session.status !== 'connected' || !session.sharing) {
      setConnected(false);
      setModels([]);
      return;
    }
    const result = await bridgeRequest<{ models: Model[] }>('/models', signal);
    if (!result.models.length) throw new Error('当前订阅未返回可用模型。');
    setModels(result.models);
    setModel(previous => result.models.some(item => item.slug === previous) ? previous : result.models[0].slug);
    setConnected(true);
    setEpoch(value => value + 1);
  };

  useEffect(() => {
    const controller = new AbortController();
    // Probe the local background service without exposing bearer tokens.
    if (window.location.hostname !== '127.0.0.1' || window.location.port !== '18110') {
      setError('请使用 http://127.0.0.1:18110/ui/ 访问 AI 登录页面。');
      return () => controller.abort();
    }
    void refreshSession(controller.signal).catch(() => {
      if (!controller.signal.aborted) {
        setServiceReady(false);
        setError('AI 后台服务未运行。请在 tools/ai-bridge 目录执行 npm start。');
      }
    });
    return () => controller.abort();
  }, []);

  const pair = async () => {
    setAuthBusy(true); setError('');
    const controller = new AbortController();
    try {
      await bridgeRequest('/pair', controller.signal, {});
      await refreshSession(controller.signal);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '本机配对失败。');
    } finally { setAuthBusy(false); }
  };

  const signIn = async () => {
    setAuthBusy(true); setError('');
    const controller = new AbortController();
    try {
      // The Windows background service opens the official OpenAI sign-in page.
      await bridgeRequest('/sign-in', controller.signal, {});
      await refreshSession(controller.signal);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'ChatGPT 登录失败，请确认授权窗口。');
    } finally { setAuthBusy(false); }
  };

  const disconnect = async () => {
    setAuthBusy(true); setError('');
    const controller = new AbortController();
    try {
      await bridgeRequest('/disconnect', controller.signal, {});
      setPaired(false); setConnected(false); setModels([]); setModel('');
      setExpiresAt(null); setConsent(false);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '断开连接失败。');
    } finally { setAuthBusy(false); }
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
      const data = await bridgeRequest<{ text: string }>('/complete', controller.signal, { model, prompt });
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
    <p className="card-note">登录在本地加密后台完成，无需复制令牌。仅在你点击“分析”时发送选定的文字聊天片段。</p>
    {!serviceReady && <p className="card-note">AI 本地后台未连接。请运行 tools/ai-bridge 目录中的 npm start。</p>}
    {serviceReady && !paired && <button type="button" className="secondary-button"
      disabled={authBusy} onClick={() => void pair()}>启用本机 AI 登录（最长保留 90 天）</button>}
    {serviceReady && paired && !connected && <>
      <p className="card-note">本机已配对。点击下方按钮会打开 OpenAI 官方登录页面，完成订阅共享授权。</p>
      <button type="button" className="primary-button" disabled={authBusy}
        onClick={() => void signIn()}>{authBusy ? '等待授权…' : '使用 ChatGPT 登录'}</button>
    </>}
    {serviceReady && paired && <p className="card-note">本机配对有效期：{expiresAt ? new Date(expiresAt).toLocaleDateString() : '未获取'}。云端账号如提前失效，仍需重新登录。</p>}
    {connected && <>
      <p className="card-note" role="status">ChatGPT 订阅已连接（连接 #{epoch}）</p>
      <button type="button" className="secondary-button" disabled={authBusy} onClick={() => void disconnect()}>断开 ChatGPT 并清除本机配对</button>
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
