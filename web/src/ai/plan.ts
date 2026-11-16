// "Read what the question is about": before chat text is attached, the model is asked which part of the open
// conversation the question needs, and answers with a period and/or a keyword. That first request holds the
// question and the earlier AI turns, never chat messages. What it answers is only a suggestion of where to read:
// it is checked here, and the reading itself stays within this one conversation and the usual limits.

/** What to read: a period (Unix seconds, both ends included), a keyword, both, or neither (the latest messages). */
export interface Plan {
  start?: number;
  end?: number;
  keyword?: string;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_KEYWORD = 40;

/** Local midnight that starts `day` (`YYYY-MM-DD`), in Unix seconds; null when it is no real date. */
export function dayStart(day: unknown): number | null {
  const match = typeof day === 'string' ? DAY.exec(day.trim()) : null;
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(year, month - 1, date);
  // 2026-02-31 would silently become March the 3rd
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== date) return null;
  return Math.floor(at.getTime() / 1000);
}

/** The last second of `day`. */
export function dayEnd(day: unknown): number | null {
  const start = dayStart(day);
  return start === null ? null : start + 86_399;
}

/** `YYYY-MM-DD` of a moment, in local time. */
export function dayOf(moment: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return moment.getFullYear() + '-' + two(moment.getMonth() + 1) + '-' + two(moment.getDate());
}

/**
 * The plan in a model's reply: the first `{…}` of it, read as JSON. Anything missing, malformed or out of bounds
 * is left out, so the worst a strange reply does is "read the latest messages".
 */
export function parsePlan(reply: string): Plan {
  const open = reply.indexOf('{');
  const close = reply.lastIndexOf('}');
  if (open < 0 || close <= open) return {};
  let data: unknown;
  try { data = JSON.parse(reply.slice(open, close + 1)); } catch { return {}; }
  if (!data || typeof data !== 'object') return {};
  const { from, to, keyword } = data as Record<string, unknown>;
  const plan: Plan = {};
  const start = dayStart(from);
  const end = dayEnd(to);
  if (start !== null && end !== null) {
    // a period the wrong way round is still a period
    plan.start = Math.min(start, dayStart(to)!);
    plan.end = Math.max(end, dayEnd(from)!);
  } else if (start !== null) {
    plan.start = start;
    plan.end = Math.floor(Date.now() / 1000);
  } else if (end !== null) {
    plan.start = 0;
    plan.end = end;
  }
  if (typeof keyword === 'string') {
    const word = keyword.replace(/\s+/g, ' ').trim();
    if (word && word.length <= MAX_KEYWORD) plan.keyword = word;
  }
  return plan;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * What the planner is told besides the question: today's date, so that "last week" means something, and the
 * first and last day the conversation has messages on, so that it does not pick a period with nothing in it.
 */
export function planRequest(question: string, today: Date, first?: string, last?: string): string {
  return [
    `Today is ${dayOf(today)} (${WEEKDAYS[today.getDay()]}), in the user's local time.`,
    first && last ? `This conversation has messages from ${first} to ${last}.` : '',
    'Which part of the conversation should be read to answer this question?',
    '--- QUESTION ---',
    question.trim(),
  ].filter(Boolean).join('\n');
}
