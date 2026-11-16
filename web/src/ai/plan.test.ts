import { describe, expect, it } from '#test';
import { dayEnd, dayOf, dayStart, parsePlan, planRequest } from './plan';

const local = (year: number, month: number, date: number, hour = 0, minute = 0, second = 0) =>
  Math.floor(new Date(year, month - 1, date, hour, minute, second).getTime() / 1000);

describe('days', () => {
  it('start at local midnight and end a second before the next', () => {
    expect(dayStart('2026-10-01')).toBe(local(2026, 10, 1));
    expect(dayEnd('2026-10-01')).toBe(local(2026, 10, 1, 23, 59, 59));
    expect(dayOf(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
  it('are refused when they are no real date', () => {
    for (const bad of ['2026-02-31', '2026-13-01', '10/01/2026', '2026-1-1', '', null, 20261001]) expect(dayStart(bad)).toBeNull();
  });
});

describe('the plan in a reply', () => {
  it('is a period, a keyword, or both', () => {
    expect(parsePlan('{"from":"2026-10-01","to":"2026-10-07","keyword":null}')).toEqual({ start: local(2026, 10, 1), end: local(2026, 10, 7, 23, 59, 59) });
    expect(parsePlan('{"from":null,"to":null,"keyword":"合同"}')).toEqual({ keyword: '合同' });
    expect(parsePlan('{"from":"2026-10-03","to":"2026-10-03","keyword":" 发票  金额 "}')).toEqual({ start: local(2026, 10, 3), end: local(2026, 10, 3, 23, 59, 59), keyword: '发票 金额' });
    expect(parsePlan('{"from":null,"to":null,"keyword":null}')).toEqual({});
  });
  it('is found inside a reply that says more than it was asked to', () => {
    expect(parsePlan('好的，计划如下：\n```json\n{"from":"2026-10-01","to":"2026-10-02","keyword":null}\n```')).toEqual({ start: local(2026, 10, 1), end: local(2026, 10, 2, 23, 59, 59) });
  });
  it('is put right when the period is the wrong way round, or has one end', () => {
    expect(parsePlan('{"from":"2026-10-07","to":"2026-10-01"}')).toEqual({ start: local(2026, 10, 1), end: local(2026, 10, 7, 23, 59, 59) });
    const open = parsePlan('{"from":"2026-10-01","to":null}');
    expect(open.start).toBe(local(2026, 10, 1));
    expect(open.end).toBeGreaterThan(open.start!);
    expect(parsePlan('{"from":null,"to":"2026-10-01"}')).toEqual({ start: 0, end: local(2026, 10, 1, 23, 59, 59) });
  });
  it('is "the latest messages" for anything it cannot make sense of', () => {
    for (const reply of ['', '我不确定', '{not json}', '[]', '{"from":"昨天","to":"今天"}', '{"from":"2026-02-31","to":"2026-02-31"}', '{"keyword":123}', '{"keyword":"' + 'x'.repeat(41) + '"}', '{"keyword":"   "}']) {
      expect(parsePlan(reply)).toEqual({});
    }
  });
});

describe('what the planner is asked', () => {
  it('holds today, the days the conversation spans, and the question; no chat text', () => {
    const asked = planRequest('  上周聊了什么？ ', new Date(2026, 10, 15, 19, 0), '2024-03-02', '2026-11-15');
    expect(asked).toContain('Today is 2026-11-15 (Sunday)');
    expect(asked).toContain('This conversation has messages from 2024-03-02 to 2026-11-15.');
    expect(asked.endsWith('--- QUESTION ---\n上周聊了什么？')).toBe(true);
    expect(planRequest('x', new Date(2026, 10, 15))).not.toContain('has messages from');
  });
});
