import { useEffect, useRef, useState } from 'react';
import { getMessages } from '../api/messages';
import { buildAiPrompt, MAX_VISIBLE_TURNS, type AiTurn } from './chatHistory';
import { prepareAiExcerpt } from './context';
import { PROVIDERS } from './providers';
import './ai-chat.css';

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
  if (!response.ok) throw new Error('AI 本地授权或分析失败（HTTP ' + response.status + '）');
  return await response.json() as T;
}

function fromDate(days: number): number {
  return Math.floor(Date.now() / 1000) - days * 86400;
}

/** Provider authentication is handled by the encrypted Windows sidecar, never this React UI. */
export function AiCard({ sessionId, sessionName }: { sessionId: string; sessionName: string }) {
  const [paired, setPaired] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [serviceReady, setServiceReady] = useState(false);
  const [model, setModel] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [connected, setConnected] = useState(false);
  const [days, setDays] = useState(30);
  const [question, setQuestion] = useState('');
  const [includeExcerpt, setIncludeExcerpt] = useState(false);
  const [turns, setTurns] = useState<AiTurn[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [epoch, setEpoch] = useState(0);
  const activeRequest = useRef<AbortController | null>(null);
  const threadEnd = useRef<HTMLDivElement | null>(null);
  const currentSession = useRef(sessionId);
  const turnCounter = useRef(0);

  useEffect(() => {
    currentSession.current = sessionId;
    activeRequest.current?.abort();
    setTurns([]);
    setQuestion('');
    setIncludeExcerpt(false);
    setError('');
    setBusy(false);
    return () => { activeRequest.current?.abort(); };
  }, [sessionId]);

  useEffect(() => {
    threadEnd.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [turns, busy, expanded]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

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
      setExpiresAt(null); setIncludeExcerpt(false);
      setTurns([]);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '断开连接失败。');
    } finally { setAuthBusy(false); }
  };

  const ask = async () => {
    const text = question.trim();
    if (!sessionId || !connected || !text || busy || !model) return;
    if (text.length > MAX_QUESTION) { setError('问题文字过长。'); return; }
    const requestSession = sessionId;
    const userTurn: AiTurn = {
      id: 'user-' + (++turnCounter.current),
      role: 'user',
      text,
      time: Date.now(),
      model,
    };
    const history = turns;
    setBusy(true); setError(''); setQuestion('');
    setTurns(previous => [...previous, userTurn].slice(-MAX_VISIBLE_TURNS));
    const controller = new AbortController();
    activeRequest.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 135_000);
    try {
      let excerpt: string | undefined;
      let citations: AiTurn['citations'];
      let truncated = false;
      if (includeExcerpt) {
        // Explicitly requested current-session text only; no other contacts or media.
        const messages = await getMessages(requestSession, null, controller.signal, 200);
        const result = prepareAiExcerpt({
          sessionId: requestSession,
          messages: messages.filter(item => item.localType === 1),
          start: fromDate(days), end: Math.floor(Date.now() / 1000),
          maxMessages: 80, maxCharacters: 12_000,
        });
        if (!result.citations.length) throw new Error('选定时间内最近的记录没有可分析的文本消息。');
        excerpt = result.prompt;
        citations = result.citations;
        truncated = result.truncated || messages.length >= 200;
      }
      const prompt = buildAiPrompt(text, history, excerpt);
      const data = await bridgeRequest<{ text: string }>('/complete', controller.signal, { model, prompt });
      if (controller.signal.aborted || currentSession.current !== requestSession) return;
      const assistantTurn: AiTurn = {
        id: 'assistant-' + (++turnCounter.current),
        role: 'assistant',
        text: data.text || '模型返回了空白内容。',
        model,
        time: Date.now(),
        citations,
        truncated,
      };
      setTurns(previous => [...previous, assistantTurn].slice(-MAX_VISIBLE_TURNS));
    } catch (problem) {
      if (!controller.signal.aborted && currentSession.current === requestSession) {
        setError(problem instanceof Error ? problem.message : 'AI 分析失败，请检查本地桥接程序。');
        // Keep the failed question editable and remove it from submitted history.
        setQuestion(text);
        setTurns(previous => previous.filter(turn => turn.id !== userTurn.id));
      }
    } finally {
      window.clearTimeout(timeout);
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  };

  const stop = () => activeRequest.current?.abort();

  const clear = () => {
    if (busy) return;
    setTurns([]); setError('');
  };

  const transcript = <div className="ai-thread" aria-label="AI 对话记录" aria-live="polite">
    {!turns.length && <div className="ai-thread-empty">
      <strong>可以直接开始提问</strong>
      <p>连续追问会保留当前 AI 对话上下文。勾选下方选项后，才会附带这个微信会话的部分文字记录。</p>
    </div>}
    {turns.map(turn => <article className={'ai-turn ai-turn-' + turn.role} key={turn.id}>
      <div className="ai-turn-heading">{turn.role === 'user' ? '你' : 'AI 助手'}
        {turn.model && turn.role === 'assistant' && <span> · {models.find(item => item.slug === turn.model)?.displayName ?? turn.model}</span>}
      </div>
      <div className="ai-turn-body">{turn.text}</div>
      {turn.truncated && <p className="ai-turn-note">本次只分析了部分微信聊天记录，并非完整历史。</p>}
      {turn.citations && turn.citations.length > 0 && <details className="ai-turn-citations">
        <summary>本轮微信引用范围（{turn.citations.length} 条）</summary>
        <p>引用格式：[消息ID@Unix时间戳]。请人工核对模型引用。</p>
        {turn.citations.map(item => <p key={item.localId + ':' + item.createTime}>
          [{item.localId}@{item.createTime}] {new Date(item.createTime * 1000).toLocaleString()} · {item.sender}
        </p>)}
      </details>}
    </article>)}
    {busy && <p className="ai-thread-working" role="status">AI 正在生成回答…</p>}
    <div ref={threadEnd} />
  </div>;

  const composer = <div className="ai-composer">
    <label className="field-label" htmlFor="ai-question">向 AI 提问或连续追问</label>
    <textarea id="ai-question" rows={3} maxLength={MAX_QUESTION} value={question}
      placeholder="直接提问；Enter 发送，Shift+Enter 换行"
      onChange={e => setQuestion(e.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void ask();
        }
      }} />
    <label className="ai-context-option"><input type="checkbox" checked={includeExcerpt}
      onChange={e => setIncludeExcerpt(e.target.checked)} />
      <span>本轮附带当前微信聊天片段（需要发送至 ChatGPT 云端）</span></label>
    {includeExcerpt && <div className="form-row">
      <label className="field-label" htmlFor="ai-days">聊天范围</label>
      <select id="ai-days" value={days} onChange={e => setDays(Number(e.target.value))}>
        <option value={7}>最近 7 天</option><option value={30}>最近 30 天</option>
        <option value={90}>最近 90 天</option><option value={365}>最近一年</option>
      </select>
      <p className="card-note">只读取本会话最近 200 条记录，最多附带 80 条文字、12,000 字，不包括媒体和其他会话。</p>
    </div>}
    <div className="ai-composer-actions">
      {busy ? <button type="button" className="secondary-button" onClick={stop}>停止生成</button>
        : <button type="button" className="primary-button" onClick={() => void ask()}
          disabled={!connected || !model || !question.trim()}>发送给 AI</button>}
      <button type="button" className="secondary-button" onClick={clear} disabled={busy || !turns.length}>清空本次 AI 对话</button>
    </div>
    <p className="ai-privacy-note">AI 对话只在当前页面内存保留，刷新页面会清空。连续追问会把最近的 AI 对话作为上下文发送；不会替你发送微信消息。</p>
  </div>;

  return <div className={'ai-assistant ai-chat-panel' + (expanded ? ' ai-chat-expanded' : '')}
    role={expanded ? 'dialog' : undefined} aria-modal={expanded ? true : undefined}
    aria-label={expanded ? 'WeFlow AI 对话窗口' : undefined}>
    <div className="ai-chat-heading">
      <p className="card-lead">AI 助手 · {sessionName}</p>
      <button type="button" className="secondary-button" onClick={() => setExpanded(value => !value)}>
        {expanded ? '收起窗口' : '展开聊天'}
      </button>
    </div>
    <div className="form-row">
      <label className="field-label" htmlFor="ai-provider">订阅提供商</label>
      <select id="ai-provider" defaultValue="chatgpt" aria-label="订阅提供商">
        {PROVIDERS.map(provider => <option value={provider.id} key={provider.id} disabled={provider.status !== 'available'}>
          {provider.title}{provider.status === 'available' ? ' · 已支持' : ' · 暂未支持'}
        </option>)}
      </select>
    </div>
    {!serviceReady && <p className="card-note">AI 本地后台未连接。请启动 tools/ai-bridge 目录中的 npm start。</p>}
    {serviceReady && !paired && <button type="button" className="secondary-button"
      disabled={authBusy} onClick={() => void pair()}>启用本机 AI 登录（最长保留 90 天）</button>}
    {serviceReady && paired && !connected && <>
      <p className="card-note">本机已配对，请先通过 OpenAI 官方授权页面登录。</p>
      <button type="button" className="primary-button" disabled={authBusy}
        onClick={() => void signIn()}>{authBusy ? '等待授权…' : '使用 ChatGPT 登录'}</button>
    </>}
    {connected && <>
      <div className="ai-chat-connection">
        <span role="status">ChatGPT 已连接 #{epoch}</span>
        <button type="button" className="secondary-button" disabled={authBusy || busy}
          onClick={() => void disconnect()}>断开账户</button>
      </div>
      {expiresAt && <p className="card-note">本机配对有效至 {new Date(expiresAt).toLocaleDateString()}；云端授权可能提前失效。</p>}
      <div className="form-row">
        <label className="field-label" htmlFor="ai-model">模型</label>
        <select id="ai-model" value={model} disabled={busy} onChange={e => setModel(e.target.value)}>
          {models.map(item => <option key={item.slug} value={item.slug}>{item.displayName}</option>)}
        </select>
      </div>
      {transcript}
      {composer}
    </>}
    {error && <p role="alert" className="ai-chat-error">{error}</p>}
  </div>;
}
