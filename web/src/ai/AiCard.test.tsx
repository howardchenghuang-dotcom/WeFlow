import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from '#test';
import { AiCard } from './AiCard';

type Call = { url: string; body: { model: string; prompt: string } | null; signal: AbortSignal | null };
type Answer = Response | Promise<Response>;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const now = Math.floor(Date.now() / 1000);
const wechat = [
  { _cursor: 'c1', localId: 11, localType: 1, createTime: now - 120, isSend: 0, parsedContent: '周五下午三点开会' },
  { _cursor: 'c2', localId: 12, localType: 1, createTime: now - 60, isSend: 1, parsedContent: '好的，我会准时到' },
  { _cursor: 'c3', localId: 13, localType: 3, createTime: now - 30, isSend: 0, parsedContent: '[图片]' },
];

let calls: Call[] = [];
let complete: (call: Call) => Answer = () => json({ text: '回答一' });
const completions = () => calls.filter(call => call.url.endsWith('/ai-auth/complete'));
const messageReads = () => calls.filter(call => call.url.includes('api/chat/messages'));
const address = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;

beforeEach(() => {
  address.setURL('http://127.0.0.1:18110/ui/');
  calls = [];
  complete = () => json({ text: '回答一' });
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null, signal: init?.signal ?? null };
    calls.push(call);
    if (url.endsWith('/ai-auth/session')) return Promise.resolve(json({ paired: true, expiresAt: Date.now() + 1000, status: 'connected', sharing: true }));
    if (url.endsWith('/ai-auth/models')) return Promise.resolve(json({ models: [{ slug: 'm1', displayName: 'Model One' }, { slug: 'm2', displayName: 'Model Two' }] }));
    if (url.endsWith('/ai-auth/complete')) return Promise.resolve(complete(call));
    if (url.includes('api/chat/messages')) return Promise.resolve(json({ success: true, data: wechat }));
    return Promise.reject(new Error('unexpected request ' + url));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); address.setURL('http://localhost/'); });

async function open(sessionId = 'wxid_a') {
  const view = render(<AiCard sessionId={sessionId} sessionName="林沐" />);
  const box = await screen.findByLabelText('向 AI 提问或连续追问') as HTMLTextAreaElement;
  return { view, box };
}
const type = (box: HTMLTextAreaElement, text: string) => fireEvent.change(box, { target: { value: text } });
const enter = (box: HTMLTextAreaElement, init: KeyboardEventInit = {}) => fireEvent.keyDown(box, { key: 'Enter', ...init });
/** An answer the test gives when it chooses, refused when the page stops waiting, as fetch does. */
function pending() {
  let give: (response: Response) => void = () => {};
  const answer = (call: Call) => new Promise<Response>((resolve, reject) => {
    give = resolve;
    call.signal?.addEventListener('abort', () => reject(call.signal?.reason));
  });
  return { answer, give: (data: unknown) => give(json(data)) };
}

describe('the AI card', () => {
  it('sends on Enter, not on Shift+Enter nor while an input method composes', async () => {
    const { box } = await open();
    type(box, '你好');
    enter(box, { shiftKey: true });
    enter(box, { isComposing: true });
    expect(completions()).toHaveLength(0);
    enter(box);
    expect(await screen.findByText('回答一')).toBeTruthy();
    expect(completions()).toHaveLength(1);
    expect(completions()[0].body?.model).toBe('m1');
    expect(completions()[0].body?.prompt).toContain('你好');
    // no WeChat text was read or sent: the box is not ticked
    expect(messageReads()).toHaveLength(0);
    expect(completions()[0].body?.prompt).toContain('No new WeChat messages are attached');
    expect(box.value).toBe('');
  });

  it('sends the earlier turns with a follow-up, to the model then chosen', async () => {
    const { box } = await open();
    type(box, '第一个问题');
    enter(box);
    await screen.findByText('回答一');
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'm2' } });
    complete = () => json({ text: '回答二' });
    type(box, '继续说');
    enter(box);
    await screen.findByText('回答二');
    const second = completions()[1].body;
    expect(second?.model).toBe('m2');
    expect(second?.prompt).toContain('USER:\n第一个问题');
    expect(second?.prompt).toContain('ASSISTANT:\n回答一');
    expect(second?.prompt).toContain('--- CURRENT USER QUESTION ---\n继续说');
  });

  it('sends WeChat text only for the turn it is ticked for', async () => {
    const { box } = await open();
    const tick = screen.getByLabelText(/本轮附带当前微信聊天片段/) as HTMLInputElement;
    fireEvent.click(tick);
    type(box, '总结一下');
    enter(box);
    await screen.findByText('回答一');
    const first = completions()[0].body?.prompt ?? '';
    expect(first).toContain('周五下午三点开会');
    expect(first).toContain('[12@' + (now - 60) + '] Me: 好的，我会准时到');
    // text messages only, and no account identifier of either side
    expect(first).not.toContain('[图片]');
    expect(first).not.toContain('wxid_a');
    await waitFor(() => expect(tick.checked).toBe(false));
    complete = () => json({ text: '回答二' });
    type(box, '再问一句');
    enter(box);
    await screen.findByText('回答二');
    expect(messageReads()).toHaveLength(1);
    expect(completions()[1].body?.prompt).not.toContain('周五下午三点开会');
  });

  it('stops the request, gives the question back and leaves no unanswered turn', async () => {
    const slow = pending();
    complete = slow.answer;
    const { box } = await open();
    type(box, '写一篇长文');
    enter(box);
    fireEvent.click(await screen.findByRole('button', { name: '停止生成' }));
    await screen.findByRole('button', { name: '发送给 AI' });
    expect(completions()[0].signal?.aborted).toBe(true);
    expect(box.value).toBe('写一篇长文');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelectorAll('.ai-turn')).toHaveLength(0);
    complete = () => json({ text: '回答二' });
    enter(box);
    await screen.findByText('回答二');
    expect(completions()[1].body?.prompt).not.toContain('PRIOR AI CONVERSATION');
  });

  it('starts empty in another conversation and drops the answer still on its way', async () => {
    const slow = pending();
    complete = slow.answer;
    const { view, box } = await open('wxid_a');
    type(box, '关于甲的问题');
    enter(box);
    await screen.findByRole('button', { name: '停止生成' });
    view.rerender(<AiCard sessionId="wxid_b" sessionName="周远" />);
    expect(completions()[0].signal?.aborted).toBe(true);
    await act(async () => { slow.give({ text: '甲的秘密' }); await Promise.resolve(); });
    expect(screen.queryByText('甲的秘密')).toBeNull();
    expect(screen.queryByText('关于甲的问题')).toBeNull();
    expect(document.querySelectorAll('.ai-turn')).toHaveLength(0);
    complete = () => json({ text: '回答乙' });
    type(box, '关于乙的问题');
    enter(box);
    await screen.findByText('回答乙');
    expect(completions()[1].body?.prompt).not.toContain('甲');
  });

  it('says why the bridge refused', async () => {
    complete = () => json({ error: 'A ChatGPT sharing limit has been reached.', code: 'subscription_sharing_usage_limit_exceeded' }, 429);
    const { box } = await open();
    type(box, '你好');
    enter(box);
    expect((await screen.findByRole('alert')).textContent).toContain('ChatGPT 订阅额度已用完');
    expect(box.value).toBe('你好');
  });
});
