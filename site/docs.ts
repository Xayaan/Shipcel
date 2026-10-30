// The guides in docs/guides, published at /docs/<slug>/ in this order. The Markdown files
// are the source: they read the same on GitHub and on the site.
import { readFileSync } from 'node:fs';
import { markdown } from './markdown.ts';

export const docSections = [
  'Get started',
  'Deploy',
  'Build your app',
  'Workspace',
  'Run Shipcel',
] as const;
export const guides: { slug: string; section: (typeof docSections)[number] }[] =
  [
    { slug: 'getting-started', section: 'Get started' },
    { slug: 'cli', section: 'Get started' },
    { slug: 'deploy-from-github', section: 'Deploy' },
    { slug: 'other-git-hosts', section: 'Deploy' },
    { slug: 'deploy-without-git', section: 'Deploy' },
    { slug: 'starter-kits', section: 'Deploy' },
    { slug: 'previews-and-rollbacks', section: 'Deploy' },
    { slug: 'environment-variables', section: 'Build your app' },
    { slug: 'domains', section: 'Build your app' },
    { slug: 'databases-and-storage', section: 'Build your app' },
    { slug: 'sign-in-and-realtime', section: 'Build your app' },
    { slug: 'logs-and-analytics', section: 'Build your app' },
    { slug: 'teams-and-tokens', section: 'Workspace' },
    { slug: 'ai-agents', section: 'Workspace' },
    { slug: 'free-only-and-billing', section: 'Workspace' },
    { slug: 'self-hosting', section: 'Run Shipcel' },
    { slug: 'add-a-starter-kit', section: 'Run Shipcel' },
    { slug: 'troubleshooting', section: 'Run Shipcel' },
  ];

export const readGuide = (slug: string) =>
  markdown(
    readFileSync(new URL(`../docs/guides/${slug}.md`, import.meta.url), 'utf8'),
  );
