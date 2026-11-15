import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from '#test';
import { Markdown } from './Markdown';

afterEach(cleanup);
const draw = (text: string) => render(<Markdown text={text} />).container.querySelector('.md') as HTMLElement;

describe('the Markdown of an answer', () => {
  it('draws headings, lists, bold, italic, code and paragraphs', () => {
    const md = draw('# 总结\n\n这是**重点**和*强调*，还有 `code`。\n第二行\n\n- 第一项\n- 第二项\n  接着说\n\n3. 三\n4. 四');
    expect(md.querySelector('h3')?.textContent).toBe('总结');
    expect(md.querySelector('strong')?.textContent).toBe('重点');
    expect(md.querySelector('em')?.textContent).toBe('强调');
    expect(md.querySelector('p code')?.textContent).toBe('code');
    expect(md.querySelectorAll('p br')).toHaveLength(1);
    expect(Array.from(md.querySelectorAll('ul li'), li => li.textContent)).toEqual(['第一项', '第二项接着说']);
    expect(md.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(md.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('draws tables, quotes, rules and code blocks', () => {
    const md = draw('| 时间 | 事项 |\n|---|:--:|\n| 周五 | **开会** |\n| 周六 |\n\n> 引用一\n> 引用二\n\n---\n\n```js\nconst a = "<b>";\n```');
    expect(Array.from(md.querySelectorAll('th'), th => th.textContent)).toEqual(['时间', '事项']);
    expect(md.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(md.querySelector('td strong')?.textContent).toBe('开会');
    // a short row is filled out, so the table keeps its shape
    expect(md.querySelectorAll('tbody tr')[1].querySelectorAll('td')).toHaveLength(2);
    expect(md.querySelector('blockquote')?.textContent).toBe('引用一引用二');
    expect(md.querySelector('hr')).not.toBeNull();
    expect(md.querySelector('pre code')?.textContent).toBe('const a = "<b>";');
  });

  it('shows an answer still being written, whose code block is not closed yet', () => {
    const md = draw('看这段：\n```\nline 1\nline 2');
    expect(md.querySelector('pre code')?.textContent).toBe('line 1\nline 2');
  });

  it('never turns the text into markup', () => {
    const md = draw('<img src=x onerror="alert(1)"> <script>alert(2)</script>\n\n[点我](javascript:alert(3)) [站点](https://example.com/a?b=1)\n\n**<b onclick="x()">粗</b>**');
    expect(md.querySelector('img, script, b')).toBeNull();
    expect(md.textContent).toContain('<img src=x onerror="alert(1)">');
    const links = Array.from(md.querySelectorAll('a'));
    expect(links.map(a => a.getAttribute('href'))).toEqual(['https://example.com/a?b=1']);
    expect(links[0].getAttribute('rel')).toBe('noreferrer noopener');
    expect(md.textContent).toContain('[点我](javascript:alert(3))');
  });

  it('leaves the citation labels of a WeChat excerpt as they are', () => {
    const md = draw('对方说周五开会 [12@1700000000]，你答应了 [13@1700000060]。');
    expect(md.querySelector('a')).toBeNull();
    expect(md.textContent).toBe('对方说周五开会 [12@1700000000]，你答应了 [13@1700000060]。');
  });

  it('stays quick and flat on marks nested without end', () => {
    const md = draw('**'.repeat(2000) + 'x' + '*'.repeat(3000));
    expect(md.textContent?.includes('x')).toBe(true);
  });
});
