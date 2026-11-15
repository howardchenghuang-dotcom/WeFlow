import { useEffect, useRef, useState } from 'react';
import { getMessages, type PageFrom, type ParsedMessage } from '../api/messages';
import { t } from '../i18n';
import { BridgeError, bridgeComplete, bridgeRequest } from './bridge';
import { buildAiMessages, MAX_QUESTION, MAX_VISIBLE_TURNS, type AiTurn } from './chatHistory';
import { prepareAiExcerpt } from './context';
import { Markdown } from './Markdown';
import { PROVIDERS } from './providers';
import './ai-chat.css';

export { BridgeError } from './bridge';

const PAGE = 200;
const MAX_PAGES = 3;
const SIZES = [30, 80, 150] as const;
const TIMEOUT_MS = 135_000;

type Model = { slug: string; displayName: string };
type CloudState = { paired: boolean; expiresAt?: number; status?: string; sharing?: boolean };
/** `checking` until the bridge has answered once; `elsewhere` when the page is not the one the bridge pairs with. */
type Service = 'checking' | 'ready' | 'offline' | 'elsewhere';

/**
 * The newest text messages of a conversation: pages of 200 are read, newest first, until `want` of them are text
 * or three pages are read. `more` says older messages were left unread.
 */
async function recentTexts(sessionId: string, want: number, signal: AbortSignal) {
  const texts: ParsedMessage[] = [];
  let from: PageFrom = null;
  let more = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await getMessages(sessionId, from, signal, PAGE);
    texts.push(...batch.filter(item => item.localType === 1));
    more = batch.length >= PAGE;
    if (!more || texts.length >= want) break;
    const oldest = batch.reduce((a, b) => (b.createTime < a.createTime || (b.createTime === a.createTime && b.localId < a.localId) ? b : a));
    from = { before: oldest._cursor };
  }
  return { texts, more };
}

/** `Me`, `Other` and `Member 3` of an excerpt, in the page's language. */
function speaker(sender: string): string {
  if (sender === 'Me') return t('我');
  if (sender === 'Other') return t('对方');
  const member = /^Member (\d+)$/.exec(sender);
  return member ? t('成员 {n}', { n: member[1] }) : sender;
}

