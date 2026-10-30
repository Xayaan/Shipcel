import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { markdown } from '../site/markdown';
import { guides } from '../site/docs';
import { renderSite } from '../site/render';

describe('docs markdown', () => {
  const doc = markdown(
    [
      '# Deploy from GitHub',
      '',
      'Pick a **repository** and `deploy` it. See [the CLI](cli.md#login) or [Cloudflare](https://developers.cloudflare.com/).',
      '',
      '## Before you start',
      '',
      '- One item',
      '  continued here',
      '- Two <items>',
      '',
      '1. First',
      '2. Second',
      '',
      '> Free-only blocks R2.',
      '',
      '```sh',
      'shipcel deploy --prod <dist>',
      '```',
      '',
      '| Command | What it does |',
      '| --- | --- |',
      '| `shipcel ls` | Lists [versions](#before-you-start) |',
      '',
      '## Before you start',
      '',
      'An _italic_ note, and `NATIVE_BUILDS_ENABLED`, `_worker.js` and deploy_command stay as they are.',
    ].join('\n'),
  );
  it('takes the title and description from the top of the guide', () => {
    expect(doc.title).toBe('Deploy from GitHub');
    expect(doc.description).toBe(
      'Pick a repository and deploy it. See the CLI or Cloudflare.',
    );
  });
  it('renders headings with unique anchors, lists, notes, code and tables', () => {
    expect(doc.headings).toEqual([
      { id: 'before-you-start', text: 'Before you start', level: 2 },
      { id: 'before-you-start-2', text: 'Before you start', level: 2 },
    ]);
    expect(doc.html).toContain(
      '<p>Pick a <strong>repository</strong> and <code>deploy</code> it. See <a href="/docs/cli/#login">the CLI</a> or <a href="https://developers.cloudflare.com/" rel="noreferrer">Cloudflare</a>.</p>',
    );
    expect(doc.html).toContain(
      '<ul><li>One item continued here</li><li>Two &lt;items&gt;</li></ul>',
    );
    expect(doc.html).toContain('<ol><li>First</li><li>Second</li></ol>');
    expect(doc.html).toContain(
      '<aside class="note"><p>Free-only blocks R2.</p></aside>',
    );
    expect(doc.html).toContain(
      '<pre class="code" tabindex="0"><code>shipcel deploy --prod &lt;dist&gt;</code></pre>',
    );
    expect(doc.html).toContain(
      '<td><code>shipcel ls</code></td><td>Lists <a href="#before-you-start">versions</a></td>',
    );
    expect(doc.html).toMatch(
      /<div class="table-wrap" role="region" aria-label="[^"]+" tabindex="0"><table>/,
    );
    expect(doc.html).not.toContain('<h1');
    expect(doc.html).toContain(
      '<p>An <em>italic</em> note, and <code>NATIVE_BUILDS_ENABLED</code>, <code>_worker.js</code> and deploy_command stay as they are.</p>',
    );
  });
});

describe('docs guides', () => {
  const files = readdirSync('docs/guides').filter((f) => f.endsWith('.md'));
  it('publishes every guide in docs/guides, in a section', () => {
    expect(guides.map((g) => `${g.slug}.md`).sort()).toEqual(files.sort());
    for (const g of guides) expect(g.section, g.slug).toBeTruthy();
  });
  it('gives each guide a title, a description and sections', () => {
    for (const file of files) {
      const doc = markdown(readFileSync(`docs/guides/${file}`, 'utf8'));
      expect(doc.title, file).toBeTruthy();
      expect(doc.description.length, file).toBeGreaterThan(60);
      expect(doc.headings.length, file).toBeGreaterThan(1);
    }
  });
  it('renders the docs index and a page per guide', () => {
    const pages = renderSite();
    expect(pages['docs/index.html']).toContain('<h1');
    for (const g of guides) {
      const page = pages[`docs/${g.slug}/index.html`];
      expect(page, g.slug).toContain(`aria-current="page"`);
      expect(page, g.slug).toContain(`href="/docs/${g.slug}/"`);
    }
  });
});
