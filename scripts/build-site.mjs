// Writes the static public site (site/render.ts) into public/: its pages, /llms.txt and each
// guide as Markdown.
// Usage: npm run site:build [-- --check]   (--check: exit 1 when public/ is out of date)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { renderSite, renderTexts } from '../site/render.ts';

const check = process.argv.includes('--check');
const stale = [];
for (const [path, html] of Object.entries({
  ...renderSite(),
  ...renderTexts(),
})) {
  const file = join('public', path);
  if ((await readFile(file, 'utf8').catch(() => null)) === html) continue;
  stale.push(path);
  if (check) continue;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, html);
}
if (check && stale.length) {
  console.error(`Out of date: ${stale.join(', ')}. Run npm run site:build.`);
  process.exit(1);
}
console.log(
  check ? 'Public site is up to date.' : `Wrote ${stale.length} page(s).`,
);
