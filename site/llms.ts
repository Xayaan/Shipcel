// /llms.txt (llmstxt.org): where an AI agent starts with Shipcel. Every guide is also
// published as Markdown at /docs/<slug>.md, which is what these links point to; the guides
// link to each other the same way, so an agent can follow them without the HTML.
import { readFileSync } from 'node:fs';
import { guides, readGuide } from './docs.ts';
import { firstSentence } from './markup.ts';

const SITE = 'https://shipcel.com';
// The guides an agent reads first, in this order.
const START = ['getting-started', 'cli', 'ai-agents'];

export const guideMarkdown = (slug: string) =>
  readFileSync(new URL(`../docs/guides/${slug}.md`, import.meta.url), 'utf8');

export function llmsTxt() {
  const docs = guides.map((g) => ({ ...g, ...readGuide(g.slug) }));
  const entry = (d: (typeof docs)[number]) =>
    `- [${d.title}](${SITE}/docs/${d.slug}.md): ${firstSentence(d.description)}`;
  return `# Shipcel

> Shipcel deploys websites and apps into a person's own Cloudflare account, with no infrastructure code: from GitHub, with the \`shipcel\` command, from a dropped folder, or by an AI agent through MCP. Shipcel is free; Cloudflare bills the account's usage at its list prices.

From a terminal, deploy with the CLI in the app's folder:

- Install it: \`npm install -g ${SITE}/cli/shipcel.tgz\`
- Sign in: \`shipcel login\` opens one page where the person approves the CLI and connects Cloudflare. Without a browser (CI, or an agent working alone), set \`SHIPCEL_TOKEN\` to an API token made under **API & CLI** in the dashboard.
- Deploy: \`shipcel\`. A new app's first deploy goes to production; after that \`shipcel\` deploys a preview, and \`shipcel --prod\` deploys to production.
- \`shipcel agent init\` writes these commands into the project's AGENTS.md.

Without a terminal, use the MCP server at ${SITE}/mcp, with the API token as a bearer token (chat apps such as Claude.ai connect with OAuth instead). It creates projects, deploys files, publishes, rolls back and sets secrets.

## Start here

${docs
  .filter((d) => START.includes(d.slug))
  .map(entry)
  .join('\n')}

## Guides

${docs
  .filter((d) => !START.includes(d.slug))
  .map(entry)
  .join('\n')}

## Optional

- [Features](${SITE}/features/): every feature, marked built, beta or not yet
- [Pricing](${SITE}/pricing/): Cloudflare's free and paid limits, and worked examples
`;
}
