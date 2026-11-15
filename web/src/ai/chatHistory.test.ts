import { describe, expect, it } from '#test';
import { buildAiMessages, MAX_CONTEXT_CHARS, type AiTurn } from './chatHistory';

describe('personal AI chat history', () => {
  const earlier: AiTurn[] = [
    { id: '1', role: 'user', text: '第一轮：请解释订单', time: 100 },
    { id: '2', role: 'assistant', text: '订单需要核对日期', time: 101 },
  ];
  it('keeps previous turns, in their own roles, for follow-up questions', () => {
    expect(buildAiMessages('那日期呢？', earlier)).toEqual([
      { role: 'user', content: '第一轮：请解释订单' },
      { role: 'assistant', content: '订单需要核对日期' },
      { role: 'user', content: '那日期呢？' },
    ]);
  });
  it('sends a plain question as it was typed, and WeChat text only when given', () => {
    expect(buildAiMessages('  Hello ', [])).toEqual([{ role: 'user', content: 'Hello' }]);
    const [attached] = buildAiMessages('总结', [], '微信私人信息 [101@12345]');
    expect(attached.content).toContain('微信私人信息');
    expect(attached.content.endsWith('--- CURRENT USER QUESTION ---\n总结')).toBe(true);
  });
  it('enforces bounded history and rejects oversized input', () => {
    const turns: AiTurn[] = Array.from({ length: 100 }, (_, n) =>
      ({ id: String(n), role: 'assistant', text: 'x'.repeat(1000), time: n }));
    const messages = buildAiMessages('current', turns);
    const history = messages.slice(0, -1);
    expect(history.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(history.length).toBe(8);
    expect(() => buildAiMessages('a'.repeat(801), [])).toThrow();
    expect(() => buildAiMessages('   ', [])).toThrow();
  });
  it('keeps the newest turns and leaves out an answer with nothing in it', () => {
    const turns: AiTurn[] = [
      { id: 'a', role: 'user', text: 'old '.repeat(1500), time: 1 },
      { id: 'b', role: 'assistant', text: 'x'.repeat(2500), time: 2 },
      { id: 'c', role: 'user', text: '最近的问题', time: 3 },
      { id: 'd', role: 'assistant', text: '', time: 4, partial: true },
    ];
    const messages = buildAiMessages('下一个', turns);
    expect(messages.map(message => message.content.slice(0, 5))).toEqual(['old o', 'xxxxx', '最近的问题', '下一个']);
    // a long turn is cut to 2500 characters
    expect(messages[0].content.length).toBe(2500);
  });
});
