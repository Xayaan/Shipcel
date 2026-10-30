// Static public pages. scripts/build-site.mjs writes them into public/ (served at /, /pricing/,
// /why/, /compare/…); tests/site.test.ts fails when public/ is out of date.
// Plain TypeScript (no JSX) so Node can run it with --experimental-strip-types.
import type {
  Comparison,
  CostExample,
  Section,
  Source,
  Table,
} from './content.ts';
import {
  checkedOn,
  cloudflareFree,
  comparisons,
  costExamples,
  faqs,
  featureGroups,
  notYet,
  pricingSources,
  reasons,
  workersPaid,
} from './content.ts';

import { escape, firstSentence, inline, list } from './markup.ts';
import { docSections, guides, readGuide } from './docs.ts';
import { guideMarkdown, llmsTxt } from './llms.ts';
import { freePlanCards, homeBody } from './home.ts';
export { escape, inline };

const nav = [
  { href: '/features/', label: 'Features' },
  { href: '/pricing/', label: 'Pricing' },
  { href: '/why/', label: 'Why Shipcel' },
  { href: '/compare/', label: 'Compare' },
  { href: '/docs/', label: 'Docs' },
];

function layout(page: {
  path: string;
  title: string;
  description: string;
  body: string;
  // Stylesheets after site.css, for one page's own pictures.
  styles?: string[];
}) {
  const links = nav
    .map(
      (n) =>
        `<li><a href="${n.href}"${page.path.startsWith(n.href) ? ' aria-current="page"' : ''}>${n.label}</a></li>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(page.title)}</title>
<meta name="description" content="${escape(page.description)}">
<meta property="og:title" content="${escape(page.title)}">
<meta property="og:description" content="${escape(page.description)}">
<meta property="og:type" content="website">
<meta name="theme-color" content="#f8f9fb">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/site.css">
${(page.styles ?? []).map((href) => `<link rel="stylesheet" href="${href}">\n`).join('')}<script src="/analytics.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
<nav class="wrap" aria-label="Main">
<a class="brand" href="/"><img src="/favicon.svg" alt="" width="24" height="24">Shipcel</a>
<ul class="nav-links">${links}</ul>
<a class="button primary nav-cta" href="/app/">Dashboard</a>
</nav>
</header>
<main id="main" class="wrap">
${page.body}
</main>
<footer class="site-footer">
<div class="wrap footer-grid">
<div>
<p><strong>Shipcel</strong> deploys your apps into your own Cloudflare account.</p>
<p class="small">Prices and limits are list prices from each provider's official pages, checked ${escape(checkedOn)}. They change; each page links to its sources.</p>
</div>
<div>
<h2>Product</h2>
<ul><li><a href="/features/">Features</a></li><li><a href="/pricing/">Pricing and free plan</a></li><li><a href="/why/">Why Shipcel</a></li><li><a href="/app/">Dashboard</a></li></ul>
</div>
<div>
<h2>Learn</h2>
<ul><li><a href="/docs/">Docs</a></li><li><a href="/docs/cli/">CLI reference</a></li><li><a href="/compare/">Comparisons</a></li><li><a href="/privacy/">Privacy</a></li><li><a href="/why/#not-yet">What isn’t ready yet</a></li><li><a href="/llms.txt">llms.txt, for AI agents</a></li></ul>
</div>
</div>
</footer>
</body>
</html>
`;
}

function table(t: Table, id: string, kind = '') {
  const head = t.columns
    .map((c) => `<th scope="col">${inline(c)}</th>`)
    .join('');
  const rows = t.rows
    .map(
      (r) =>
        `<tr><th scope="row">${inline(r[0])}</th>${r
          .slice(1)
          .map((cell) => `<td>${inline(cell)}</td>`)
          .join('')}</tr>`,
    )
    .join('\n');
  return `<div class="table-wrap${kind ? ` ${kind}` : ''}" role="region" aria-labelledby="${id}" tabindex="0">
<table>
<caption id="${id}">${inline(t.caption)}</caption>
<thead><tr>${head}</tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>${t.note ? `\n<p class="small muted">${inline(t.note)}</p>` : ''}`;
}

function sources(items: Source[]) {
  return `<h2 id="sources">Sources</h2>
<p class="small muted">Checked ${escape(checkedOn)}. Prices change; confirm on each provider's page before you decide.</p>
<ol class="sources">${items.map((s) => `<li><a href="${s.url}" rel="noreferrer">${escape(s.label)}</a></li>`).join('')}</ol>`;
}

function example(e: CostExample) {
  return `<article class="card" id="${e.id}">
<h3>${inline(e.title)}</h3>
<p>${inline(e.scenario)}</p>
${table(
  {
    caption: 'Monthly cost',
    columns: ['Setup', 'Per month', 'How it adds up'],
    rows: e.options.map((o) => [o.name, o.monthly, o.lines.join(' ')]),
  },
  `${e.id}-table`,
  'cost',
)}
<p class="small muted">Assumptions: ${inline(e.assumptions.join(' '))}</p>
<p><strong>${inline(e.takeaway)}</strong></p>
</article>`;
}

function sections(items: Section[]) {
  return items
    .map(
      (s) => `<section aria-labelledby="${s.id}">
<h2 id="${s.id}">${inline(s.title)}</h2>
${s.paragraphs.map((p) => `<p>${inline(p)}</p>`).join('\n')}
${s.points ? list(s.points) : ''}
</section>`,
    )
    .join('\n');
}

export function landing() {
  return layout({
    path: '/',
    title: 'Shipcel: the no-code platform for your own Cloudflare',
    description:
      'Shipcel sets up and manages the Cloudflare side of your apps with no infrastructure code: git deploys, previews, domains, databases, storage and backups. Free, with Cloudflare’s own prices and no markup.',
    styles: ['/home.css'],
    body: homeBody(),
  });
}

export function pricing() {
  return layout({
    path: '/pricing/',
    title: 'Pricing and free plan | Shipcel',
    description:
      'Shipcel is free. Your apps run on Cloudflare’s free plan in your own account: 100,000 requests a day, free static files, D1, KV, R2 and builds. Full limits, Workers Paid and worked cost examples.',
    body: `<section class="hero" aria-labelledby="pricing-title">
<h1 id="pricing-title">Free to start. Cloudflare's prices after that.</h1>
<p class="lede">Shipcel charges nothing, as a launch offer: no plan, no card. Everything runs in your own Cloudflare account, so the only bill you can ever get is Cloudflare's, charged by Cloudflare at its list prices, with no markup.</p>
</section>
<section aria-labelledby="plans-title">
<h2 id="plans-title">The free plan</h2>
${freePlanCards(false)}
</section>
<section aria-labelledby="limits-title">
<h2 id="limits-title">Cloudflare's free and paid limits</h2>
<p class="section-intro">What your apps get in your Cloudflare account, and what Workers Paid ($5 a month per account) adds.</p>
${table({ caption: 'Cloudflare Workers Free and Workers Paid', columns: ['Service', 'Free plan', 'Workers Paid ($5/month per account)'], rows: cloudflareFree.map((r) => [r.service, r.free, r.paid]) }, 'limits-table')}
${list(workersPaid, 'checks')}
</section>
<section aria-labelledby="examples">
<h2 id="examples">Worked examples</h2>
<p class="section-intro">Real list prices, stated assumptions, and the arithmetic, so you can check every number.</p>
<div class="grid two">${costExamples.map(example).join('\n')}</div>
</section>
<section aria-labelledby="faq-title">
<h2 id="faq-title">Questions</h2>
${faqs.map((f) => `<details><summary>${inline(f.q)}</summary><p>${inline(f.a)}</p></details>`).join('\n')}
</section>
<section aria-labelledby="sources">
${sources(pricingSources)}
</section>`,
  });
}

const statusClass = {
  Built: 'built',
  Beta: 'beta',
  'Not yet': 'not-yet',
} as const;
export function features() {
  return layout({
    path: '/features/',
    title: 'Shipcel features: what is built and what is not yet',
    description:
      'Everything Shipcel does for apps in your own Cloudflare account: AI agents, Git, CLI and drag-and-drop deploys, pull request previews, one-click rollback, databases, sign-in, realtime, and what is not ready yet.',
    body: `<section class="hero" aria-labelledby="features-hero">
<h1 id="features-hero">What Shipcel does today</h1>
<p class="lede">Built means implemented, tested and run on live Cloudflare accounts. Beta rests on a Cloudflare feature still in beta, or hasn’t run against a live account yet. Not yet means exactly that.</p>
<ul class="jump small">${featureGroups
      .map((g) => `<li><a href="#${g.id}">${escape(g.title)}</a></li>`)
      .join('')}</ul>
</section>
${featureGroups
  .map(
    (g) => `<section aria-labelledby="${g.id}">
<h2 id="${g.id}">${escape(g.title)}</h2>
<div class="grid">${g.items
      .map(
        (i) =>
          `<article class="card"><span class="status ${statusClass[i.status]}">${escape(i.status)}</span><h3>${inline(i.title)}</h3><p>${inline(i.text)}</p></article>`,
      )
      .join('\n')}</div>
</section>`,
  )
  .join('\n')}
<section class="cta-band" aria-labelledby="features-cta">
<h2 id="features-cta">Try it on Cloudflare's free plan</h2>
<p>Shipcel is free, and your apps run in your own account.</p>
<a class="button" href="/app/">Open the dashboard</a>
</section>`,
  });
}

export function why() {
  return layout({
    path: '/why/',
    title: 'Why Shipcel: one platform, your account, predictable bills',
    description:
      'Why choose Shipcel: apps in your own Cloudflare account, one provider instead of a stack of services, a free plan that stops at its limits instead of billing, and no bandwidth fees for static files.',
    body: `<section class="hero" aria-labelledby="why-hero">
<h1 id="why-hero">One platform. Your account. Predictable bills.</h1>
<p class="lede">A typical web app spreads across a hosting platform, a database service, file storage and a cache, each with its own plan, limits and bill. Cloudflare runs all of them in one account; Shipcel makes that account as easy to use as a hosting platform.</p>
</section>
${sections(reasons.map((r) => ({ id: r.id, title: r.title, paragraphs: r.details, points: r.points })))}
<section aria-labelledby="not-yet">
<h2 id="not-yet">What Shipcel doesn't do yet</h2>
<p class="section-intro">Choosing a platform should not depend on guesses, so here is what is missing today.</p>
${list(notYet, 'checks')}
</section>
<section aria-labelledby="sources">
${sources(pricingSources)}
</section>`,
  });
}

export function compareIndex() {
  return layout({
    path: '/compare/',
    title: 'Compare Shipcel with Vercel, Supabase, Netlify, Firebase and more',
    description:
      'Honest comparisons of Shipcel with Vercel, Netlify, Supabase, Firebase, Render, Railway and Heroku: free tiers, paid prices, bandwidth, spending controls and features.',
    body: `<section class="hero" aria-labelledby="compare-hero">
<h1 id="compare-hero">Shipcel compared</h1>
<p class="lede">What each free plan includes and what happens when it runs out, the cheapest paid plan, and on each page what the same apps cost, how usage is billed, and where the other service is the better choice.</p>
</section>
<section aria-labelledby="compare-table">
${table(
  {
    caption: 'At a glance',
    columns: [
      'Service',
      'What it is',
      'Free plan',
      'When it runs out',
      'Paid entry',
    ],
    rows: [
      [
        '**Shipcel + Cloudflare**',
        'Deploys to your own Cloudflare account; Shipcel itself is free',
        'Static files unlimited; 100,000 server requests a day; D1 5 GB; R2 10 GB',
        'Server requests fail until midnight UTC; files keep serving; nothing is billed',
        'Shipcel free; Cloudflare’s Workers Paid $5 a month per account when an app needs it',
      ],
      ...comparisons.map((c) => [
        `[${c.name}](/compare/${c.slug}/)`,
        c.kind,
        c.freeTier,
        c.freeStops,
        c.paidEntry,
      ]),
    ],
  },
  'compare-table',
  'hub',
)}
<p class="small muted">Cloudflare's plans in full, with every rate, are on <a href="/pricing/">the pricing page</a>.</p>
</section>`,
  });
}

export function comparePage(c: Comparison) {
  // With a short answer, the numbers lead and the description introduces the choice.
  const answer = c.shortAnswer;
  return layout({
    path: `/compare/${c.slug}/`,
    title: `Shipcel vs ${c.name}: free tiers, pricing and features compared`,
    description: c.description,
    body: `<section class="hero" aria-labelledby="vs-title">
<h1 id="vs-title">Shipcel vs ${escape(c.name)}</h1>
<p class="lede">${inline(answer ? answer.verdict : c.summary)}</p>
</section>
${
  answer
    ? `<section aria-labelledby="answer-title">
<h2 id="answer-title">The short answer</h2>
${answer.tables.map((t, i) => table(t, `answer-${i}`, 'answer')).join('\n')}
<p class="small muted">${inline(answer.note)}</p>
</section>`
    : ''
}
<section aria-labelledby="choose-title">
<h2 id="choose-title">Which one fits</h2>
${answer ? `<p class="section-intro">${inline(c.summary)}</p>` : ''}
<div class="grid two">
<article class="card featured"><h3>Choose Shipcel if</h3>${list(c.chooseUs)}</article>
<article class="card"><h3>Choose ${escape(c.name)} if</h3>${list(c.chooseThem)}</article>
</div>
</section>
<section aria-labelledby="details-title">
<h2 id="details-title">Side by side</h2>
${c.tables.map((t, i) => table(t, `table-${i}`)).join('\n')}
</section>
${
  c.examples.length
    ? `<section aria-labelledby="cost-title">
<h2 id="cost-title">What it costs</h2>
<div class="grid two">${c.examples.map(example).join('\n')}</div>
</section>`
    : ''
}
<section aria-labelledby="bills-title">
<h2 id="bills-title">Billing and surprise-bill protection</h2>
${list(c.billing, 'checks')}
</section>
<section aria-labelledby="moving-title">
<h2 id="moving-title">Moving from ${escape(c.name)}</h2>
${list(c.moving, 'checks')}
</section>
<section aria-labelledby="sources">
${sources(c.sources)}
</section>`,
  });
}

// What shipcel.com keeps and does with it, stated from the code: the users table, the two
// cookies worker/auth.ts sets, worker/analytics.ts, and the grants and tokens tables.
const privacySections: Section[] = [
  {
    id: 'where',
    title: 'Where your data lives',
    paragraphs: [
      'Shipcel is a control panel. The apps you deploy, with their databases, files and logs, live in your own Cloudflare account, under Cloudflare’s terms, not with Shipcel. This page is about the little that shipcel.com itself keeps.',
    ],
  },
  {
    id: 'account',
    title: 'What Shipcel keeps about you',
    paragraphs: [
      'When you sign in with GitHub, Shipcel stores your GitHub user ID and username, and when you joined. It stores no email address and no password: there is no password.',
    ],
    points: [
      'Your workspaces and projects, and a record of each deployment: names, versions, addresses, what Shipcel did and whether it worked.',
      'The GitHub and Cloudflare access you grant, as tokens encrypted with a key held only by shipcel.com, used only to do what you ask: read the repositories you connect, create and deploy Workers, databases and storage in the account you choose, and read your apps’ analytics, logs and plan.',
      'API tokens and CLI sign-in codes as hashes, never in the clear. The `shipcel` command keeps its token in `~/.config/shipcel/config.json` on your computer, readable only by you.',
      'Webhooks you add: their address, and each delivery’s payload, which names the deployment and its outcome.',
      'Invitations: the GitHub username you invite and the role.',
      'Secrets you set for an app go straight to Cloudflare. Shipcel keeps no copy, and never shows them again.',
    ],
  },
  {
    id: 'cookies',
    title: 'Cookies',
    paragraphs: [
      'The dashboard sets one cookie, `__Host-cloudcel_session`, which keeps you signed in; signing out removes it. During a GitHub sign-in a second cookie, `cloudcel_github_return`, remembers for an hour which page to return you to. The public site sets no cookies. There are no advertising or third-party cookies.',
    ],
  },
  {
    id: 'analytics',
    title: 'How visitors are counted',
    paragraphs: [
      'shipcel.com uses [PostHog](https://posthog.com/privacy), cookieless: nothing is stored in your browser, and PostHog counts visitors by a hash of your address and browser that changes every day, so it can’t follow you from one day to the next. Its requests go to `shipcel.com/ingest`, which forwards them to PostHog in the United States with your address and without your cookies.',
      'On the public site it records the pages viewed and clicks. In the dashboard no PostHog script runs at all: Shipcel’s own code sends which pages are opened and a few named events, such as a project being created, with the framework chosen and nothing that identifies you. Blocking `shipcel.com/ingest` in your browser stops it, and the site works the same.',
    ],
  },
  {
    id: 'logs',
    title: 'Server logs',
    paragraphs: [
      'shipcel.com runs on Cloudflare, which keeps its request logs (your address, the page requested, the status) for up to 7 days. Shipcel reads them only to find faults and abuse.',
    ],
  },
  {
    id: 'sharing',
    title: 'Who else sees it',
    paragraphs: [
      'Nobody buys your data, and nobody else sees it. Shipcel talks to GitHub and Cloudflare with the access you granted, to do what you asked; to PostHog as above; and to the webhook addresses you configure. Shipcel shows no advertising.',
    ],
  },
  {
    id: 'control',
    title: 'Your control',
    paragraphs: [],
    points: [
      'Disconnect GitHub or Cloudflare under Connections: the tokens are erased at once.',
      'Delete a project: Shipcel’s records go; the app and its data stay in your Cloudflare account.',
      'Revoke an API token under API & CLI.',
      'To delete your account and everything Shipcel keeps about you, email info@shipcel.com from the GitHub account you signed in with. Your Cloudflare account is untouched.',
    ],
  },
  {
    id: 'self-hosted',
    title: 'A Shipcel you run yourself',
    paragraphs: [
      'This page describes shipcel.com. Someone who runs Shipcel on their own account is its operator and holds that data themselves; their copy sends no analytics unless they set a PostHog key.',
    ],
  },
];

export function privacy() {
  return layout({
    path: '/privacy/',
    title: 'Privacy | Shipcel',
    description:
      'What shipcel.com stores about you, which cookies it sets, how it counts visitors without cookies, who else sees anything, and how to delete your data.',
    body: `<section class="hero" aria-labelledby="privacy-title">
<h1 id="privacy-title">What Shipcel keeps, and what it doesn’t</h1>
<p class="lede">Your apps and their data live in your own Cloudflare account. Shipcel keeps what it needs to sign you in and act for you, counts visitors without cookies, and sells nothing.</p>
</section>
${sections(privacySections)}
<section aria-labelledby="privacy-contact">
<h2 id="privacy-contact">Questions</h2>
<p>Write to info@shipcel.com. This page was last changed on 28 October 2026, and changes to it are recorded in Shipcel’s repository.</p>
</section>`,
  });
}

export function notFound() {
  return layout({
    path: '/404',
    title: 'Page not found | Shipcel',
    description:
      'The page you asked for doesn’t exist. Go to Shipcel’s home page, pricing and free plan, or the dashboard.',
    body: `<section class="hero" aria-labelledby="nf-title">
<h1 id="nf-title">Page not found</h1>
<p class="lede">The page you asked for does not exist.</p>
<div class="actions"><a class="button primary" href="/">Go to the home page</a><a class="button" href="/app/">Open the dashboard</a></div>
</section>`,
  });
}

// The docs: an index by section, and a page per guide with every guide alongside.
const loaded = () => guides.map((g) => ({ ...g, ...readGuide(g.slug) }));
function docsNav(current?: string) {
  const docs = loaded();
  return `<nav class="docs-nav" aria-label="Docs">
${docSections
  .map(
    (section) => `<p class="docs-section">${escape(section)}</p>
<ul>${docs
      .filter((d) => d.section === section)
      .map(
        (d) =>
          `<li><a href="/docs/${d.slug}/"${d.slug === current ? ' aria-current="page"' : ''}>${escape(d.title)}</a></li>`,
      )
      .join('')}</ul>`,
  )
  .join('\n')}
</nav>`;
}

export function docsIndex() {
  const docs = loaded();
  return layout({
    path: '/docs/',
    title: 'Docs | Shipcel',
    description:
      'Guides for Shipcel: deploy from GitHub, the shipcel CLI, drag-and-drop uploads, previews and rollbacks, domains, secrets, databases, logs, teams, AI agents and running Shipcel yourself.',
    body: `<div class="docs">
${docsNav()}
<div class="doc">
<h1>Shipcel docs</h1>
<p class="lede">Everything Shipcel does, step by step: from your first deploy to running Shipcel yourself. Shipcel puts your apps in your own Cloudflare account, so each guide also says what happens there.</p>
${docSections
  .map(
    (
      section,
    ) => `<section aria-labelledby="${section.toLowerCase().replace(/[^a-z]+/g, '-')}">
<h2 id="${section.toLowerCase().replace(/[^a-z]+/g, '-')}">${escape(section)}</h2>
<div class="grid two">${docs
      .filter((d) => d.section === section)
      .map(
        (d) =>
          `<a class="card doc-card" href="/docs/${d.slug}/"><strong>${escape(d.title)}</strong><span>${escape(firstSentence(d.description))}</span></a>`,
      )
      .join('')}</div>
</section>`,
  )
  .join('\n')}
</div>
</div>`,
  });
}

export function docPage(slug: string) {
  const docs = loaded();
  const index = docs.findIndex((d) => d.slug === slug);
  const doc = docs[index];
  const [previous, next] = [docs[index - 1], docs[index + 1]];
  const sections = doc.headings.filter((h) => h.level === 2);
  return layout({
    path: `/docs/${slug}/`,
    title: `${doc.title} | Shipcel docs`,
    description: doc.description,
    body: `<div class="docs">
${docsNav(slug)}
<article class="doc">
<nav class="crumbs" aria-label="Breadcrumb"><a href="/docs/">Docs</a><span aria-hidden="true">/</span><span>${escape(doc.section)}</span></nav>
<h1>${escape(doc.title)}</h1>
${
  sections.length > 2
    ? `<nav class="toc" aria-label="On this page"><p>On this page</p><ul>${sections
        .map((h) => `<li><a href="#${h.id}">${escape(h.text)}</a></li>`)
        .join('')}</ul></nav>`
    : ''
}
${doc.html}
<nav class="doc-pager" aria-label="More guides">${
      previous
        ? `<a href="/docs/${previous.slug}/"><span>Previous</span>${escape(previous.title)}</a>`
        : '<span></span>'
    }${
      next
        ? `<a class="next" href="/docs/${next.slug}/"><span>Next</span>${escape(next.title)}</a>`
        : ''
    }</nav>
</article>
</div>`,
  });
}

// Output paths, relative to public/.
export function renderSite(): Record<string, string> {
  return {
    'index.html': landing(),
    '404.html': notFound(),
    'features/index.html': features(),
    'pricing/index.html': pricing(),
    'why/index.html': why(),
    'privacy/index.html': privacy(),
    'compare/index.html': compareIndex(),
    ...Object.fromEntries(
      comparisons.map((c) => [`compare/${c.slug}/index.html`, comparePage(c)]),
    ),
    'docs/index.html': docsIndex(),
    ...Object.fromEntries(
      guides.map((g) => [`docs/${g.slug}/index.html`, docPage(g.slug)]),
    ),
  };
}

// Text beside the pages, for AI agents: /llms.txt, and each guide as Markdown.
export function renderTexts(): Record<string, string> {
  return {
    'llms.txt': llmsTxt(),
    ...Object.fromEntries(
      guides.map((g) => [`docs/${g.slug}.md`, guideMarkdown(g.slug)]),
    ),
  };
}
