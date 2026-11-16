// A conversation for the tests of the AI card: answers the routes it reads messages with (`api/chat/messages`,
// `api/chat/search`, `api/chat/date-counts`) from a list held in memory, paging as the server does.
export interface FakeMessage {
  _cursor: string;
  localId: number;
  localType: number;
  createTime: number;
  isSend: number;
  senderUsername: string | null;
  parsedContent: string;
}

/** Local midnight of a day, in Unix seconds. */
export const at = (year: number, month: number, date: number, hour = 0, minute = 0) =>
  Math.floor(new Date(year, month - 1, date, hour, minute).getTime() / 1000);

let nextId = 1;
/** A text message (`type` 3 for a picture), with a cursor of its own. */
export function message(createTime: number, parsedContent: string, more: Partial<FakeMessage> = {}): FakeMessage {
  const localId = nextId++;
  return { _cursor: 'c' + localId, localId, localType: 1, createTime, isSend: 0, senderUsername: 'wxid_a', parsedContent, ...more };
}

const two = (n: number) => String(n).padStart(2, '0');
const dayOf = (seconds: number) => {
  const moment = new Date(seconds * 1000);
  return moment.getFullYear() + '-' + two(moment.getMonth() + 1) + '-' + two(moment.getDate());
};

export function fakeChat(all: FakeMessage[]) {
  const sorted = [...all].sort((a, b) => a.createTime - b.createTime || a.localId - b.localId);
  const requests: URL[] = [];
  const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
  /** The answer to a request of the card, or null when the address is none of this conversation's. */
  const respond = (address: string): Response | null => {
    const url = new URL(address, 'http://127.0.0.1:18110/ui/');
    const query = url.searchParams;
    if (url.pathname.endsWith('api/chat/messages')) {
      requests.push(url);
      const limit = Number(query.get('limit') ?? 50);
      const index = (cursor: string | null) => sorted.findIndex(item => item._cursor === cursor);
      let page: FakeMessage[];
      if (query.has('before')) page = sorted.slice(0, Math.max(index(query.get('before')), 0)).slice(-limit);
      else if (query.has('after')) page = sorted.slice(index(query.get('after')) + 1).slice(0, limit);
      else if (query.has('since')) page = sorted.filter(item => item.createTime >= Number(query.get('since'))).slice(0, limit);
      else page = sorted.slice(-limit);
      return json([...page].reverse());
    }
    if (url.pathname.endsWith('api/chat/search')) {
      requests.push(url);
      const keyword = query.get('keyword') ?? '';
      const start = Number(query.get('start') ?? 0);
      const end = Number(query.get('end') ?? 0);
      const hits = sorted.filter(item => item.parsedContent.includes(keyword)
        && (!start || item.createTime >= start) && (!end || item.createTime <= end)).reverse();
      const offset = Number(query.get('offset') ?? 0);
      return json(hits.slice(offset, offset + Number(query.get('limit') ?? 20)).map(item => ({ ...item, _session_id: query.get('session-id') })));
    }
    if (url.pathname.endsWith('api/chat/date-counts')) {
      requests.push(url);
      const counts: Record<string, number> = {};
      for (const item of sorted) counts[dayOf(item.createTime)] = (counts[dayOf(item.createTime)] ?? 0) + 1;
      return json({ counts });
    }
    return null;
  };
  return {
    respond, requests,
    reads: () => requests.filter(url => url.pathname.endsWith('api/chat/messages')),
    searches: () => requests.filter(url => url.pathname.endsWith('api/chat/search')),
  };
}
