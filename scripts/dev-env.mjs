// Run by `npm run dev`: a fresh checkout gets a local .dev.vars with its own encryption key,
// so GitHub and Cloudflare sign-in can be set up from Connections. An existing file is never
// changed, and the key is never printed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

if (!existsSync('.dev.vars')) {
  const example = readFileSync('.dev.vars.example', 'utf8');
  writeFileSync(
    '.dev.vars',
    example.replace(
      /^TOKEN_ENCRYPTION_KEY=.*$/m,
      `TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`,
    ),
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    'Created .dev.vars with a new local encryption key. Set up GitHub and Cloudflare sign-in from Connections.',
  );
}