/** Provider authentication is handled by the encrypted Windows sidecar, never this React UI. */
export function AiCard({ sessionId, sessionName }: { sessionId: string; sessionName: string }) {
  const [service, setService] = useState<Service>('checking');
  const [paired, setPaired] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [model, setModel] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [connected, setConnected] = useState(false);
  const [size, setSize] = useState<number>(80);
  const [question, setQuestion] = useState('');
  const [includeExcerpt, setIncludeExcerpt] = useState(false);
  const [turns, setTurns] = useState<AiTurn[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const activeRequest = useRef<AbortController | null>(null);
  const thread = useRef<HTMLDivElement | null>(null);
  const composerBox = useRef<HTMLTextAreaElement | null>(null);
  // the thread follows the answer as it is written, unless the reader has scrolled up to read
  const following = useRef(true);
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
    following.current = true;
    return () => { activeRequest.current?.abort(); };
  }, [sessionId]);

  useEffect(() => {
    const box = thread.current;
    if (box && following.current) box.scrollTop = box.scrollHeight;
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
    setService('ready');
    if (!session.paired || session.status !== 'connected' || !session.sharing) {
      setConnected(false);
      setModels([]);
      return;
    }
    const result = await bridgeRequest<{ models: Model[] }>('/models', signal);
    if (!result.models.length) throw new Error(t('当前订阅未返回可用模型。'));
    setModels(result.models);
    setModel(previous => result.models.some(item => item.slug === previous) ? previous : result.models[0].slug);
    setConnected(true);
  };

  const check = (signal: AbortSignal) => {
    if (window.location.hostname !== '127.0.0.1' || window.location.port !== '18110') {
      setService('elsewhere');
      return;
    }
    setError('');
    void refreshSession(signal).catch(problem => {
      if (signal.aborted) return;
      // no answer at all is the bridge not running; an answer that is a refusal is said as it is
      if (problem instanceof Error && !(problem instanceof TypeError)) setError(problem.message);
      setService(current => (current === 'checking' ? 'offline' : current));
    });
  };

  // once, when the card opens: the reader asks again with the button
  useEffect(() => {
    const controller = new AbortController();
    check(controller.signal);
    return () => controller.abort();
  }, []);

  const authorize = async (path: '/pair' | '/sign-in', fallback: string) => {
    setAuthBusy(true); setError('');
    const controller = new AbortController();
    try {
      await bridgeRequest(path, controller.signal, {});
      await refreshSession(controller.signal);
    } catch (problem) {
      if (problem instanceof TypeError) setService('offline');
      else setError(problem instanceof Error ? problem.message : fallback);
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
      setError(problem instanceof Error ? problem.message : t('断开连接失败。'));
    } finally { setAuthBusy(false); }
  };

  const ask = async () => {
    const text = question.trim();
    if (!sessionId || !connected || !text || busy || !model) return;
    if (text.length > MAX_QUESTION) { setError(t('问题文字过长。')); return; }
    const requestSession = sessionId;
    const started = Date.now();
    const userTurn: AiTurn = { id: 'user-' + (++turnCounter.current), role: 'user', text, time: started, model };
    const answerId = 'assistant-' + (++turnCounter.current);
    const history = turns;
    setBusy(true); setError(''); setQuestion('');
    following.current = true;
    setTurns(previous => [...previous, userTurn].slice(-MAX_VISIBLE_TURNS));
    const controller = new AbortController();
    activeRequest.current = controller;
    const timeout = window.setTimeout(() => controller.abort('timeout'), TIMEOUT_MS);
    let answer = '';
    let citations: AiTurn['citations'];
    let truncated = false;
    let redraw = 0;
    const here = () => currentSession.current === requestSession;
    /** Draws the answer so far: the first call adds its turn, later ones replace it. */
    const show = (patch: Partial<AiTurn> = {}) => {
      if (!here()) return;
      setTurns(previous => {
        const turn: AiTurn = { id: answerId, role: 'assistant', text: answer, model, time: started, citations, truncated, ...patch };
        const at = previous.findIndex(old => old.id === answerId);
        return at < 0 ? [...previous, turn].slice(-MAX_VISIBLE_TURNS) : previous.map((old, n) => (n === at ? turn : old));
      });
    };
    try {
      let excerpt: string | undefined;
      if (includeExcerpt) {
        // Explicitly requested current-session text only; no other contacts or media.
        const { texts, more } = await recentTexts(requestSession, size, controller.signal);
        const result = prepareAiExcerpt({
          sessionId: requestSession, messages: texts,
          // every message read counts: a clock a little off must not leave the newest ones out
          start: 0, end: Number.MAX_SAFE_INTEGER,
          maxMessages: size, maxCharacters: size > 80 ? 16_000 : 12_000,
        });
        if (!result.citations.length) throw new Error(t('这个会话最近的记录里没有可以分析的文字消息。'));
        excerpt = result.prompt;
        citations = result.citations;
        truncated = result.truncated || more;
      }
      await bridgeComplete(model, buildAiMessages(text, history, excerpt), controller.signal, piece => {
        answer += piece;
        // pieces come many times a second; the page redraws at most every 60 ms
        if (!redraw) redraw = window.setTimeout(() => { redraw = 0; show(); }, 60);
      });
      if (!here()) return;
      // stopped just as the answer ended: handled below like any other stop
      controller.signal.throwIfAborted();
      show({ text: answer || t('模型返回了空白内容。') });
      // "本轮" means this turn: the next question sends WeChat text only when it is ticked again.
      setIncludeExcerpt(false);
    } catch (problem) {
      // Another conversation was opened meanwhile: its card starts empty, nothing to put back.
      if (!here()) return;
      const reason: unknown = controller.signal.reason;
      if (!controller.signal.aborted) setError(problem instanceof Error ? problem.message : t('AI 分析失败，请检查本地桥接程序。'));
      else if (reason === 'timeout') setError(t('等待 AI 回答超过 135 秒，已停止。可以少附带一些聊天记录后重试。'));
      else if (reason !== 'stop') return;
      if (answer) {
        // what was written so far stays, marked as not the whole answer
        show({ partial: true });
        if (includeExcerpt) setIncludeExcerpt(false);
      } else {
        // nothing came: the question is editable again and no unanswered turn stays in the history, where the
        // next question would send it along
        setQuestion(current => current || text);
        setTurns(previous => previous.filter(turn => turn.id !== userTurn.id));
      }
      if (problem instanceof BridgeError && (problem.status === 401 || problem.status === 403)) {
        void refreshSession(new AbortController().signal).catch(() => {});
      }
    } finally {
      window.clearTimeout(timeout);
      window.clearTimeout(redraw);
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  };

  const stop = () => activeRequest.current?.abort('stop');

  const clear = () => {
    if (busy) return;
    setTurns([]); setError('');
  };

  const suggest = (text: string) => {
    setQuestion(text);
    // these questions are about the chat: the box is ticked for the reader to see, and nothing is sent until
    // they press the button, which then says what goes with it
    setIncludeExcerpt(true);
    composerBox.current?.focus();
  };

  const copy = async (turn: AiTurn) => {
    try {
      await navigator.clipboard.writeText(turn.text);
      setCopied(turn.id);
      window.setTimeout(() => setCopied(current => (current === turn.id ? '' : current)), 1500);
    } catch {
      setError(t('复制失败，请手动选择文字复制。'));
    }
  };

  const step = service !== 'ready' ? 0 : !paired ? 1 : !connected ? 2 : 3;
  const steps = [t('启动本机 AI 服务'), t('允许这个浏览器使用'), t('登录 ChatGPT')];
  const setup = <div className="ai-setup">
    <ol className="ai-steps" aria-label={t('开始使用 AI 助手的步骤')}>
      {steps.map((label, n) => <li key={label} data-state={n < step ? 'done' : n === step ? 'current' : 'todo'}
        aria-current={n === step ? 'step' : undefined}><span className="ai-step-mark" aria-hidden="true">{n < step ? '✓' : n + 1}</span>{label}</li>)}
    </ol>
    {service === 'checking' && <p className="card-note" role="status">{t('正在连接本机 AI 服务…')}</p>}
    {service === 'elsewhere' && <p className="card-note">{t('AI 助手只在 http://127.0.0.1:18110/ui/ 这个地址可用。请双击桌面上的「WeFlow AI」快捷方式打开。')}</p>}
    {service === 'offline' && <>
      <p className="card-note">{t('没有连上本机 AI 服务。请双击桌面上的「WeFlow AI」快捷方式，等几秒后点击重试。')}</p>
      <button type="button" className="secondary-button" onClick={() => { setService('checking'); check(new AbortController().signal); }}>{t('重试')}</button>
    </>}
    {step === 1 && <>
      <button type="button" className="primary-button" disabled={authBusy}
        onClick={() => void authorize('/pair', t('本机配对失败。'))}>{authBusy ? t('等待你在「WeFlow AI」窗口中确认…') : t('允许这个浏览器使用')}</button>
      <p className="card-note">{t('点击后，屏幕上会弹出一个「WeFlow AI」小窗口，请选择「允许」。配对在这个浏览器里保留 90 天。')}</p>
    </>}
    {step === 2 && <>
      <button type="button" className="primary-button" disabled={authBusy}
        onClick={() => void authorize('/sign-in', t('ChatGPT 登录失败，请确认授权窗口。'))}>{authBusy ? t('等待你在浏览器中完成登录…') : t('使用 ChatGPT 登录')}</button>
      <p className="card-note">{t('会在新标签页打开 OpenAI 官方登录页。密码只输入在 OpenAI 的页面里，WeFlow 看不到。')}</p>
    </>}
  </div>;

  const transcript = <div className="ai-thread" ref={thread} aria-label={t('AI 对话记录')} aria-live="polite"
    onScroll={event => {
      const box = event.currentTarget;
      following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    }}>
    {!turns.length && <div className="ai-thread-empty">
      <strong>{t('想了解这段聊天的什么？')}</strong>
      <p>{t('可以直接提问，也可以点一个常用问题。下面这些问题会附带这个会话最近的文字记录，发送前可以取消。')}</p>
      <div className="ai-suggestions">
        {[t('总结最近聊了什么'), t('列出提到的待办事项和时间'), t('对方最近最关心什么？'), t('帮我想想怎么回复最后一条消息')].map(text =>
          <button type="button" className="chip" key={text} onClick={() => suggest(text)}>{text}</button>)}
      </div>
    </div>}
    {turns.map(turn => <article className={'ai-turn ai-turn-' + turn.role} key={turn.id}>
      <div className="ai-turn-heading">{turn.role === 'user' ? t('你') : t('AI 助手')}
        {turn.model && turn.role === 'assistant' && <span> · {models.find(item => item.slug === turn.model)?.displayName ?? turn.model}</span>}
      </div>
      <div className="ai-turn-body">{turn.role === 'assistant' ? <Markdown text={turn.text} /> : turn.text}</div>
      {turn.partial && <p className="ai-turn-note">{t('回答没有写完（已停止或中断）。')}</p>}
      {turn.truncated && <p className="ai-turn-note">{t('本次只分析了部分微信聊天记录，并非完整历史。')}</p>}
      {turn.citations && turn.citations.length > 0 && <details className="ai-turn-citations">
        <summary>{t('本轮附带的微信消息（{n} 条）', { n: turn.citations.length })}</summary>
        <p>{t('回答里的 [消息编号@时间] 指向下面的消息，请对照原文核实。')}</p>
        {turn.citations.map(item => <p key={item.localId + ':' + item.createTime}>
          [{item.localId}@{item.createTime}] {new Date(item.createTime * 1000).toLocaleString()} · {speaker(item.sender)}
        </p>)}
      </details>}
      {turn.role === 'assistant' && turn.text && !(busy && turn === turns[turns.length - 1]) && <div className="ai-turn-actions">
        <button type="button" className="ai-turn-copy" onClick={() => void copy(turn)}>{copied === turn.id ? t('已复制') : t('复制回答')}</button>
      </div>}
    </article>)}
    {busy && turns[turns.length - 1]?.role !== 'assistant' && <p className="ai-thread-working" role="status">
      <span className="ai-dots" aria-hidden="true"><i /><i /><i /></span>{includeExcerpt ? t('正在读取聊天记录并等待 AI 回答…') : t('AI 正在思考…')}</p>}
  </div>;

  const composer = <div className="ai-composer">
    <label className="field-label" htmlFor="ai-question">{t('向 AI 提问')}</label>
    <textarea id="ai-question" ref={composerBox} rows={3} maxLength={MAX_QUESTION} value={question}
      placeholder={t('输入问题；Enter 发送，Shift+Enter 换行')}
      onChange={e => setQuestion(e.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void ask();
        }
      }} />
    <div className="ai-composer-meta">
      <label className="ai-context-option"><input type="checkbox" checked={includeExcerpt}
        onChange={e => setIncludeExcerpt(e.target.checked)} />
        <span>{t('本轮附带这个会话的微信聊天片段（会发送到 ChatGPT 云端）')}</span></label>
      <span className="ai-count" aria-hidden="true">{question.length}/{MAX_QUESTION}</span>
    </div>
    {includeExcerpt && <div className="ai-excerpt-size">
      <label className="field-label" htmlFor="ai-size">{t('附带多少')}</label>
      <select id="ai-size" value={size} onChange={e => setSize(Number(e.target.value))}>
        {SIZES.map(n => <option value={n} key={n}>{t('最近 {n} 条文字消息', { n })}</option>)}
      </select>
      <p className="card-note">{t('只包含这个会话的文字，不包含图片、语音、文件和其他会话；对方的微信号不会发送。')}</p>
    </div>}
    <div className="ai-composer-actions">
      {busy ? <button type="button" className="secondary-button" onClick={stop}>{t('停止生成')}</button>
        : <button type="button" className="primary-button" onClick={() => void ask()}
          disabled={!question.trim()}>{includeExcerpt ? t('发送（附带微信片段）') : t('发送')}</button>}
      <button type="button" className="secondary-button" onClick={clear} disabled={busy || !turns.length}>{t('清空对话')}</button>
    </div>
    <p className="ai-privacy-note">{t('对话只保存在这个页面里，刷新就会清空。追问时会把前面的问答一起发给 ChatGPT，其中可能含有 AI 引用过的聊天内容；微信聊天片段只随勾选的那一轮发送。AI 不会替你发送微信消息。')}</p>
  </div>;

  const others = PROVIDERS.filter(provider => provider.status !== 'available');
  return <>
    {expanded && <div className="ai-chat-backdrop" onClick={() => setExpanded(false)} />}
    <div className={'ai-assistant ai-chat-panel' + (expanded ? ' ai-chat-expanded' : '')}
      role={expanded ? 'dialog' : undefined} aria-modal={expanded ? true : undefined}
      aria-label={expanded ? t('WeFlow AI 对话窗口') : undefined}>
      <div className="ai-chat-heading">
        <p className="card-lead">{t('AI 助手')} · {sessionName}</p>
        {connected && <button type="button" className="secondary-button" onClick={() => setExpanded(value => !value)}>
          {expanded ? t('收起') : t('放大窗口')}
        </button>}
      </div>
      {!connected && setup}
      {connected && <>
        <div className="ai-chat-connection">
          <span className="ai-connected" role="status">{t('ChatGPT 已连接')}</span>
          <label className="ai-model"><span className="field-label">{t('模型')}</span>
            <select value={model} disabled={busy} onChange={e => setModel(e.target.value)}>
              {models.map(item => <option key={item.slug} value={item.slug}>{item.displayName}</option>)}
            </select></label>
        </div>
        {transcript}
        {composer}
        <details className="ai-about">
          <summary>{t('连接与订阅说明')}</summary>
          {expiresAt && <p>{t('这个浏览器的本机配对有效至 {date}。ChatGPT 的登录由 OpenAI 决定，可能更早要求重新登录。', { date: new Date(expiresAt).toLocaleDateString() })}</p>}
          <p>{t('目前只支持 ChatGPT 订阅，不使用按量计费的 API。其他订阅暂时不能接入：')}</p>
          <ul>{others.map(provider => <li key={provider.id}><strong>{provider.title}</strong>：{t(provider.reason)}</li>)}</ul>
          <button type="button" className="secondary-button" disabled={authBusy || busy}
            onClick={() => void disconnect()}>{t('断开 ChatGPT 账户')}</button>
        </details>
      </>}
      {error && <p role="alert" className="ai-chat-error">{error}</p>}
    </div>
  </>;
}
