import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from '#test';
import { AiCard } from './AiCard';

type Message = { role: string; content: string };
type Call = { url: string; method: string; body: { model: string; messages: Message[]; purpose?: string } | null; signal: AbortSignal | null };
type Answer = Response | Promise<Response>;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
/** What the bridge sends for an answer: one JSON object a line. */
const pieces = (...lines: object[]) => new Response(lines.map(line => JSON.stringify(line) + '\n').join(''),
  { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
const answer = (text: string) => pieces({ delta: text }, { done: true });

const now = Math.floor(Date.now() / 1000);
const wechat = [
  { _cursor: 'c1', localId: 11, localType: 1, createTime: now - 120, isSend: 0, senderUsername: 'wxid_a', parsedContent: '周五下午三点开会' },
  { _cursor: 'c2', localId: 12, localType: 1, createTime: now - 60, isSend: 1, senderUsername: 'wxid_me', parsedContent: '好的，我会准时到' },
  { _cursor: 'c3', localId: 13, localType: 3, createTime: now - 30, isSend: 0, senderUsername: 'wxid_a', parsedContent: '[图片]' },
];

let calls: Call[] = [];
let session: () => Answer = () => json({ paired: true, expiresAt: Date.now() + 1000, status: 'connected', sharing: true });
let complete: (call: Call) => Answer = () => answer('回答一');
let messages: (call: Call) => Answer = () => json({ success: true, data: wechat });
// With WeChat text ticked, the card first asks where to read (`purpose: "plan"`). Here that is always answered
// with "the latest messages"; AiCard.modes.test.tsx is about what else it can answer.
const completions = () => calls.filter(call => call.url.endsWith('/ai-auth/complete') && call.body?.purpose !== 'plan');
const messageReads = () => calls.filter(call => call.url.includes('api/chat/messages'));
const last = (call: Call) => call.body!.messages[call.body!.messages.length - 1].content;
const address = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;

beforeEach(() => {
  address.setURL('http://127.0.0.1:18110/ui/');
  calls = [];
  session = () => json({ paired: true, expiresAt: Date.now() + 1000, status: 'connected', sharing: true });
  complete = () => answer('回答一');
  messages = () => json({ success: true, data: wechat });
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null, signal: init?.signal ?? null };
    calls.push(call);
    if (url.endsWith('/ai-auth/session')) return Promise.resolve(session());
    if (url.endsWith('/ai-auth/models')) return Promise.resolve(json({ models: [{ slug: 'm1', displayName: 'Model One' }, { slug: 'm2', displayName: 'Model Two' }] }));
    if (url.endsWith('/ai-auth/complete') && call.body?.purpose === 'plan') return Promise.resolve(answer('{"from":null,"to":null,"keyword":null}'));
    if (url.endsWith('/ai-auth/complete')) return Promise.resolve(complete(call));
    if (url.endsWith('/ai-auth/pair') || url.endsWith('/ai-auth/sign-in')) return Promise.resolve(json({}));
    if (url.includes('api/chat/messages')) return Promise.resolve(messages(call));
    if (url.includes('api/chat/date-counts')) return Promise.resolve(json({ success: true, data: { counts: {} } }));
    return Promise.reject(new Error('unexpected request ' + url));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); address.setURL('http://localhost/'); });

async function open(sessionId = 'wxid_a') {
  const view = render(<AiCard sessionId={sessionId} sessionName="林沐" />);
  const box = await screen.findByLabelText('向 AI 提问') as HTMLTextAreaElement;
  return { view, box };
}
const type = (box: HTMLTextAreaElement, text: string) => fireEvent.change(box, { target: { value: text } });
const enter = (box: HTMLTextAreaElement, init: KeyboardEventInit = {}) => fireEvent.keyDown(box, { key: 'Enter', ...init });
const turnCount = () => document.querySelectorAll('.ai-turn').length;

