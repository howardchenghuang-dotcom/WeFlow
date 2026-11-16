// Which messages of the open conversation go with a question: the latest ones, those of a period, or those that
// hold a keyword with the few around each. Everything here reads from the local backend only; what is collected is
// sent to the cloud by the card, and only for a turn the reader ticked.
import { getMessages, SEARCH_PAGE, searchMessages, type PageFrom, type ParsedMessage } from '../api/messages';

export const PAGE = 200;
/** No more than this many text messages go with one question, however they were chosen. */
export const MAX_ATTACHED = 150;
const RECENT_PAGES = 3;
const RANGE_PAGES = 8;
const MAX_HITS = 30;
const SEARCH_PAGES = 3;
const AROUND = 2;

export interface Collected {
  /** Text messages, in no particular order. */
  texts: ParsedMessage[];
  /** Messages that belong to what was asked for were left out. */
  more: boolean;
  /** Keyword search only: how many messages matched. */
  hits?: number;
}

const isText = (message: ParsedMessage) => message.localType === 1 && !!message.parsedContent?.trim();
const key = (message: ParsedMessage) => message.createTime + ':' + message.localId;
const older = (a: ParsedMessage, b: ParsedMessage) => (b.createTime < a.createTime || (b.createTime === a.createTime && b.localId < a.localId) ? b : a);
const newer = (a: ParsedMessage, b: ParsedMessage) => (b.createTime > a.createTime || (b.createTime === a.createTime && b.localId > a.localId) ? b : a);

/**
 * The newest text messages: pages of 200 are read, newest first, until `want` of them are text or three pages are
 * read.
 */
export async function collectRecent(sessionId: string, want: number, signal: AbortSignal): Promise<Collected> {
  const texts: ParsedMessage[] = [];
  let from: PageFrom = null;
  let more = false;
  for (let page = 0; page < RECENT_PAGES; page++) {
    const batch = await getMessages(sessionId, from, signal, PAGE);
    texts.push(...batch.filter(isText));
    more = batch.length >= PAGE;
    if (!more || texts.length >= want) break;
    from = { before: batch.reduce(older)._cursor };
  }
  return { texts, more };
}

/**
 * The text messages sent from `start` to `end` (Unix seconds, both included), read forward from the first one:
 * until `want` are found, the period ends, or eight pages are read. So when the period holds more than fit, it is
 * its beginning that is returned, and `more` says so.
 */
export async function collectRange(sessionId: string, start: number, end: number, want: number, signal: AbortSignal): Promise<Collected> {
  const texts: ParsedMessage[] = [];
  let from: PageFrom = { since: start };
  for (let page = 0; page < RANGE_PAGES; page++) {
    const batch = await getMessages(sessionId, from, signal, PAGE);
    if (!batch.length) return { texts, more: false };
    const inside = batch.filter(message => message.createTime >= start && message.createTime <= end);
    texts.push(...inside.filter(isText));
    // a message after the period: everything in it has been seen
    if (inside.length < batch.length && batch.some(message => message.createTime > end)) return { texts, more: texts.length > want };
    if (batch.length < PAGE) return { texts, more: texts.length > want };
    if (texts.length > want) return { texts, more: true };
    from = { after: batch.reduce(newer)._cursor };
  }
  // the page limit was reached with the period not read to its end
  return { texts, more: true };
}

/** Runs `task` over `items`, four at a time: the backend answers quickly, yet sixty requests at once help nobody. */
async function inBatches<T>(items: T[], task: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += 4) await Promise.all(items.slice(i, i + 4).map(task));
}

/**
 * The text messages that hold `keyword` (the newest thirty of them, within `start`..`end` when given, 0 for no
 * limit), each with the two messages before and after it: a hit alone does not show what it answered or what
 * was answered to it.
 */
export async function collectKeyword(sessionId: string, keyword: string, start: number, end: number, signal: AbortSignal): Promise<Collected> {
  const found: ParsedMessage[] = [];
  let more = false;
  for (let page = 0; page < SEARCH_PAGES; page++) {
    const batch = await searchMessages({ keyword, sessionId, start, end }, page * SEARCH_PAGE, signal);
    found.push(...batch);
    more = batch.length >= SEARCH_PAGE;
    if (!more || found.filter(isText).length >= MAX_HITS) break;
  }
  const hits = found.filter(isText);
  const kept = hits.slice(0, MAX_HITS);
  const all = new Map<string, ParsedMessage>(kept.map(hit => [key(hit), hit]));
  await inBatches(kept.filter(hit => hit._cursor), async hit => {
    const [before, after] = await Promise.all([
      getMessages(sessionId, { before: hit._cursor }, signal, AROUND),
      getMessages(sessionId, { after: hit._cursor }, signal, AROUND),
    ]);
    for (const message of [...before, ...after]) if (isText(message)) all.set(key(message), message);
  });
  return { texts: [...all.values()], more: more || hits.length > kept.length, hits: hits.length };
}
