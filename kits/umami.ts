// Umami from its published image, which Cloudflare pulls from Docker Hub: nothing is built.
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
  id: 'umami',
  name: 'Umami',
  subtitle: 'Privacy-friendly web analytics',
  runtime: 'Containers + Postgres',
  family: 'Services',
  symbol: 'U',
  color: 'purple',
  description:
    'Umami 3.4 from its published image, in a container in your Cloudflare account, with its data in a Postgres database you host elsewhere (Neon’s free plan is enough). Needs the Workers Paid plan; the container sleeps when no one is using it.',
  docs: 'https://umami.is/docs',
  containers: true,
} as const satisfies KitMeta;

// The README's section on running it: what it is, then the steps every service shares.
const notes = `[Umami](https://umami.is) counts visits without cookies. This kit runs its published image (\`umamisoftware/umami:3.4.1\`) in a container in your account.\n\n${serviceSteps('APP_SECRET', 'a long random string (`openssl rand -hex 32`)', 'Sign in and change the password.** Open the app’s address: Umami makes its tables on the first start, which takes a minute, and an account named `admin` with the password `umami`. Sign in at once and change the password (**Settings → Profile**): anyone with the address can sign in until you do. Then add your website and put its tracking script on your pages.')}`;

// What an exported project contains, beyond what every kit gets.
export const kit: Kit = {
  config: () =>
    containerConfig(
      'Umami',
      'UMAMI',
      'docker.io/umamisoftware/umami:3.4.1',
      'basic',
      1,
    ),
  scripts: containerScripts,
  dependencies: { '@cloudflare/containers': CONTAINERS_VERSION },
  ignore: '',
  files: (project) => {
    const files: Record<string, string> = {};
    files['src/worker.js'] =
      `import { Container, getContainer } from '@cloudflare/containers';

// Umami in one container, from its published image. Its data is in your Postgres database,
// so the container can sleep when no one is using it; the next request wakes it.
export class Umami extends Container {
  defaultPort = 3000;
  sleepAfter = '30m';
  envVars = {
    DATABASE_URL: this.env.DATABASE_URL,
    APP_SECRET: this.env.APP_SECRET,
    DISABLE_TELEMETRY: '1',
  };
}

${unset(['DATABASE_URL', 'APP_SECRET'])}

export default {
  async fetch(request, env) {
    const missing = unset(env);
    if (missing.length) return setFirst(missing);
    return getContainer(env.UMAMI).fetch(request);
  },
};
`;
    return files;
  },
  readme: {
    runLocally:
      'Wrangler pulls the image and runs it with Docker on your computer. Put `DATABASE_URL` and `APP_SECRET` in a `.dev.vars` file first (it is in `.gitignore`); a local Postgres works.\n',
    notes,
  },
};
