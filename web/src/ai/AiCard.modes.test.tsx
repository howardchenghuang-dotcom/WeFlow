// Which messages go with a question: chosen from the question itself, the latest ones, or by dates and a keyword.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from '#test';
import { at, fakeChat, message, type FakeMessage } from '../../test/fakeChat';
import { AiCard } from './AiCard';

type Body = { model: string; messages: { role: string; content: string }[]; purpose?: string };

const pieces = (...lines: object[]) => new Response(lines.map(line => JSON.stringify(line) + '\n').join(''),
  { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
const answer = (text: string) => pieces({ delta: text }, { done: true });
const json = (data: unknown) => new Response(JSON.stringify(data));
const address = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;

const talk: FakeMessage[] = [
  message(at(2026, 9, 28, 10, 0), '九月的旧消息'),
  message(at(2026, 10, 1, 9, 0), '十月一号早上好'),
  message(at(2026, 10, 1, 9, 1), '合同我看过了', { isSend: 1, senderUsername: 'wxid_me' }),
  message(at(2026, 10, 1, 9, 2), '第三条有问题'),
  message(at(2026, 10, 1, 9, 3), '[图片]', { localType: 3 }),
  message(at(2026, 10, 6, 20, 0), '十月六号晚上'),
  message(at(2026, 10, 9, 8, 0), '十月九号之后'),
  message(at(2026, 11, 14, 8, 0), '昨天的消息'),
  message(at(2026, 11, 15, 8, 0), '今天最新的消息'),
];

let bodies: Body[] = [];
let plan = '{"from":null,"to":null,"keyword":null}';
let chat = fakeChat(talk);
const plans = () => bodies.filter(body => body.purpose === 'plan');
const questions = () => bodies.filter(body => body.purpose !== 'plan');
const sent = () => { const all = questions(); const body = all[all.length - 1]; return body.messages[body.messages.length - 1].content; };

function serve(all: FakeMessage[]) {
  chat = fakeChat(all);
}

beforeEach(() => {
  address.setURL('http://127.0.0.1:18110/ui/');
  bodies = [];
  plan = '{"from":null,"to":null,"keyword":null}';
  serve(talk);
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/ai-auth/session')) return Promise.resolve(json({ paired: true, expiresAt: Date.now() + 1000, status: 'connected', sharing: true }));
    if (url.endsWith('/ai-auth/models')) return Promise.resolve(json({ models: [{ slug: 'm1', displayName: 'Model One' }] }));
    if (url.endsWith('/ai-auth/complete')) {
      const body = JSON.parse(String(init?.body)) as Body;
      bodies.push(body);
      return Promise.resolve(answer(body.purpose === 'plan' ? plan : '回答'));
    }
    const local = chat.respond(url);
    return local ? Promise.resolve(local) : Promise.reject(new Error('unexpected request ' + url));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); address.setURL('http://localhost/'); });

/** The card with WeChat text ticked and a question typed; `mode` picks the menu entry. */
async function ready(question: string, mode?: 'recent' | 'pick') {
  render(<AiCard sessionId="wxid_a" sessionName="林沐" />);
  const box = await screen.findByLabelText('向 AI 提问') as HTMLTextAreaElement;
  fireEvent.click(screen.getByLabelText(/本轮附带这个会话的微信聊天片段/));
  if (mode) fireEvent.change(screen.getByLabelText('附带哪些'), { target: { value: mode } });
  fireEvent.change(box, { target: { value: question } });
  return box;
}
const send = () => fireEvent.click(screen.getByRole('button', { name: '发送（附带微信片段）' }));
const set = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('read what the question is about', () => {
  it('asks first where to read, without any chat text, then reads that period', async () => {
    plan = '{"from":"2026-10-01","to":"2026-10-07","keyword":null}';
    await ready('十月第一周我们聊了什么？');
    send();
    await screen.findByText('回答');
    expect(plans()).toHaveLength(1);
    const asked = plans()[0].messages[plans()[0].messages.length - 1].content;
    expect(asked).toContain('--- QUESTION ---\n十月第一周我们聊了什么？');
    expect(asked).toContain('This conversation has messages from 2026-09-28 to 2026-11-15.');
    // nothing of the conversation is in the request that only asks where to read
    for (const item of talk) expect(JSON.stringify(plans()[0])).not.toContain(item.parsedContent);

    const excerpt = sent();
    expect(excerpt).toContain('十月一号早上好');
    expect(excerpt).toContain('] Me: 合同我看过了');
    expect(excerpt).toContain('十月六号晚上');
    for (const outside of ['九月的旧消息', '十月九号之后', '今天最新的消息', '[图片]']) expect(excerpt).not.toContain(outside);
    expect(excerpt).toContain('These are the messages sent from 2026-10-01 up to 2026-10-07 (local dates), read from the beginning of that period.');
    expect(excerpt).not.toContain('only PART');
    expect(excerpt.endsWith('--- CURRENT USER QUESTION ---\n十月第一周我们聊了什么？')).toBe(true);
    expect(screen.getByText('本轮读取：2026-10-01 至 2026-10-07的消息，共 4 条')).toBeTruthy();
  });

  it('reads the messages that hold a keyword, with those around them', async () => {
    plan = '{"from":null,"to":null,"keyword":"合同"}';
    await ready('他是怎么说合同的？');
    send();
    await screen.findByText('回答');
    const excerpt = sent();
    expect(excerpt).toContain('These are the messages that contain "合同"');
    for (const near of ['九月的旧消息', '十月一号早上好', '合同我看过了', '第三条有问题']) expect(excerpt).toContain(near);
    for (const far of ['十月九号之后', '今天最新的消息']) expect(excerpt).not.toContain(far);
    expect(chat.searches()[0].searchParams.get('session-id')).toBe('wxid_a');
    expect(screen.getByText('本轮读取：含「合同」的消息及其前后文，共 4 条')).toBeTruthy();
  });

  it('reads the latest messages when the plan names nothing, or cannot be read', async () => {
    plan = '我觉得应该读最近的。';
    await ready('最近怎么样？');
    send();
    await screen.findByText('回答');
    expect(sent()).toContain('今天最新的消息');
    expect(sent()).not.toContain('These are the messages');
    expect(screen.getByText('本轮读取：最近的 8 条文字消息')).toBeTruthy();
  });

  it('falls back to the latest messages when the plan finds nothing, and says so to both', async () => {
    plan = '{"from":null,"to":null,"keyword":"发票"}';
    await ready('发票的事怎么说的？');
    send();
    await screen.findByText('回答');
    expect(sent()).toContain('Nothing was found for the period or keyword the question pointed to');
    expect(sent()).toContain('今天最新的消息');
    expect(screen.getByText('本轮读取：没有找到含「发票」的文字消息，改为最近的 8 条文字消息')).toBeTruthy();
  });

  it('says the excerpt is only the beginning of a period that holds more than fit', async () => {
    serve(Array.from({ length: 400 }, (_, n) => message(at(2026, 10, 1, 0, n), '第' + n + '条')));
    plan = '{"from":"2026-10-01","to":"2026-10-01","keyword":null}';
    await ready('十月一号聊了什么？');
    send();
    await screen.findByText('回答');
    const excerpt = sent();
    expect(excerpt).toContain('This excerpt is only PART of what was asked for: it holds 150 messages, from 2026-10-01 00:00 to 2026-10-01 02:29');
    expect(excerpt).toContain('第0条');
    expect(excerpt).toContain('第149条');
    expect(excerpt).not.toContain('第150条');
    expect(screen.getByText('本次只分析了部分微信聊天记录，并非完整历史。')).toBeTruthy();
  });

  it('gives the planner the earlier turns, so that "and the week after?" means something', async () => {
    plan = '{"from":"2026-10-01","to":"2026-10-07","keyword":null}';
    const box = await ready('十月第一周聊了什么？');
    send();
    await screen.findByText('回答');
    fireEvent.click(screen.getByLabelText(/本轮附带这个会话的微信聊天片段/));
    fireEvent.change(box, { target: { value: '那之后一周呢？' } });
    send();
    await screen.findAllByText('回答');
    const second = plans()[1].messages;
    expect(second.map(item => item.role)).toEqual(['user', 'assistant', 'user']);
    expect(second[0].content).toBe('十月第一周聊了什么？');
    expect(second[2].content).toContain('--- QUESTION ---\n那之后一周呢？');
  });
});

describe('the latest messages, as many as chosen', () => {
  it('asks no one where to read', async () => {
    await ready('总结一下', 'recent');
    fireEvent.change(screen.getByLabelText('附带多少'), { target: { value: '30' } });
    send();
    await screen.findByText('回答');
    expect(plans()).toHaveLength(0);
    expect(sent()).toContain('今天最新的消息');
    expect(chat.reads()[0].searchParams.has('since')).toBe(false);
  });
});

describe('dates and a keyword, filled in', () => {
  it('reads the days given, both included, and asks no one where to read', async () => {
    await ready('这几天说了什么？', 'pick');
    set('从', '2026-10-01');
    set('到', '2026-10-06');
    send();
    await screen.findByText('回答');
    expect(plans()).toHaveLength(0);
    expect(sent()).toContain('十月一号早上好');
    expect(sent()).toContain('十月六号晚上');
    expect(sent()).not.toContain('十月九号之后');
    expect(screen.getByText('本轮读取：2026-10-01 至 2026-10-06的消息，共 4 条')).toBeTruthy();
  });

  it('reads a keyword within the days given', async () => {
    await ready('合同怎么说的？', 'pick');
    set('从', '2026-10-01');
    set('到', '2026-10-01');
    set('关键词', '合同');
    send();
    await screen.findByText('回答');
    const search = chat.searches()[0].searchParams;
    expect(search.get('keyword')).toBe('合同');
    expect(Number(search.get('start'))).toBe(at(2026, 10, 1));
    expect(Number(search.get('end'))).toBe(at(2026, 10, 1, 23, 59) + 59);
    expect(sent()).toContain('These are the messages that contain "合同" and were sent from 2026-10-01 up to 2026-10-01 (local dates)');
  });

  it('sends nothing when nothing is filled in, or the dates are the wrong way round', async () => {
    const box = await ready('说了什么？', 'pick');
    send();
    expect((await screen.findByRole('alert')).textContent).toBe('请填写日期或关键词，或者改用「最近的消息」。');
    set('从', '2026-10-07');
    set('到', '2026-10-01');
    send();
    expect((await screen.findByRole('alert')).textContent).toBe('开始日期晚于结束日期。');
    expect(bodies).toHaveLength(0);
    expect(box.value).toBe('说了什么？');
  });

  it('says so, and sends nothing, when the keyword is in no message', async () => {
    const box = await ready('发票怎么说的？', 'pick');
    set('关键词', '发票');
    send();
    expect((await screen.findByRole('alert')).textContent).toBe('没有找到含「发票」的文字消息');
    expect(bodies).toHaveLength(0);
    expect(box.value).toBe('发票怎么说的？');
    expect(document.querySelectorAll('.ai-turn')).toHaveLength(0);
  });
});
