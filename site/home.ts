// The front page (/): what Shipcel is, how it works, the ways to deploy, a tour of the
// dashboard, the budget guard, the free plan and what it costs. Its pictures are HTML and
// CSS (public/home.css) with no scripts, which the CSP doesn't allow here: the deploy demo
// loops with a pause control, and stands still for visitors who ask for reduced motion.
// It names no other company; comparisons live on /compare/.
import {
  shipcelFree,
  cloudflareFree,
  noCode,
  platformFeatures,
  startOptions,
  tiers,
} from './content.ts';
import { escape, inline, list } from './markup.ts';
import { mediaUrl } from './media.ts';

// Line icons on a 24-pixel grid, stroked in the text's colour (home.css).
const icons: Record<string, string> = {
  agent:
    '<path d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9-1.9 4.6-1.9-4.6-4.6-1.9 4.6-1.9z"/><path d="M18.5 15l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z"/>',
  git: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M18 10.5c0 4-4.5 4-8.6 5.8"/>',
  terminal:
    '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5"/><path d="M12.5 15H17"/>',
  upload:
    '<path d="M12 15V4.5"/><path d="M7.5 9L12 4.5 16.5 9"/><path d="M4 14.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3.5"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3z"/>',
  database:
    '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13"/><path d="M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5"/><path d="M16 7l2.5 2.5"/><path d="M13.5 9.5l2 2"/>',
  chart:
    '<path d="M3.5 20.5h17"/><path d="M7 17v-5"/><path d="M12 17V7"/><path d="M17 17V9"/>',
  undo: '<path d="M8.5 5L4.5 9l4 4"/><path d="M4.5 9H15a5 5 0 0 1 0 10H9"/>',
  layers:
    '<path d="M12 3.5L21 8.5l-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/><path d="M3 16.5l9 5 9-5"/>',
  users:
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.7a3.5 3.5 0 0 1 0 6.6"/><path d="M18.5 14.3c1.8.9 3 2.9 3 5.7"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
  cloud:
    '<path d="M7 19h10.5a4.5 4.5 0 0 0 .7-8.95A6.5 6.5 0 0 0 5.6 9.4 4.8 4.8 0 0 0 7 19z"/>',
  shield:
    '<path d="M12 3l7.5 3v5.5c0 4.6-3.1 8.3-7.5 9.5-4.4-1.2-7.5-4.9-7.5-9.5V6z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  pause:
    '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  stop: '<path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2z"/><path d="M8.5 12h7"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5v-3a4 4 0 0 1 8 0v3"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.7 2.7L16 9.6"/>',
};
const icon = (name: string) => {
  const drawing = icons[name];
  if (!drawing) throw new Error(`No icon named ${name}`);
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${drawing}</svg>`;
};

// Both free plans: the front page's (in full, folded away) and /pricing/'s, where the table
// below the cards lists Cloudflare's limits, so the card only points to it.
// One Free card: what Shipcel gives, and Cloudflare's free allowance in your account as its
// second column. The front page lists that allowance; the pricing page has it in a table.
export const freePlanCards = (
  cloudflareLimits = true,
) => `<article class="card featured plan-card">
<div class="plan-head"><span class="badge">Free</span><p class="price">$0 <span>a month, no card</span></p></div>
<div class="plan-cols">
<div>
<h3>From Shipcel</h3>
${list(shipcelFree)}
</div>
<div>
<h3>In your Cloudflare account</h3>
${
  cloudflareLimits
    ? `<p>Shipcel adds no limits of its own below these. Your apps get Cloudflare's full free allowance:</p>
${list(cloudflareFree.map((r) => `**${r.service}:** ${r.free}`))}`
    : `<p>Shipcel adds no limits below Cloudflare's. The table below lists every service's free allowance, and what Workers Paid, Cloudflare's $5-a-month plan, adds.</p>`
}
<p class="small muted">Workers, D1 and KV stop at their daily limits until midnight UTC instead of billing you. R2 is pay-as-you-go beyond its free tier.</p>
</div>
</div>
</article>`;

// The deploy demo: what `shipcel` prints for a new Vite app (a few prompts left out; see
// docs/guides/cli.md), then the live app and its traffic. The moving copy is hidden from
// screen readers, which read the caption instead.
export const demoOutput = [
  'Set up and deploy “~/shop”? [Y/n] y',
  'Detected Vite (Build Command: npm run build, Output Directory: dist)',
  'Building: npm run build',
  'Uploading 12 of 12 new files…',
  'Deployed 12 files (12 new) to shop.',
];
export const demoProduction = 'Production: https://shop.ada.workers.dev/';
const demo = () => `<figure class="demo">
<div class="demo-stage" aria-hidden="true">
<div class="demo-term">
<p class="demo-bar"><i></i><i></i><i></i><span>~/shop</span></p>
<pre class="demo-lines"><span><span class="ok">$</span> <span class="cmd">shipcel</span><span class="caret"></span></span>${demoOutput
  .map((line) => `<span>${escape(line)}</span>`)
  .join('')}<span class="ok">${escape(demoProduction)}</span></pre>
</div>
<div class="demo-out">
<div class="demo-site">
<p class="demo-url">${icon('lock')}<span>shop.ada.workers.dev</span><span class="demo-live">Live</span></p>
<div class="demo-page"><span class="title"></span><span class="banner"></span><span class="tiles"><span></span><span></span><span></span></span><span></span><span class="short"></span></div>
</div>
<div class="demo-stats">
<p>Requests, last 24 hours</p>
<strong>1,284</strong>
<span class="demo-bars">${'<i></i>'.repeat(12)}</span>
<p>Errors: 0</p>
</div>
</div>
</div>
<div class="demo-controls"><input type="checkbox" id="demo-pause"><label for="demo-pause">Pause the animation</label></div>
<figcaption>One command, <code>shipcel</code>, builds the app on your computer, deploys it to your Cloudflare account and prints its address.</figcaption>
</figure>`;

const hero =
  () => `<section class="hero home-hero" aria-labelledby="hero-title">
<div class="hero-copy">
<h1 id="hero-title">From side project to enterprise, on your own Cloudflare</h1>
<p class="lede">Your websites and apps on Cloudflare, in your own account, with no infrastructure code.</p>
<div class="actions"><a class="button primary" href="/app/">Start free</a><a class="button" href="#tour">Watch the tour</a></div>
${list(['Free, as a launch offer: your only bill is Cloudflare’s, $0 on its free plan or $5 a month on its paid plan, Workers Paid', 'Your account, your data, no lock-in', 'No bandwidth fees for static files'], 'proof')}
</div>
${demo()}
<p class="hero-note small muted"><strong>Alpha:</strong> everything here is built and tested; deploys from GitHub, the terminal and drag-and-drop have gone to real Cloudflare accounts; a few parts rest on Cloudflare betas. <a href="/why/#not-yet">What isn't ready yet</a>.</p>
</section>`;

// You → Shipcel → your Cloudflare account → your visitors.
const howItWorks = () => `<section aria-labelledby="how-title">
<h2 id="how-title">How it works</h2>
<p class="section-intro">Shipcel is the control panel. Everything it sets up runs in your own Cloudflare account.</p>
<ol class="flow">
<li><span class="flow-icon">${icon('user')}</span><h3>You</h3><p>Push to GitHub, run <code>shipcel</code>, drop a folder or ask your AI agent.</p></li>
<li><span class="flow-icon"><img src="/favicon.svg" alt="" width="24" height="24"></span><h3>Shipcel</h3><p>Builds your app, sets up what it needs and checks every deploy.</p></li>
<li class="account"><span class="flow-icon">${icon('cloud')}</span><h3>Your Cloudflare account</h3>${list(['Your app', 'Database', 'File storage', 'Key-value data', 'Sign-in', 'Realtime'], 'chips')}</li>
<li><span class="flow-icon">${icon('globe')}</span><h3>Your visitors</h3><p>Served from Cloudflare’s network around the world.</p></li>
</ol>
<p class="flow-note">${icon('check')}<span>Stop using Shipcel and your apps keep running: they’re in your account.</span></p>
<div class="nocode">
<h3>No infrastructure code</h3>
${list(noCode)}
</div>
</section>`;

// A glimpse of each way in, drawn beside its description.
const wayPictures: Record<string, string> = {
  agent:
    '<span class="way-chat">“Add a newsletter sign-up, then deploy a preview.”</span>',
  git: '<span class="way-code">git push</span><span class="way-arrow">→</span><span class="way-pill">Preview address</span>',
  terminal: '<span class="way-code dark">$ shipcel --prod</span>',
  upload: '<span class="way-drop">dist/</span>',
};
const ways = () => `<section aria-labelledby="start-title">
<h2 id="start-title">Start your way</h2>
<p class="section-intro">Four ways in, to the same project. Roll back any deploy in one click.</p>
<div class="ways">${startOptions
  .map(
    (o) =>
      `<article class="way"><h3>${inline(o.title)}</h3><p>${inline(o.text)}</p><p class="way-picture" aria-hidden="true">${wayPictures[o.icon] ?? ''}</p></article>`,
  )
  .join('\n')}</div>
</section>`;

// A recorded walk through the dashboard (scripts/site-media.spec.ts), with sample data.
const tourSteps = [
  'Builds with a live log, and versions to roll back to',
  'Requests, errors, response times and logs',
  'Visitors, top pages and Core Web Vitals',
  'The budget guard: what the app costs this month, day by day',
];
const tour = () => `<section id="tour" aria-labelledby="tour-title">
<h2 id="tour-title">See it in action</h2>
<p class="section-intro">One minute in the dashboard, recorded with sample data.</p>
<figure class="tour">
<video controls preload="none" playsinline width="1280" height="800" poster="${mediaUrl('tour.webp')}" aria-describedby="tour-steps"><source src="${mediaUrl('tour.webm')}" type="video/webm"><a href="${mediaUrl('tour.webm')}" rel="noreferrer">Download the tour</a></video>
<figcaption><ol class="tour-steps" id="tour-steps">${tourSteps
  .map((s) => `<li>${escape(s)}</li>`)
  .join('')}</ol></figcaption>
</figure>
</section>`;

const features = () => `<section aria-labelledby="features-title">
<h2 id="features-title">What every app gets</h2>
<div class="features">${platformFeatures
  .map(
    (f) =>
      `<article class="feature"><h3>${inline(f.title)}</h3><p>${inline(f.text)}</p></article>`,
  )
  .join('\n')}</div>
<p><a href="/features/">Every feature, and what isn't ready yet</a></p>
</section>`;

// The budget guard: a month's budget, with the alerts along it.
const guardPoints = [
  {
    icon: 'shield',
    text: '**Free-only mode, on by default.** Nothing a project can be billed for, such as file storage or containers, is created.',
  },
  {
    icon: 'bell',
    text: '**A budget for every app.** $0 beyond what Cloudflare includes, unless you change it. Alerts in the dashboard, Slack, Discord or any webhook.',
  },
  {
    icon: 'pause',
    text: '**Alert only, or pause.** An app that goes over can be paused: visitors see that, its schedules stop and its data stays, until you resume it.',
  },
  {
    icon: 'stop',
    text: '**The free plan stops instead of billing.** Workers, D1 and KV stop at their daily limits until midnight UTC.',
  },
];
const guard = () => `<section aria-labelledby="guard-title">
<h2 id="guard-title">No surprise bills</h2>
<p class="section-intro">Shipcel watches what every app costs, so a bug that loops can’t become a bill.</p>
<div class="guard">
<figure class="meter-figure">
<div class="meter" aria-hidden="true"><span class="meter-mark m50">50%</span><span class="meter-mark m80">80%</span><span class="meter-mark m100">100%</span></div>
<ol class="meter-steps">
<li>${icon('bell')}<span><strong>50% and 80% of the budget:</strong> an alert</span></li>
<li>${icon('bell')}<span><strong>On track to go over by the end of the month:</strong> an alert</span></li>
<li>${icon('pause')}<span><strong>Over the budget:</strong> an alert, and a pause if you chose it</span></li>
</ol>
<figcaption>Every five minutes, Shipcel estimates what each app costs this month beyond what Cloudflare includes, and compares it with the app’s budget.</figcaption>
</figure>
<ul class="guard-points">${guardPoints
  .map((p) => `<li>${icon(p.icon)}<span>${inline(p.text)}</span></li>`)
  .join('')}</ul>
</div>
</section>`;

// The free allowance at a glance; both plans in full one click away.
const freeFigures = [
  ['100,000', 'requests a day to your server code'],
  ['Unlimited', 'requests for static files'],
  ['5 GB', 'of SQL databases'],
  ['1 GB', 'of key-value data'],
  ['3,000', 'build minutes a month'],
  ['100', 'projects in Shipcel'],
];
const freePlan = () => `<section aria-labelledby="free-title">
<h2 id="free-title">What the free plan includes</h2>
<p class="section-intro">Shipcel's free plan sets everything up; Cloudflare's runs it in your account.</p>
<ul class="figures">${freeFigures
  .map(
    ([n, what]) =>
      `<li><strong>${escape(n)}</strong><span>${escape(what)}</span></li>`,
  )
  .join('')}</ul>
<p class="free-stop">${icon('stop')}<span>Workers, D1 and KV stop at their daily limits until midnight UTC instead of billing you.</span></p>
<details class="free-more">
<summary>Everything in both free plans</summary>
${freePlanCards()}
</details>
<p><a href="/pricing/">Full limits, what happens when you reach them, and Workers Paid</a></p>
</section>`;

// What it costs at every stage, in one section: the three tiers, and the one-account bill.
// Several services with a plan and a bill each, or one account.
const services = ['Hosting', 'Database', 'File storage', 'Sign-in', 'Realtime'];
const costs = () => `<section aria-labelledby="costs-title">
<h2 id="costs-title">What it costs</h2>
<p class="section-intro">Shipcel stays free, as a launch offer. Every price here is Cloudflare's, charged by Cloudflare at its list prices: no markup, no platform fee, no per-seat pricing.</p>
<div class="grid tiers">${tiers
  .map(
    (t, i) => `<article class="card${i === 0 ? ' featured' : ''}">
<span class="badge">${escape(t.name)}</span>
<p class="price">${escape(t.price)} <span>${escape(t.unit)}</span></p>
${list(t.points)}
</article>`,
  )
  .join('\n')}</div>
<figure class="bills">
<div class="bills-many">
<p class="bills-label">A typical stack</p>
<ul>${services.map((s) => `<li>${s}<span>its own plan and bill</span></li>`).join('')}</ul>
</div>
<span class="bills-arrow" aria-hidden="true">→</span>
<div class="bills-one">
<p class="bills-label">With Shipcel</p>
<div class="bills-account"><strong>Your Cloudflare account</strong>${list(services, 'chips')}<span class="bills-price">One bill: $0, or from $5 a month</span></div>
</div>
<figcaption>Frontend, server code, databases, files, sign-in and realtime in one account, on one bill.</figcaption>
</figure>
<ul class="jump"><li><a href="/pricing/">Full pricing and worked examples</a></li><li><a href="/why/">Why it costs less</a></li><li><a href="/compare/">Compared with other platforms</a></li></ul>
</section>`;

export const homeBody = () =>
  [
    hero(),
    howItWorks(),
    ways(),
    tour(),
    features(),
    guard(),
    freePlan(),
    costs(),
    `<section class="cta-band" aria-labelledby="cta-title">
<h2 id="cta-title">Start on Cloudflare's free plan</h2>
<p>Connect GitHub and Cloudflare, and deploy. Free, with your apps in your own account.</p>
<a class="button" href="/app/">Open the dashboard</a>
</section>`,
  ].join('\n');
