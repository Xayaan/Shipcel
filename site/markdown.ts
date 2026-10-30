// The Markdown the guides in docs/guides use, as HTML: headings, paragraphs, lists,
// notes (>), fenced code and tables, with the inline markup of site/markup.ts. Guides are
// written for it; anything else is a paragraph.
import { escape, inline, plain } from './markup.ts';

export type Heading = { id: string; text: string; level: number };

const slugify = (text: string) =>
  plain(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export function markdown(source: string) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  let title = '';
  let description = '';
  let i = 0;
  // Lines that start a block of their own end a paragraph.
  const starts = (line: string) =>
    /^(#{1,4} |```|> |- |\d+\. |\|)/.test(line) || !line.trim();
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,4}) (.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      if (level === 1) title = plain(text);
      else {
        const base = slugify(text);
        const seen = (used.get(base) ?? 0) + 1;
        used.set(base, seen);
        const id = seen === 1 ? base : `${base}-${seen}`;
        headings.push({ id, text: plain(text), level });
        html.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      }
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```'))
        code.push(lines[i++]);
      i++;
      html.push(
        `<pre class="code" tabindex="0"><code>${escape(code.join('\n'))}</code></pre>`,
      );
      continue;
    }
    if (line.startsWith('> ')) {
      const note: string[] = [];
      while (i < lines.length && lines[i].startsWith('> '))
        note.push(lines[i++].slice(2));
      html.push(`<aside class="note"><p>${inline(note.join(' '))}</p></aside>`);
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|'))
        rows.push(
          lines[i++]
            .trim()
            .replace(/^\||\|$/g, '')
            .split(/(?<!\\)\|/)
            .map((cell) => cell.trim().replace(/\\\|/g, '|')),
        );
      const [head, , ...body] = rows;
      const label = plain(headings.at(-1)?.text ?? title);
      html.push(
        `<div class="table-wrap" role="region" aria-label="${escape(label)}" tabindex="0"><table><thead><tr>${head
          .map((c) => `<th scope="col">${inline(c)}</th>`)
          .join('')}</tr></thead><tbody>${body
          .map(
            (r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`,
          )
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    const item = /^(- |\d+\. )/.exec(line);
    if (item) {
      const ordered = item[1] !== '- ';
      const items: string[] = [];
      while (i < lines.length) {
        const next = /^(- |\d+\. )(.*)$/.exec(lines[i]);
        if (next && (next[1] !== '- ') === ordered) {
          items.push(next[2]);
          i++;
        } else if (items.length && /^ {2,}\S/.test(lines[i]))
          items[items.length - 1] += ` ${lines[i++].trim()}`;
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(
        `<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && (paragraph.length === 0 || !starts(lines[i])))
      paragraph.push(lines[i++].trim());
    const text = paragraph.join(' ');
    if (!description && title) description = plain(text);
    html.push(`<p>${inline(text)}</p>`);
  }
  return { title, description, headings, html: html.join('\n') };
}