/** An answer the test writes piece by piece; it breaks off when the page stops waiting, as a real one does. */
function writing() {
  const encoder = new TextEncoder();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const respond = (call: Call) => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    call.signal?.addEventListener('abort', () => { try { stream.error(call.signal?.reason); } catch { /* already closed */ } });
    return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } });
  };
  return {
    respond,
    write: (line: object) => act(async () => { stream.enqueue(encoder.encode(JSON.stringify(line) + '\n')); await Promise.resolve(); }),
    end: () => act(async () => { stream.close(); await Promise.resolve(); }),
  };
}
/** No answer at all until the page gives up. */
const silent = (call: Call) => new Promise<Response>((_, reject) => {
  call.signal?.addEventListener('abort', () => reject(call.signal?.reason));
});

describe('asking', () => {
  it('sends on Enter, not on Shift+Enter nor while an input method composes', async () => {
    const { box } = await open();
    type(box, '你好');
    enter(box, { shiftKey: true });
    enter(box, { isComposing: true });
    expect(completions()).toHaveLength(0);
    enter(box);
    expect(await screen.findByText('回答一')).toBeTruthy();
    expect(completions()).toHaveLength(1);
    expect(completions()[0].body).toEqual({ model: 'm1', messages: [{ role: 'user', content: '你好' }] });
    // no WeChat text was read or sent: the box is not ticked
    expect(messageReads()).toHaveLength(0);
    expect(box.value).toBe('');
  });

  it('sends the earlier turns in their roles with a follow-up, to the model then chosen', async () => {
    const { box } = await open();
    type(box, '第一个问题');
    enter(box);
    await screen.findByText('回答一');
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'm2' } });
    complete = () => answer('回答二');
    type(box, '继续说');
    enter(box);
    await screen.findByText('回答二');
    expect(completions()[1].body).toEqual({ model: 'm2', messages: [
      { role: 'user', content: '第一个问题' },
      { role: 'assistant', content: '回答一' },
      { role: 'user', content: '继续说' },
    ] });
  });

  it('shows the answer as it is written, in Markdown', async () => {
    const slow = writing();
    complete = slow.respond;
    const { box } = await open();
    type(box, '写点东西');
    enter(box);
    await screen.findByRole('button', { name: '停止生成' });
    await slow.write({ delta: '# 标题\n\n第一段' });
    expect(await screen.findByText('第一段')).toBeTruthy();
    expect(screen.getByRole('button', { name: '停止生成' })).toBeTruthy();
    await slow.write({ delta: '，**重点**' });
    await waitFor(() => expect(document.querySelector('.ai-turn-assistant strong')?.textContent).toBe('重点'));
    expect(document.querySelector('.ai-turn-assistant h3')?.textContent).toBe('标题');
    await slow.write({ done: true });
    await slow.end();
    await screen.findByRole('button', { name: '发送' });
    expect(turnCount()).toBe(2);
    expect(screen.queryByText('回答没有写完（已停止或中断）。')).toBeNull();
  });

  it('copies an answer', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { box } = await open();
    type(box, '你好');
    enter(box);
    fireEvent.click(await screen.findByRole('button', { name: '复制回答' }));
    expect(writeText).toHaveBeenCalledWith('回答一');
    expect(await screen.findByRole('button', { name: '已复制' })).toBeTruthy();
  });
});

