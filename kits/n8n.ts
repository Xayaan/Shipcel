// n8n from its published image, which Cloudflare pulls from Docker Hub: nothing is built.
import {
  containerConfig,
  CONTAINERS_VERSION,
  containerScripts,
  serviceSteps,
  unset,
} from './common.ts';
import type { Kit, KitMeta } from './types.ts';

// What the App catalog shows.
export const meta = {
  id: 'n8n',
  name: 'n8n',
  subtitle: 'Workflow automation',
  runtime: 'Containers + Postgres',
  family: 'Services',
  symbol: 'n8',
  color: 'orange',
  description:
    'n8n 2.46 from its published image, in a container in your Cloudflare account, with workflows and credentials in a Postgres database you host elsewhere. Needs the Workers Paid plan; its schedules run only while the container is awake.',
  docs: 'https://docs.n8n.io/hosting/',
  containers: true,
} as const satisfies KitMeta;

// The README's section on running it: what it is, then the steps every service shares.
const notes = `[n8n](https://n8n.io) runs workflows. This kit runs its published image (\`n8nio/n8n:2.46.3\`) in a container in your account, with workflows, credentials and executions in Postgres.\n\n${serviceSteps('N8N_ENCRYPTION_KEY', 'a long random string (`openssl rand -hex 32`); keep a copy, because the credentials n8n saves can’t be read without it', 'Create the owner account.** Open the app’s address at once and create n8n’s owner account: until you do, whoever opens it first can.')}\n\nn8n’s schedules run only while its container is awake, which is an hour after the last request: workflows started by webhooks, forms and you fit best. Webhook addresses use the app’s own address.`;

// What an exported project contains, beyond what every kit gets.
export const kit: Kit = {
  config: () =>
    containerConfig('N8n', 'N8N', 'docker.io/n8nio/n8n:2.46.3', 'basic', 1),
  scripts: containerScripts,
  dependencies: { '@cloudflare/containers': CONTAINERS_VERSION },
  ignore: '',
  files: (project) => {
    const files: Record<string, string> = {};
    files['src/worker.js'] =
      `import { Container, getContainer } from '@cloudflare/containers';

// DATABASE_URL (postgresql://user:password@host:port/database) as n8n's own settings.
function database(value) {
  const url = new URL(value);
  return {
    DB_TYPE: 'postgresdb',
    DB_POSTGRESDB_HOST: url.hostname,
    DB_POSTGRESDB_PORT: url.port || '5432',
    DB_POSTGRESDB_DATABASE: decodeURIComponent(url.pathname.slice(1)),
    DB_POSTGRESDB_USER: decodeURIComponent(url.username),
    DB_POSTGRESDB_PASSWORD: decodeURIComponent(url.password),
    DB_POSTGRESDB_SSL_ENABLED: url.searchParams.get('sslmode') === 'disable' ? 'false' : 'true',
  };
}

// n8n in one container, from its published image, with its workflows, credentials and
// executions in your Postgres database. It is started with the app's own address, so
// webhook addresses are right, and stays awake for an hour after the last request.
export class N8n extends Container {
  defaultPort = 5678;
  sleepAfter = '1h';
  async fetch(request) {
    const url = new URL(request.url);
    this.envVars = {
      ...database(this.env.DATABASE_URL),
      N8N_ENCRYPTION_KEY: this.env.N8N_ENCRYPTION_KEY,
      N8N_HOST: url.hostname,
      N8N_PROTOCOL: url.protocol.slice(0, -1),
      WEBHOOK_URL: \`\${url.origin}/\`,
      N8N_PROXY_HOPS: '1',
      N8N_DIAGNOSTICS_ENABLED: 'false',
    };
    const forwarded = new Request(request);
    forwarded.headers.set('X-Forwarded-Proto', url.protocol.slice(0, -1));
    forwarded.headers.set('X-Forwarded-Host', url.host);
    return super.fetch(forwarded);
  }
}

${unset(['DATABASE_URL', 'N8N_ENCRYPTION_KEY'])}

export default {
  async fetch(request, env) {
    const missing = unset(env);
    if (missing.length) return setFirst(missing);
    return getContainer(env.N8N).fetch(request);
  },
};
`;
    return files;
  },
  readme: {
    runLocally:
      'Wrangler pulls the image and runs it with Docker on your computer. Put `DATABASE_URL` and `N8N_ENCRYPTION_KEY` in a `.dev.vars` file first (it is in `.gitignore`); a local Postgres works.\n',
    notes,
  },
};
