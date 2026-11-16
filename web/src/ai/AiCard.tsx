import { useEffect, useRef, useState } from 'react';
import { getDateCounts } from '../api/messages';
import { t } from '../i18n';
import { BridgeError, bridgeComplete, bridgeRequest } from './bridge';
import { buildAiMessages, MAX_QUESTION, MAX_VISIBLE_TURNS, type AiTurn } from './chatHistory';
import { collectKeyword, collectRange, collectRecent, MAX_ATTACHED, type Collected } from './collect';
import { prepareAiExcerpt } from './context';
import { Markdown } from './Markdown';
import { dayEnd, dayOf, dayStart, parsePlan, planRequest, type Plan } from './plan';
import { PROVIDERS } from './providers';
import './ai-chat.css';

export { BridgeError } from './bridge';

const SIZES = [30, 80, 150] as const;
const TIMEOUT_MS = 135_000;

type Model = { slug: string; displayName: string };
type CloudState = { paired: boolean; expiresAt?: number; status?: string; sharing?: boolean };
/** `checking` until the bridge has answered once; `elsewhere` when the page is not the one the bridge pairs with. */
type Service = 'checking' | 'ready' | 'offline' | 'elsewhere';
/** How the messages that go with a question are chosen: by the question itself, the latest ones, or as filled in. */
type Mode = 'auto' | 'recent' | 'pick';
/** What a request is doing, for the line the reader sees while waiting. */
type Stage = '' | 'planning' | 'reading' | 'answering';
/** The first and the last day a conversation has messages on (`YYYY-MM-DD`). */
type Span = { first: string; last: string };

/** How many messages (of any kind) each day has. */
type Counts = Record<string, number>;
/** Where a period that did not fit in one turn goes on: from this second (included) to its end. */
type Rest = NonNullable<AiTurn['rest']>;

function spanOf(counts: Counts): Span | null {
  const days = Object.keys(counts).filter(day => dayStart(day) !== null).sort();
  return days.length ? { first: days[0], last: days[days.length - 1] } : null;
}

async function daySpan(sessionId: string, signal: AbortSignal): Promise<Span | null> {
  return spanOf(await getDateCounts(sessionId, signal));
}

/** A moment as the reader's computer writes dates and times, to the minute. */
const moment = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const day = (seconds: number) => dayOf(new Date(seconds * 1000));

/**
 * Reads what a plan asks for from the local backend: the messages holding a keyword, those of a period, or the
 * latest ones. `notes` tell the model how they were chosen, `describe` tells the reader. When the question itself
 * chose (`fallback`) and nothing is there, the latest messages are read instead and both are told so; a reader
 * who filled the fields in is told nothing was found.
 */