describe('WeChat text', () => {
  it('is sent only for the turn it is ticked for, and the button says so', async () => {
    const { box } = await open();
    const tick = screen.getByLabelText(/本轮附带这个会话的微信聊天片段/) as HTMLInputElement;
    expect(screen.queryByRole('button', { name: '发送（附带微信片段）' })).toBeNull();
    fireEvent.click(tick);
    type(box, '总结一下');
    fireEvent.click(screen.getByRole('button', { name: '发送（附带微信片段）' }));
    await screen.findByText('回答一');
    const first = last(completions()[0]);
    expect(first).toContain('周五下午三点开会');
    expect(first).toContain('[12@' + (now - 60) + '] Me: 好的，我会准时到');
    expect(first.endsWith('--- CURRENT USER QUESTION ---\n总结一下')).toBe(true);
    // text messages only, and no account identifier of either side
    expect(first).not.toContain('[图片]');
    expect(first).not.toContain('wxid_');
    expect(screen.getByText('本轮附带的微信消息（2 条）')).toBeTruthy();
    await waitFor(() => expect(tick.checked).toBe(false));
    complete = () => answer('回答二');
    type(box, '再问一句');
    enter(box);
    await screen.findByText('回答二');
    expect(messageReads()).toHaveLength(1);
    expect(last(completions()[1])).toBe('再问一句');
  });

  it('is ticked by a suggested question, for the reader to see before anything is sent', async () => {
    const { box } = await open();
    fireEvent.click(screen.getByRole('button', { name: '总结最近聊了什么' }));
    expect(box.value).toBe('总结最近聊了什么');
    expect((screen.getByLabelText(/本轮附带这个会话的微信聊天片段/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: '发送（附带微信片段）' })).toBeTruthy();
    expect(completions()).toHaveLength(0);
    expect(messageReads()).toHaveLength(0);
  });

  it('reads further back when the newest page holds too little text', async () => {
    const media = Array.from({ length: 199 }, (_, n) => ({ _cursor: 'm' + n, localId: 1000 + n, localType: 3, createTime: now - n, isSend: 0, senderUsername: 'wxid_a', parsedContent: '[图片]' }));
    const oldest = { _cursor: 'oldest', localId: 900, localType: 1, createTime: now - 500, isSend: 0, senderUsername: 'wxid_a', parsedContent: '第一页里唯一的文字' };
    const older = [{ _cursor: 'p2', localId: 800, localType: 1, createTime: now - 900, isSend: 1, senderUsername: 'wxid_me', parsedContent: '更早的文字' }];
    messages = call => json({ success: true, data: call.url.includes('before=oldest') ? older : [...media, oldest] });
    const { box } = await open();
    fireEvent.click(screen.getByLabelText(/本轮附带这个会话的微信聊天片段/));
    type(box, '总结');
    enter(box);
    await screen.findByText('回答一');
    expect(messageReads()).toHaveLength(2);
    expect(last(completions()[0])).toContain('更早的文字');
    expect(last(completions()[0])).toContain('第一页里唯一的文字');
  });
});

describe('stopping', () => {
  it('before anything came: gives the question back and leaves no unanswered turn', async () => {
    complete = silent;
    const { box } = await open();
    type(box, '写一篇长文');
    enter(box);
    fireEvent.click(await screen.findByRole('button', { name: '停止生成' }));
    await screen.findByRole('button', { name: '发送' });
    expect(completions()[0].signal?.aborted).toBe(true);
    expect(box.value).toBe('写一篇长文');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(turnCount()).toBe(0);
    complete = () => answer('回答二');
    enter(box);
    await screen.findByText('回答二');
    expect(completions()[1].body?.messages).toHaveLength(1);
  });

  it('half-way: keeps what was written and marks it as not whole', async () => {
    const slow = writing();
    complete = slow.respond;
    const { box } = await open();
    type(box, '写一篇长文');
    enter(box);
    await screen.findByRole('button', { name: '停止生成' });
    await slow.write({ delta: '写到一半' });
    await screen.findByText('写到一半');
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }));
    await screen.findByText('回答没有写完（已停止或中断）。');
    expect(completions()[0].signal?.aborted).toBe(true);
    expect(turnCount()).toBe(2);
    expect(box.value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('in another conversation: starts empty and drops the answer still on its way', async () => {
    const slow = writing();
    complete = slow.respond;
    const { view, box } = await open('wxid_a');
    type(box, '关于甲的问题');
    enter(box);
    await screen.findByRole('button', { name: '停止生成' });
    await slow.write({ delta: '甲的' });
    view.rerender(<AiCard sessionId="wxid_b" sessionName="周远" />);
    expect(completions()[0].signal?.aborted).toBe(true);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    expect(screen.queryByText(/甲的/)).toBeNull();
    expect(screen.queryByText('关于甲的问题')).toBeNull();
    expect(turnCount()).toBe(0);
    complete = () => answer('回答乙');
    type(box, '关于乙的问题');
    enter(box);
    await screen.findByText('回答乙');
    expect(completions()[1].body?.messages).toEqual([{ role: 'user', content: '关于乙的问题' }]);
  });
});

