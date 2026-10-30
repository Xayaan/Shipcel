import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { renderSite, renderTexts, inline, escape } from '../site/render';
import { guides } from '../site/docs';
import { MEDIA_HOST } from '../site/media';
import { demoOutput, demoProduction } from '../site/home';
import {
  cf,
  shipcelFree,
  cloudflareFree,
  comparisons,
  costExamples,
  featureGroups,
  notYet,
} from '../site/content';

const pages = renderSite();
const paths = Object.keys(pages);
const urlFor = (path: string) =>
  path === 'index.html' ? '/' : `/${path.replace(/index\.html$/, '')}`;
const known = new Set([
  ...paths.map(urlFor),
  '/app/',
  '/favicon.svg',
  '/site.css',
  '/home.css',
  '/llms.txt',
]);

describe('public site', () => {
  it('is generated: public/ matches the renderer (run npm run site:build)', () => {
    for (const [path, html] of Object.entries({ ...pages, ...renderTexts() }))
      expect(readFileSync(`public/${path}`, 'utf8'), path).toBe(html);
  });

  it('gives every page a unique title, a description, one h1, and only the analytics script', () => {
    const titles = new Set<string>();
    for (const [path, html] of Object.entries(pages)) {
      const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
      expect(title, path).toBeTruthy();
      expect(titles.has(title!), `${path} repeats ${title}`).toBe(false);
      titles.add(title!);
      const description = html.match(
        /<meta name="description" content="([^"]+)">/,
      )?.[1];
      expect(description?.length, path).toBeGreaterThan(50);
      expect(html.match(/<h1[ >]/g)?.length, path).toBe(1);
      // The CSP allows only same-origin scripts. The public site's only one is Shipcel's visitor
      // analytics (worker/analytics.ts), which loads nothing unless shipcel.com is set up for it.
      expect(html.match(/<script[^>]*>/gi), path).toEqual([
        '<script src="/analytics.js" defer>',
      ]);
      expect(html, path).toContain(
        '<script src="/analytics.js" defer></script>',
      );
      expect(html, path).not.toMatch(/\sstyle="|\son\w+="/i);
    }
  });

  it('links only to pages that exist, anchors that exist, and https sources', () => {
    for (const [path, html] of Object.entries(pages))
      for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
        if (href.startsWith('https://')) continue;
        if (href.startsWith('#')) {
          expect(html, `${path}: ${href}`).toContain(`id="${href.slice(1)}"`);
          continue;
        }
        expect(href.startsWith('/'), `${path}: ${href}`).toBe(true);
        const [target, anchor] = href.split('#');
        expect(known.has(target), `${path}: ${href}`).toBe(true);
        const file = paths.find((p) => urlFor(p) === target);
        if (anchor && file)
          expect(pages[file], `${path}: ${href}`).toContain(`id="${anchor}"`);
      }
  });

  it('loads every image, video and poster from a file in public/, or the tour from R2', () => {
    for (const [path, html] of Object.entries(pages))
      for (const [, attribute, src] of html.matchAll(
        /\s(src|poster)="([^"]+)"/g,
      )) {
        // The tour is in R2 (npm run media:publish), from the files in media/.
        if (src.startsWith(`https://${MEDIA_HOST}/`)) {
          const file = `media/${src.slice(MEDIA_HOST.length + 9)}`;
          expect(existsSync(file), `${path}: ${src}`).toBe(true);
          continue;
        }
        expect(src.startsWith('/'), `${path}: ${attribute}=${src}`).toBe(true);
        // The Worker answers /analytics.js itself (worker/analytics.ts).
        if (src === '/analytics.js') continue;
        expect(existsSync(`public${src}`), `${path}: ${src}`).toBe(true);
      }
  });

  it('shows a deploy on the front page in the words the CLI prints, and lets it be paused', () => {
    const home = pages['index.html'];
    for (const line of [...demoOutput, demoProduction])
      expect(home).toContain(escape(line));
    // A first deploy of a Vite app, as packages/cli/src/cli.ts prints it (some prompts left out).
    expect(demoOutput).toEqual([
      'Set up and deploy “~/shop”? [Y/n] y',
      'Detected Vite (Build Command: npm run build, Output Directory: dist)',
      'Building: npm run build',
      'Uploading 12 of 12 new files…',
      'Deployed 12 files (12 new) to shop.',
    ]);
    expect(demoProduction).toBe('Production: https://shop.ada.workers.dev/');
    const cli = readFileSync('packages/cli/src/cli.ts', 'utf8');
    for (const wording of [
      'Set up and deploy “',
      '”? [Y/n] ',
      ': `Detected ${settings.preset} (${summary})`',
      'Build Command: ',
      ', Output Directory: ',
      "step('Building'",
      'new files…',
      '`Deployed ${',
      ' new${',
      '`Production: ${',
    ])
      expect(cli, wording).toContain(wording);
    // The moving picture is hidden from screen readers, which read its caption; it pauses,
    // and stands still for reduced motion with every line showing.
    expect(home).toContain('<div class="demo-stage" aria-hidden="true">');
    expect(home).toContain(
      '<input type="checkbox" id="demo-pause"><label for="demo-pause">Pause the animation</label>',
    );
    expect(home).toMatch(
      /<figure class="demo">[\s\S]*?<figcaption>One command/,
    );
    const css = readFileSync('public/home.css', 'utf8');
    expect(css).toContain(
      '.demo:has(#demo-pause:checked) .demo-stage * {\n  animation-play-state: paused;',
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.demo-stage \* \{\s*animation: none !important;/,
    );
    // Text appears with visibility, never half transparent.
    const frames = [
      ...css.matchAll(/@keyframes (demo-[\w-]+) \{([\s\S]*?)\n\}/g),
    ];
    expect(frames.length).toBeGreaterThan(8);
    for (const [, name, body] of frames)
      expect(body, name).not.toMatch(/opacity: 0?\.\d/);
  });

  it('offers the tour as a video that waits to be played, with a poster and its steps in words', () => {
    const home = pages['index.html'];
    const video = home.match(/<video [^>]*>/)?.[0] ?? '';
    expect(video).toContain(' controls ');
    expect(video).toContain('preload="none"');
    expect(video).toContain('poster="https://media.shipcel.com/tour.webp"');
    expect(home).toContain(
      '<source src="https://media.shipcel.com/tour.webm" type="video/webm">',
    );
    expect(video).toContain('aria-describedby="tour-steps"');
    expect(video).not.toContain('autoplay');
    expect(home).toContain('<ol class="tour-steps" id="tour-steps">');
    expect(home).toContain('recorded with sample data');
    expect(home).toContain('<a class="button" href="#tour">Watch the tour</a>');
    // It loads only when played; still, keep it small.
    expect(statSync('media/tour.webm').size).toBeLessThan(8 * 1024 * 1024);
  });

  it('opens external links without a referrer', () => {
    for (const [path, html] of Object.entries(pages))
      for (const [tag] of html.matchAll(/<a href="https:[^>]+>/g))
        expect(tag, path).toContain('rel="noreferrer"');
  });

  it('shows no Markdown link the renderer left unconverted', () => {
    for (const [path, html] of Object.entries(pages))
      expect(html, path).not.toMatch(
        /\]\((?:https?:|\/|#|\.{1,2}\/|[\w-]+\.md)/,
      );
  });

  it('points AI agents to the CLI, the MCP server and every guide in Markdown (/llms.txt)', () => {
    const texts = renderTexts();
    const llms = texts['llms.txt'];
    expect(llms).toMatch(/^# Shipcel\n\n> /);
    for (const phrase of [
      'shipcel login',
      'SHIPCEL_TOKEN',
      'shipcel --prod',
      'https://shipcel.com/mcp',
    ])
      expect(llms).toContain(phrase);
    for (const g of guides) {
      expect(llms, g.slug).toContain(`(https://shipcel.com/docs/${g.slug}.md)`);
      expect(texts[`docs/${g.slug}.md`], g.slug).toBe(
        readFileSync(`docs/guides/${g.slug}.md`, 'utf8'),
      );
    }
    expect(pages['index.html']).toContain('href="/llms.txt"');
  });

  it('backs every comparison with official sources and both sides of the choice', () => {
    expect(comparisons.length).toBeGreaterThanOrEqual(6);
    for (const c of comparisons) {
      expect(c.sources.length, c.slug).toBeGreaterThanOrEqual(3);
      for (const s of c.sources) expect(s.url, c.slug).toMatch(/^https:\/\//);
      expect(c.chooseUs.length, c.slug).toBeGreaterThan(1);
      expect(c.chooseThem.length, c.slug).toBeGreaterThan(1);
      for (const t of [...c.tables, ...(c.shortAnswer?.tables ?? [])])
        for (const row of t.rows)
          expect(row.length, `${c.slug}: ${t.caption}`).toBe(t.columns.length);
    }
  });

  it('answers what it costs and how far the free plan goes first, for Vercel and Netlify', () => {
    for (const slug of ['vercel', 'netlify']) {
      const c = comparisons.find((x) => x.slug === slug)!;
      expect(c.shortAnswer, slug).toBeDefined();
      expect(
        c.shortAnswer!.tables.map((t) => t.caption),
        slug,
      ).toEqual(['What you pay a month', 'How far the free plan goes']);
      // Every size has a price on both sides.
      for (const row of c.shortAnswer!.tables[0].rows)
        for (const cell of row.slice(1)) expect(cell, slug).toMatch(/\$\d/);
      expect(c.shortAnswer!.verdict, slug).toMatch(/\$\d/);
      const html = pages[`compare/${slug}/index.html`];
      const at = (text: string) => {
        const i = html.indexOf(text);
        expect(i, `${slug}: ${text}`).toBeGreaterThan(0);
        return i;
      };
      expect(at('The short answer')).toBeLessThan(at('Which one fits'));
      expect(at(inline(c.shortAnswer!.verdict))).toBeLessThan(
        at('The short answer'),
      );
    }
    // The numbers come from the pages the comparison cites.
    const vercel = JSON.stringify(
      comparisons.find((c) => c.slug === 'vercel')!.shortAnswer,
    );
    expect(vercel).toContain('100 GB');
    expect(vercel).toContain('30 days');
    const netlify = JSON.stringify(
      comparisons.find((c) => c.slug === 'netlify')!.shortAnswer,
    );
    expect(netlify).toContain('20 credits');
    expect(netlify).toContain('300 credits');
  });

  it('keeps the comparison index scannable: short cells, and what happens when the free plan runs out', () => {
    for (const c of comparisons)
      for (const [field, text] of [
        ['freeTier', c.freeTier],
        ['freeStops', c.freeStops],
        ['paidEntry', c.paidEntry],
      ] as const)
        expect(text.length, `${c.slug} ${field}: ${text}`).toBeLessThanOrEqual(
          90,
        );
    const index = pages['compare/index.html'];
    expect(index).toContain('When it runs out');
    // Shipcel's own row comes first, so every other row reads against it.
    expect(index.indexOf('<strong>Shipcel + Cloudflare</strong>')).toBeLessThan(
      index.indexOf('href="/compare/vercel/"'),
    );
  });

  it('shows worked examples with their assumptions', () => {
    expect(costExamples.length).toBeGreaterThanOrEqual(3);
    for (const e of costExamples) {
      expect(e.assumptions.length, e.id).toBeGreaterThan(0);
      expect(e.options.length, e.id).toBeGreaterThan(1);
    }
  });

  it('presents Shipcel on the front page without naming other companies', () => {
    const home = pages['index.html'];
    for (const name of [
      'Vercel',
      'Netlify',
      'Supabase',
      'Firebase',
      'Render',
      'Railway',
      'Heroku',
    ])
      expect(home, name).not.toContain(name);
    expect(home).toContain('From side project to enterprise');
    expect(home).toContain('no infrastructure code');
    expect(home).toContain('no markup');
  });

  it('includes sign-in and realtime, with what they use of the free plan and sources', () => {
    expect(pages['index.html']).toContain('Sign-in and realtime');
    for (const slug of ['supabase', 'firebase']) {
      const rows = comparisons.find((c) => c.slug === slug)!.tables[0].rows;
      const ours = (label: string) => rows.find((r) => r[0] === label)?.[1];
      expect(ours('Sign-in'), slug).toMatch(
        /^Included: passkeys, GitHub and Google\b.*100,000 daily Worker requests/,
      );
      expect(ours('Realtime'), slug).toMatch(/^Included: .*Durable Objects/);
    }
    for (const c of comparisons)
      if (JSON.stringify(c).includes('Durable Objects'))
        expect(
          c.sources.map((s) => s.url),
          c.slug,
        ).toContain(cf.durableObjects.url);
    expect(notYet.join(' ')).not.toContain('No built-in user sign-in');
  });

  it('offers four ways to start on the front page', () => {
    const home = pages['index.html'];
    expect(home).toContain('Start your way');
    for (const way of [
      'Build with your AI agent',
      'Deploy from Git',
      'Deploy from your terminal',
      'Drag and drop',
    ])
      expect(home, way).toContain(way);
    expect(home).toContain('every pull request gets its own preview address');
    expect(home).toContain('Roll back any deploy in one click');
    expect(home).toContain('href="/features/"');
  });

  it('lists every feature on /features/ with an honest status, naming no other platform', () => {
    const features = pages['features/index.html'];
    expect(features).toBeTruthy();
    for (const name of [
      'Vercel',
      'Netlify',
      'Supabase',
      'Firebase',
      'Render',
      'Railway',
      'Heroku',
    ])
      expect(features, name).not.toContain(name);
    const statuses = featureGroups.flatMap((g) => g.items.map((i) => i.status));
    expect(new Set(statuses)).toEqual(new Set(['Built', 'Beta', 'Not yet']));
    for (const group of featureGroups)
      for (const item of group.items)
        expect(features, item.title).toContain(inline(item.title));
    // Previews rest on Cloudflare's beta, and say so.
    expect(
      featureGroups
        .flatMap((g) => g.items)
        .find((i) => i.title.includes('pull request'))!.status,
    ).toBe('Beta');
  });

  it('keeps competitor facts current, each with its official source', () => {
    const page = (slug: string) => comparisons.find((c) => c.slug === slug)!;
    const text = (slug: string) => JSON.stringify(page(slug).tables);
    const sourced = (slug: string, url: string) =>
      expect(
        page(slug).sources.map((s) => s.url),
        `${slug} cites ${url}`,
      ).toContain(url);
    // Netlify Database replaced the Neon-based beta (GA 28 April 2026).
    expect(JSON.stringify(page('netlify'))).not.toMatch(
      /on Neon|built on Neon/,
    );
    expect(text('netlify')).toContain('3 databases of 5 GB');
    sourced(
      'netlify',
      'https://docs.netlify.com/build/data-and-storage/netlify-database/',
    );
    // Identity's 2025 deprecation was reversed on 19 February 2026.
    expect(text('netlify')).toContain('Netlify Identity');
    // Split testing can't be added to new projects since 26 August 2026.
    expect(text('netlify')).toContain('since August 2026');
    sourced(
      'netlify',
      'https://docs.netlify.com/manage/monitoring/split-testing/',
    );
    // Vercel Authentication is free on every plan since 9 September 2026.
    expect(text('vercel')).toContain('Vercel Authentication');
    sourced(
      'vercel',
      'https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan',
    );
    expect(text('vercel')).toContain('100 per project');
    sourced('vercel', 'https://vercel.com/docs/cron-jobs/usage-and-pricing');
    // Supabase passkeys are an experimental beta.
    expect(text('supabase')).toContain('passkeys in beta');
    sourced('supabase', 'https://supabase.com/docs/guides/auth/passkeys');
    // Shipcel's own rows match what it does now.
    for (const slug of ['vercel', 'netlify'])
      expect(text(slug), slug).toMatch(/your own AI agent/i);
    expect(text('vercel')).toContain('pull request');
  });

  // The pages as a reader meets them: the main content's words (what is folded away in a
  // <details> left out), and each paragraph's.
  const content = (path: string) =>
    pages[path]
      .replace(/<header[\s\S]*?<\/header>/, '')
      .replace(/<footer[\s\S]*?<\/footer>/, '')
      .replace(/<details[\s\S]*?<\/details>/g, '');
  const words = (html: string) =>
    html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/g, ' ')
      .trim()
      .split(/\s+/).length;
  const paragraphs = (html: string) =>
    [...html.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)].map((m) => m[1]);

  it('reads in short paragraphs, with the front page under 1,250 words', () => {
    // The pricing page carries the limits table and four worked examples; its questions
    // are folded away.
    const budgets: Record<string, number> = {
      'index.html': 1250,
      'features/index.html': 1100,
      'pricing/index.html': 1500,
      'why/index.html': 1120,
    };
    for (const [path, budget] of Object.entries(budgets)) {
      const html = content(path);
      expect(words(html), path).toBeLessThanOrEqual(budget);
      for (const p of paragraphs(html))
        expect(words(p), `${path}: ${p.slice(0, 60)}`).toBeLessThanOrEqual(70);
    }
    for (const item of featureGroups.flatMap((g) => g.items))
      expect(words(item.text), item.title).toBeLessThanOrEqual(60);
    // No section of the front page repeats its title.
    const home = content('index.html');
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(home)![1];
    for (const [, h2] of home.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g))
      expect(h2).not.toBe(h1);
  });

  it('states each Cloudflare free limit once on the pricing page', () => {
    const pricing = content('pricing/index.html');
    // In the table's free column, and in its paid column when the two are the same.
    for (const row of cloudflareFree)
      expect(pricing.split(inline(row.free)).length - 1, row.service).toBe(
        row.paid === row.free ? 2 : 1,
      );
  });

  it('has a privacy page that states what the code does, linked from every page', () => {
    const privacy = pages['privacy/index.html'];
    expect(privacy).toBeTruthy();
    for (const fact of [
      // Sign-in keeps a GitHub id and username, no email address.
      'GitHub user ID and username',
      'no email address',
      // The two cookies the Worker sets, and nothing else.
      '__Host-cloudcel_session',
      'cloudcel_github_return',
      // Analytics: PostHog, cookieless, through this origin.
      'PostHog',
      'cookieless',
      '/ingest',
      // Provider tokens are encrypted; secrets go to Cloudflare and aren’t kept.
      'encrypted',
      'info@shipcel.com',
    ])
      expect(privacy, fact).toContain(fact);
    for (const [path, html] of Object.entries(pages))
      if (!path.startsWith('404'))
        expect(html, path).toContain('href="/privacy/"');
  });

  it('says what alpha means truthfully: deploys have run live', () => {
    for (const path of ['index.html', 'features/index.html', 'why/index.html'])
      expect(pages[path], path).not.toContain('not yet been verified');
    expect(pages['index.html']).toContain('real Cloudflare accounts');
  });

  it('puts the free plan, with the Cloudflare free limits, on the front page', () => {
    const home = pages['index.html'];
    expect(home).toContain('Up to 100 projects');
    for (const row of cloudflareFree) expect(home).toContain(inline(row.free));
    for (const item of shipcelFree) expect(home).toContain(inline(item));
    expect(home).toContain('Alpha');
  });
});
