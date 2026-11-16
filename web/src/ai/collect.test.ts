import { afterEach, describe, expect, it, vi } from '#test';
import { at, fakeChat, message, type FakeMessage } from '../../test/fakeChat';
import { collectKeyword, collectRange, collectRecent } from './collect';

afterEach(() => { vi.unstubAllGlobals(); });

function serve(all: FakeMessage[]) {
  const chat = fakeChat(all);
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const response = chat.respond(String(input));
    return response ? Promise.resolve(response) : Promise.reject(new Error('unexpected request ' + String(input)));
  }));
  return chat;
}
const signal = new AbortController().signal;
const contents = (texts: { parsedContent: string }[]) => texts.map(item => item.parsedContent).sort();

describe('the latest messages', () => {
  it('reads further back when the newest page is mostly pictures', async () => {
    const old = [message(at(2026, 9, 1), '很早的文字'), message(at(2026, 9, 2), '早的文字')];
    const pictures = Array.from({ length: 199 }, (_, n) => message(at(2026, 10, 1, 0, n), '[图片]', { localType: 3 }));
    const chat = serve([...old, ...pictures, message(at(2026, 10, 2), '最新的文字')]);
    const found = await collectRecent('wxid_a', 3, signal);
    expect(contents(found.texts)).toEqual(['很早的文字', '早的文字', '最新的文字'].sort());
    expect(chat.reads()).toHaveLength(2);
    expect(found.more).toBe(false);
  });
});

describe('the messages of a period', () => {
  const days = [
    message(at(2026, 9, 30, 23, 59), '九月最后一条'),
    message(at(2026, 10, 1, 0, 0), '十月第一条'),
    message(at(2026, 10, 1, 9, 0), '[图片]', { localType: 3 }),
    message(at(2026, 10, 3, 12, 0), '十月三号'),
    message(at(2026, 10, 7, 23, 59), '十月七号最后一刻'),
    message(at(2026, 10, 8, 0, 0), '十月八号'),
  ];

  it('holds the text sent from the first to the last second of it, and nothing else', async () => {
    const chat = serve(days);
    const found = await collectRange('wxid_a', at(2026, 10, 1), at(2026, 10, 7, 23, 59) + 59, 150, signal);
    expect(contents(found.texts)).toEqual(['十月第一条', '十月三号', '十月七号最后一刻'].sort());
    expect(found.more).toBe(false);
    expect(chat.reads()[0].searchParams.get('since')).toBe(String(at(2026, 10, 1)));
  });

  it('is empty for a period with no messages', async () => {
    serve(days);
    expect((await collectRange('wxid_a', at(2026, 11, 1), at(2026, 11, 2), 150, signal)).texts).toEqual([]);
    expect((await collectRange('wxid_a', at(2026, 10, 4), at(2026, 10, 5), 150, signal)).texts).toEqual([]);
  });

  it('pages forward through a long period and says when it holds more than fit', async () => {
    const many = Array.from({ length: 450 }, (_, n) => message(at(2026, 10, 1, 0, n), '第' + n + '条'));
    const chat = serve([...many, message(at(2026, 10, 20), '范围之后')]);
    const found = await collectRange('wxid_a', at(2026, 10, 1), at(2026, 10, 2), 150, signal);
    // the beginning of the period, read until there is more than can go with a question
    expect(found.more).toBe(true);
    expect(found.texts.some(item => item.parsedContent === '第0条')).toBe(true);
    expect(found.texts.some(item => item.parsedContent === '范围之后')).toBe(false);
    expect(chat.reads()).toHaveLength(1);

    const all = await collectRange('wxid_a', at(2026, 10, 1), at(2026, 10, 2), 1000, signal);
    expect(all.texts).toHaveLength(450);
    expect(all.more).toBe(false);
    // 200 a page: the second and third start after the newest message of the page before
    expect(chat.reads().slice(1).map(url => url.searchParams.has('after'))).toEqual([false, true, true]);
  });
});

describe('the messages that hold a keyword', () => {
  const talk = [
    message(at(2026, 10, 1, 9, 0), '早上好'),
    message(at(2026, 10, 1, 9, 1), '在吗'),
    message(at(2026, 10, 1, 9, 2), '合同我看过了'),
    message(at(2026, 10, 1, 9, 3), '第三条有问题'),
    message(at(2026, 10, 1, 9, 4), '[图片]', { localType: 3 }),
    message(at(2026, 10, 1, 9, 5), '我改一下再发你'),
    message(at(2026, 10, 1, 9, 6), '好的'),
    message(at(2026, 10, 5, 15, 0), '吃饭了吗'),
    message(at(2026, 10, 9, 10, 0), '新合同发你了'),
    message(at(2026, 10, 9, 10, 1), '收到'),
  ];

  it('come with the two before and after each, once each, text only', async () => {
    const chat = serve(talk);
    const found = await collectKeyword('wxid_a', '合同', 0, 0, signal);
    expect(found.hits).toBe(2);
    // around the first match: two before, and of the two after only the text one (the other is a picture);
    // around the second: the two before it, however long ago, and the one after
    expect(contents(found.texts)).toEqual([
      '早上好', '在吗', '合同我看过了', '第三条有问题', '好的', '吃饭了吗', '新合同发你了', '收到',
    ].sort());
    expect(found.texts.some(item => item.parsedContent === '我改一下再发你')).toBe(false);
    expect(chat.searches()[0].searchParams.get('session-id')).toBe('wxid_a');
  });

  it('can be limited to a period', async () => {
    serve(talk);
    const found = await collectKeyword('wxid_a', '合同', at(2026, 10, 8), at(2026, 10, 10), signal);
    expect(found.hits).toBe(1);
    expect(found.texts.some(item => item.parsedContent === '合同我看过了')).toBe(false);
    expect(found.texts.some(item => item.parsedContent === '新合同发你了')).toBe(true);
  });

  it('keeps the newest thirty matches and says there were more', async () => {
    serve(Array.from({ length: 45 }, (_, n) => message(at(2026, 10, 1, 0, n), '发票 ' + n)));
    const found = await collectKeyword('wxid_a', '发票', 0, 0, signal);
    expect(found.more).toBe(true);
    expect(found.texts.some(item => item.parsedContent === '发票 44')).toBe(true);
    expect(found.texts.some(item => item.parsedContent === '发票 0')).toBe(false);
  });

  it('is empty when nothing matches', async () => {
    serve(talk);
    expect(await collectKeyword('wxid_a', '不存在的词', 0, 0, signal)).toEqual({ texts: [], more: false, hits: 0 });
  });
});