describe('when it fails', () => {
  it('says why the bridge refused', async () => {
    complete = () => json({ error: 'A ChatGPT sharing limit has been reached.', code: 'subscription_sharing_usage_limit_exceeded' }, 429);
    const { box } = await open();
    type(box, '你好');
    enter(box);
    expect((await screen.findByRole('alert')).textContent).toContain('ChatGPT 订阅额度已用完');
    expect(box.value).toBe('你好');
    expect(turnCount()).toBe(0);
  });

  it('keeps the pieces of an answer that broke off, and says so', async () => {
    complete = () => pieces({ delta: '前半段' }, { error: 'The connection was interrupted.', code: 'stream_interrupted' });
    const { box } = await open();
    type(box, '你好');
    enter(box);
    expect((await screen.findByRole('alert')).textContent).toBe('回答中途断开了，可以重试。');
    expect(screen.getByText('前半段')).toBeTruthy();
    expect(screen.getByText('回答没有写完（已停止或中断）。')).toBeTruthy();
  });
});

describe('getting started', () => {
  it('walks through pairing and signing in, one step at a time', async () => {
    let state: object = { paired: false };
    session = () => json(state);
    render(<AiCard sessionId="wxid_a" sessionName="林沐" />);
    const allow = await screen.findByRole('button', { name: '允许这个浏览器使用' });
    expect(document.querySelector('.ai-steps li[aria-current="step"]')?.textContent).toContain('允许这个浏览器使用');
    expect(screen.queryByLabelText('向 AI 提问')).toBeNull();
    state = { paired: true, expiresAt: Date.now() + 1000, status: 'disconnected', sharing: false };
    fireEvent.click(allow);
    const signIn = await screen.findByRole('button', { name: '使用 ChatGPT 登录' });
    expect(calls.some(call => call.url.endsWith('/ai-auth/pair') && call.method === 'POST')).toBe(true);
    state = { paired: true, expiresAt: Date.now() + 1000, status: 'connected', sharing: true };
    fireEvent.click(signIn);
    expect(await screen.findByLabelText('向 AI 提问')).toBeTruthy();
    expect(calls.some(call => call.url.endsWith('/ai-auth/sign-in') && call.method === 'POST')).toBe(true);
    expect(screen.getByText('ChatGPT 已连接')).toBeTruthy();
  });

  it('says how to start the local service when it does not answer, and tries again', async () => {
    session = () => Promise.reject(new TypeError('Failed to fetch'));
    render(<AiCard sessionId="wxid_a" sessionName="林沐" />);
    expect(await screen.findByText(/没有连上本机 AI 服务。请双击桌面上的「WeFlow AI」快捷方式/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    session = () => json({ paired: true, expiresAt: Date.now() + 1000, status: 'connected', sharing: true });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByLabelText('向 AI 提问')).toBeTruthy();
  });

  it('says where the assistant works when the page is opened at another address', async () => {
    address.setURL('http://localhost:18110/ui/');
    render(<AiCard sessionId="wxid_a" sessionName="林沐" />);
    expect(await screen.findByText(/AI 助手只在 http:\/\/127\.0\.0\.1:18110\/ui\/ 这个地址可用/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});