async function gather(sessionId: string, plan: Plan, size: number, fallback: boolean, signal: AbortSignal): Promise<{
  collected: Collected; limit: number; keep: 'newest' | 'oldest'; notes: string[]; chosen: boolean; describe: (count: number) => string;
}> {
  const period = plan.start !== undefined && plan.end !== undefined;
  const [from, to] = period ? [plan.start ? day(plan.start) : '', day(plan.end!)] : ['', ''];
  const dates = !period ? '' : from ? t('{from} 至 {to}', { from, to }) : t('{to} 及之前', { to });
  const span = !period ? '' : `sent ${from ? 'from ' + from + ' ' : ''}up to ${to} (local dates)`;
  const word = plan.keyword?.replace(/"/g, "'") ?? '';
  let nothing = '';
  if (word) {
    const collected = await collectKeyword(sessionId, word, plan.start ?? 0, plan.end ?? 0, signal);
    if (collected.texts.length) {
      return {
        collected, limit: MAX_ATTACHED, keep: 'newest', chosen: true,
        notes: [`These are the messages that contain "${word}"${period ? ' and were ' + span : ''} (the newest matches when there are many), each with up to two messages before and after it. Messages between these groups are left out.`],
        describe: count => (period ? t('{dates}含「{keyword}」的消息及其前后文，共 {n} 条', { dates, keyword: word, n: count }) : t('含「{keyword}」的消息及其前后文，共 {n} 条', { keyword: word, n: count })),
      };
    }
    nothing = period ? t('{dates}没有找到含「{keyword}」的文字消息', { dates, keyword: word }) : t('没有找到含「{keyword}」的文字消息', { keyword: word });
  } else if (period) {
    const collected = await collectRange(sessionId, plan.start!, plan.end!, MAX_ATTACHED, signal);
    if (collected.texts.length) {
      return {
        collected, limit: MAX_ATTACHED, keep: 'oldest', chosen: true,
        notes: [`These are the messages ${span}, read from the beginning of that period.`],
        describe: count => t('{dates}的消息，共 {n} 条', { dates, n: count }),
      };
    }
    nothing = t('{dates}没有文字消息', { dates });
  }
  if (nothing && !fallback) throw new Error(nothing);
  const collected = await collectRecent(sessionId, size, signal);
  return {
    collected, limit: size, keep: 'newest', chosen: false,
    notes: nothing ? ['Nothing was found for the period or keyword the question pointed to, so these are the latest messages of the conversation instead. Say so in your answer.'] : [],
    describe: count => (nothing ? t('{nothing}，改为最近的 {n} 条文字消息', { nothing, n: count }) : t('最近的 {n} 条文字消息', { n: count })),
  };
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
  const [mode, setMode] = useState<Mode>('auto');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [keyword, setKeyword] = useState('');
  const [span, setSpan] = useState<Span | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  // set by "接着读后面的": the next turn reads on from there, whatever the menu says
  const [resume, setResume] = useState<Rest | null>(null);
  const [stage, setStage] = useState<Stage>('');
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
    setFromDay(''); setToDay(''); setKeyword('');
    setSpan(null);
    setCounts(null);
    setResume(null);
    setStage('');
    setError('');
    setBusy(false);
    following.current = true;
    return () => { activeRequest.current?.abort(); };
  }, [sessionId]);

  // The days this conversation has messages on: asked for once the reader means to attach some, to bound the
  // date fields and to tell the planner. Read from the local backend; nothing of it is sent before a question is.
  useEffect(() => {
    if (!includeExcerpt || counts) return;
    const controller = new AbortController();
    void getDateCounts(sessionId, controller.signal).then(found => {
      if (controller.signal.aborted) return;
      setCounts(found);
      setSpan(spanOf(found));
    }, () => {});
    return () => controller.abort();
  }, [includeExcerpt, sessionId, counts]);

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
    let picked: Plan = {};
    const going = includeExcerpt ? resume : null;
    if (going) picked = { start: going.start, end: going.end };
    else if (includeExcerpt && mode === 'pick') {
      const word = keyword.replace(/\s+/g, ' ').trim();
      const start = fromDay ? dayStart(fromDay) : null;
      const end = toDay ? dayEnd(toDay) : null;
      if ((fromDay && start === null) || (toDay && end === null)) { setError(t('日期填写不完整。')); return; }
      if (start !== null && end !== null && start > end) { setError(t('开始日期晚于结束日期。')); return; }
      if (!word && start === null && end === null) { setError(t('请填写日期或关键词，或者改用「最近的消息」。')); return; }
      if (start !== null || end !== null) picked = { start: start ?? 0, end: end ?? Math.floor(Date.now() / 1000) };
      if (word) picked.keyword = word;
    }
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
    let scope: string | undefined;
    let rest: AiTurn['rest'];
    let redraw = 0;
    const here = () => currentSession.current === requestSession;
    /** Draws the answer so far: the first call adds its turn, later ones replace it. */
    const show = (patch: Partial<AiTurn> = {}) => {
      if (!here()) return;
      setTurns(previous => {
        const turn: AiTurn = { id: answerId, role: 'assistant', text: answer, model, time: started, citations, truncated, scope, rest, ...patch };
        const at = previous.findIndex(old => old.id === answerId);
        return at < 0 ? [...previous, turn].slice(-MAX_VISIBLE_TURNS) : previous.map((old, n) => (n === at ? turn : old));
      });
    };
    try {
      let excerpt: string | undefined;
      if (includeExcerpt) {
        // Explicitly requested current-session text only; no other contacts or media.
        let plan = picked;
        if (mode === 'auto' && !going) {
          // First the model is asked where to read. This request holds the question and the earlier AI turns,
          // no chat message; its answer is a period and/or a keyword, checked by parsePlan.
          setStage('planning');
          const known = span ?? await daySpan(requestSession, controller.signal).catch(() => null);
          const planning = buildAiMessages(text, history);
          planning[planning.length - 1] = { role: 'user', content: planRequest(text, new Date(), known?.first, known?.last) };
          let reply = '';
          await bridgeComplete(model, planning, controller.signal, piece => { reply += piece; }, 'plan');
          plan = parsePlan(reply);
        }
        setStage('reading');
        const read = await gather(requestSession, plan, mode === 'recent' && !going ? size : MAX_ATTACHED, mode === 'auto' && !going, controller.signal);
        const result = prepareAiExcerpt({
          sessionId: requestSession, messages: read.collected.texts,
          // every message read counts: a clock a little off must not leave the newest ones out
          start: 0, end: Number.MAX_SAFE_INTEGER,
          maxMessages: read.limit, maxCharacters: read.limit > 80 ? 16_000 : 12_000,
          keep: read.keep, notes: read.notes, partial: read.chosen ? read.collected.more : undefined,
        });
        if (!result.citations.length) throw new Error(t('这个会话最近的记录里没有可以分析的文字消息。'));
        excerpt = result.prompt;
        citations = result.citations;
        truncated = result.truncated || read.collected.more;
        scope = read.describe(result.citations.length);
        // A period that holds more than fit was read from its beginning: where it stopped is kept, so that the
        // reader can go on from there. The last message read is read again, so that none sent in the same second
        // is skipped.
        if (read.keep === 'oldest' && plan.end !== undefined && (result.truncated || read.collected.more)) {
          rest = { start: result.citations[result.citations.length - 1].createTime, end: plan.end };
        }
      }
      setStage('answering');
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
      setResume(null);
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
        if (includeExcerpt) { setIncludeExcerpt(false); setResume(null); }
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
        setStage('');
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

  /** Ticks WeChat text for the next turn, to read on from where a period was cut off. Nothing is sent yet. */
  const continueFrom = (from: Rest) => {
    setResume(from);
    setIncludeExcerpt(true);
    setQuestion(current => current || t('接着上面的分析，继续看后面的消息。'));
    composerBox.current?.focus();
  };

  // how many messages the chosen days hold, for the reader to see before sending
  const inRange = mode === 'pick' && counts && (fromDay || toDay) && !keyword.trim()
    ? Object.entries(counts).reduce((sum, [date, count]) => ((!fromDay || date >= fromDay) && (!toDay || date <= toDay) ? sum + count : sum), 0)
    : null;

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
      {turn.scope && <p className="ai-turn-note ai-turn-scope">{t('本轮读取：{scope}', { scope: turn.scope })}</p>}
      {turn.rest && <div className="ai-turn-rest" role="note">
        <p>{t('这段时间的消息超过了每轮 150 条的上限，这次只读到 {time}。', { time: moment(turn.rest.start) })}</p>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => continueFrom(turn.rest!)}>{t('接着读后面的')}</button>
      </div>}
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
      <span className="ai-dots" aria-hidden="true"><i /><i /><i /></span>{stage === 'planning' ? t('正在根据问题判断要读哪一段聊天记录…') : stage === 'reading' ? t('正在读取聊天记录…') : t('AI 正在思考…')}</p>}
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
        onChange={e => { setIncludeExcerpt(e.target.checked); if (!e.target.checked) setResume(null); }} />
        <span>{t('本轮附带这个会话的微信聊天片段（会发送到 ChatGPT 云端）')}</span></label>
      <span className="ai-count" aria-hidden="true">{question.length}/{MAX_QUESTION}</span>
    </div>
    {includeExcerpt && resume && <div className="ai-excerpt-size">
      <p className="card-note ai-resume" role="status">{t('这一轮会从 {time} 接着往后读，最多 150 条文字消息。', { time: moment(resume.start) })}</p>
      <button type="button" className="secondary-button" onClick={() => setResume(null)}>{t('不接着读，重新选择')}</button>
    </div>}
    {includeExcerpt && !resume && <div className="ai-excerpt-size">
      <label className="field-label" htmlFor="ai-mode">{t('附带哪些')}</label>
      <select id="ai-mode" value={mode} onChange={e => setMode(e.target.value as Mode)}>
        <option value="auto">{t('自动：根据问题决定读哪一段')}</option>
        <option value="recent">{t('最近的消息')}</option>
        <option value="pick">{t('指定日期或关键词')}</option>
      </select>
      {mode === 'recent' && <select id="ai-size" aria-label={t('附带多少')} value={size} onChange={e => setSize(Number(e.target.value))}>
        {SIZES.map(n => <option value={n} key={n}>{t('最近 {n} 条文字消息', { n })}</option>)}
      </select>}
      {mode === 'pick' && <div className="ai-pick">
        <label><span className="field-label">{t('从')}</span>
          <input type="date" value={fromDay} min={span?.first} max={toDay || span?.last} onChange={e => setFromDay(e.target.value)} /></label>
        <label><span className="field-label">{t('到')}</span>
          <input type="date" value={toDay} min={fromDay || span?.first} max={span?.last} onChange={e => setToDay(e.target.value)} /></label>
        <label><span className="field-label">{t('关键词')}</span>
          <input type="text" value={keyword} maxLength={40} placeholder={t('可不填')} onChange={e => setKeyword(e.target.value)} /></label>
      </div>}
      {mode === 'auto' && <p className="card-note">{t('直接在问题里说时间或话题就行，例如「上周聊了什么」「他是怎么说合同的」。会先多用一次模型请求来判断读哪一段，这一步不发送聊天内容。')}</p>}
      {mode === 'pick' && <p className="card-note">{t('日期和关键词可以只填一样。按关键词时，会附带含有它的消息和每条前后各两条。')}{span ? ' ' + t('这个会话的消息从 {first} 到 {last}。', span) : ''}</p>}
      {inRange !== null && <p className={'card-note' + (inRange > MAX_ATTACHED ? ' ai-over' : '')} role="status">{inRange > MAX_ATTACHED
        ? t('这段日期约有 {n} 条消息（含图片等），超过了每轮 150 条文字的上限。AI 会从头读起，并告诉你读到了哪里，之后可以接着读；也可以先把日期缩短。', { n: inRange })
        : t('这段日期约有 {n} 条消息（含图片等）。', { n: inRange })}</p>}
      <p className="card-note">{t('每轮最多附带 150 条文字消息。只包含这个会话的文字，不包含图片、语音、文件和其他会话；对方的微信号不会发送。')}</p>
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
