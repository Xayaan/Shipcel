// Inline markup shared by the site's pages and its docs.
export const escape = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// [label](https://…, /path, #anchor or guide.md#anchor) links, `code`, **bold** and _italic_
// (only around whole words, so snake_case names and code keep their underscores). A link to
// another guide's Markdown file goes to its page under /docs/.
export function inline(text: string) {
  return escape(
    text.replace(
      /\]\(([a-z0-9-]+)\.md(#[\w-]+)?\)/g,
      (_, slug: string, anchor = '') => `](/docs/${slug}/${anchor})`,
    ),
  )
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(
      /(^|[\s(>])_([^_<>\s][^_<>]*?)_(?=[\s.,;:!?)<]|$)/g,
      '$1<em>$2</em>',
    )
    .replace(
      /\[([^\]]+)\]\(((?:https:\/\/|\/|#)[^)\s]+)\)/g,
      (_, label: string, url: string) =>
        url.startsWith('https://')
          ? `<a href="${url}" rel="noreferrer">${label}</a>`
          : `<a href="${url}">${label}</a>`,
    );
}

// A guide's opening sentence: what it is for, on an index card or in /llms.txt.
export const firstSentence = (text: string) =>
  /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;

// A list of inline-markup items: ticked (checks), or a row of short claims (proof).
export const list = (items: string[], className = 'checks') =>
  `<ul class="${className}">${items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`;

// The same text without markup, for descriptions.
export const plain = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1');
