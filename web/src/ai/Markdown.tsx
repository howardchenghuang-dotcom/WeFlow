// The Markdown a model answers in, drawn as React elements: headings, lists, tables, quotes, code, bold, italic
// and links. The text never becomes HTML, so nothing in an answer (or in WeChat text an answer quotes) can run
// as markup; a link is followed only when it is http(s). What is not recognised is shown as it was written.
import type { ReactNode } from 'react';

const INLINE = [
  { type: 'code', pattern: /`([^`\n]+)`/ },
  { type: 'bold', pattern: /\*\*([^\n]+?)\*\*/ },
  { type: 'italic', pattern: /\*([^*\s][^*\n]*?)\*/ },
  { type: 'link', pattern: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/ },
] as const;

function inline(text: string, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  while (rest) {
    let first: { type: (typeof INLINE)[number]['type']; match: RegExpExecArray } | null = null;
    for (const { type, pattern } of INLINE) {
      const match = pattern.exec(rest);
      if (match && (!first || match.index < first.match.index)) first = { type, match };
    }
    if (!first) { out.push(rest); break; }
    const { type, match } = first;
    if (match.index > 0) out.push(rest.slice(0, match.index));
    const key = out.length;
    // marks inside marks, but not without end: a hostile answer cannot make the page recurse deeply
    const inner = depth < 4 ? inline(match[1], depth + 1) : match[1];
    if (type === 'code') out.push(<code key={key}>{match[1]}</code>);
    else if (type === 'bold') out.push(<strong key={key}>{inner}</strong>);
    else if (type === 'italic') out.push(<em key={key}>{inner}</em>);
    else out.push(<a key={key} href={match[2]} target="_blank" rel="noreferrer noopener">{inner}</a>);
    rest = rest.slice(match.index + match[0].length);
  }
  return out;
}

/** The lines of a paragraph, each on its own line as the model wrote them. */
function lines(parts: string[]): ReactNode[] {
  return parts.flatMap((part, n) => (n ? [<br key={'br' + n} />, ...inline(part)] : inline(part)));
}

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
const starts = (line: string) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)
  || BULLET.test(line) || NUMBERED.test(line);

export function Markdown({ text }: { text: string }) {
  const source = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < source.length) {
    const line = source[i];
    const key = blocks.length;
    if (!line.trim()) { i += 1; continue; }
    if (FENCE.test(line)) {
      const body: string[] = [];
      i += 1;
      // an answer still being written has no closing fence yet: what is there is code all the same
      while (i < source.length && !FENCE.test(source[i])) { body.push(source[i]); i += 1; }
      i += 1;
      blocks.push(<pre key={key}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      // inside a card: the largest heading of an answer is still below the card's own title
      const Tag = heading[1].length === 1 ? 'h3' : heading[1].length === 2 ? 'h4' : 'h5';
      blocks.push(<Tag key={key}>{inline(heading[2])}</Tag>);
      i += 1;
      continue;
    }
    if (RULE.test(line)) { blocks.push(<hr key={key} />); i += 1; continue; }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < source.length && QUOTE.test(source[i])) { body.push(QUOTE.exec(source[i])![1]); i += 1; }
      blocks.push(<blockquote key={key}>{lines(body)}</blockquote>);
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const item = ordered ? NUMBERED : BULLET;
      const first = ordered ? Number(NUMBERED.exec(line)![1]) : 1;
      const items: string[][] = [];
      while (i < source.length) {
        const match = item.exec(source[i]);
        if (match) items.push([match[ordered ? 2 : 1]]);
        // a line indented under an item goes on with it
        else if (items.length && /^\s{2,}\S/.test(source[i]) && !starts(source[i].trim())) items[items.length - 1].push(source[i].trim());
        else break;
        i += 1;
      }
      const content = items.map((parts, n) => <li key={n}>{lines(parts)}</li>);
      blocks.push(ordered ? <ol key={key} start={first}>{content}</ol> : <ul key={key}>{content}</ul>);
      continue;
    }
    if (line.includes('|') && i + 1 < source.length && TABLE_RULE.test(source[i + 1]) && source[i + 1].includes('-')) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < source.length && source[i].includes('|') && source[i].trim()) { rows.push(cells(source[i])); i += 1; }
      blocks.push(<div className="md-table" key={key}><table>
        <thead><tr>{head.map((cell, n) => <th key={n}>{inline(cell)}</th>)}</tr></thead>
        <tbody>{rows.map((row, r) => <tr key={r}>{head.map((_, n) => <td key={n}>{inline(row[n] ?? '')}</td>)}</tr>)}</tbody>
      </table></div>);
      continue;
    }
    const body: string[] = [];
    while (i < source.length && source[i].trim() && !starts(source[i])) { body.push(source[i]); i += 1; }
    blocks.push(<p key={key}>{lines(body)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
