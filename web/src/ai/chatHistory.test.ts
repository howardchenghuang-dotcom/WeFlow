import { describe, expect, it } from '#test';
import { buildAiPrompt, MAX_VISIBLE_TURNS, restoreAiTurns } from './chatHistory';

describe('personal AI chat history', () => {
  const earlier = [
    { id: '1', role: 'user' as const, text: '第一轮：请解释订单', time: 100 },
    { id: '2', role: 'assistant' as const, text: '订单需要核对日期', time: 101 },
  ];
  it('keeps previous turns for follow-up questions', () => {
    const prompt = buildAiPrompt('那日期呢？', earlier);
    expect(prompt).toContain('第一轮：请解释订单');
    expect(prompt).toContain('订单需要核对日期');
    expect(prompt).toContain('那日期呢？');
  });
  it('does not attach WeChat data unless opted in', () => {
    const prompt = buildAiPrompt('Hello', []);
    expect(prompt).toContain('No new WeChat messages are attached');
    expect(prompt).not.toContain('微信私人信息');
    const attached = buildAiPrompt('总结', [], '微信私人信息 [101@12345]');
    expect(attached).toContain('微信私人信息');
  });
  it('enforces bounded history and rejects oversized input', () => {
    const turns = Array.from({ length: 100 }, (_, n) =>
      ({ id: String(n), role: 'assistant' as const, text: 'x'.repeat(1000), time: n }));
    const prompt = buildAiPrompt('current', turns);
    expect(prompt.length).toBeLessThan(10_000);
    expect(() => buildAiPrompt('a'.repeat(801), [])).toThrow();
    expect(restoreAiTurns(turns).length).toBeLessThanOrEqual(MAX_VISIBLE_TURNS);
  });
  it('drops invalid storage content before restoring a dialogue', () => {
    const saved = restoreAiTurns([null, { role: 'user', id: 'x', text: 'ok', time: 1 },
      { role: 'assistant', id: 'y', text: 'oops', time: 'bad' }]);
    expect(saved).toHaveLength(1);
    expect(saved[0].text).toBe('ok');
  });
});
