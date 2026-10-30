import { existsSync, readFileSync } from 'node:fs';
const values = { ...process.env };
if (existsSync('.dev.vars')) {
  for (const line of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
}
const providers = {
  GitHub: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_APP_SLUG'],
  Cloudflare: [
    'CLOUDFLARE_CLIENT_ID',
    'CLOUDFLARE_CLIENT_SECRET',
    'CLOUDFLARE_OAUTH_SCOPES',
  ],
};
// A local Shipcel can set up GitHub and Cloudflare sign-in from Connections instead.
const loopback = (() => {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(
      new URL(values.APP_ORIGIN).hostname,
    );
  } catch {
    return false;
  }
})();
const localSetup = values.AUTH_MODE !== 'github' && loopback;
const problems = ['APP_ORIGIN', 'TOKEN_ENCRYPTION_KEY']
  .filter((name) => !values[name])
  .map((name) => `${name}: missing`);
const notes = [];
for (const [provider, names] of Object.entries(providers)) {
  const set = names.filter((name) => values[name]);
  if (set.length === names.length) continue;
  if (!set.length && localSetup)
    notes.push(`${provider}: not in .dev.vars; set it up from Connections.`);
  else
    problems.push(
      ...names
        .filter((name) => !values[name])
        .map((name) => `${name}: missing`),
    );
}
if (
  values.TOKEN_ENCRYPTION_KEY &&
  !/^[a-f0-9]{64}$/i.test(values.TOKEN_ENCRYPTION_KEY)
)
  problems.push('TOKEN_ENCRYPTION_KEY: must be 64 hexadecimal characters');
if (values.GITHUB_APP_SLUG && !/^[\w-]+$/.test(values.GITHUB_APP_SLUG))
  problems.push('GITHUB_APP_SLUG: invalid format');
if (values.AUTH_MODE && !['local', 'github'].includes(values.AUTH_MODE))
  problems.push('AUTH_MODE: use local or github');
if (
  values.NATIVE_BUILDS_ENABLED &&
  !['true', 'false'].includes(values.NATIVE_BUILDS_ENABLED)
)
  problems.push('NATIVE_BUILDS_ENABLED: use true or false');
if (values.APP_ORIGIN) {
  try {
    const url = new URL(values.APP_ORIGIN);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.origin !== values.APP_ORIGIN ||
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    )
      problems.push(
        'APP_ORIGIN: use an exact HTTPS origin, or loopback HTTP for development',
      );
    if (!local && values.AUTH_MODE !== 'github')
      problems.push('AUTH_MODE: public hosting requires github');
  } catch {
    problems.push('APP_ORIGIN: invalid URL');
  }
}
console.log('Shipcel configuration check (secret values are never printed)');
for (const note of notes) console.log(note);
if (problems.length) {
  console.log(problems.join('\n'));
  console.log(
    'Follow docs/provider-setup.md and .dev.vars.example. Offline local mode remains available.',
  );
  process.exitCode = 1;
} else {
  console.log(
    'Required configuration is present. This does not verify provider credentials, approved scopes, or live deployment.',
  );
  console.log(
    values.NATIVE_BUILDS_ENABLED === 'true'
      ? 'Native resource creation is enabled. Confirm the dedicated-account checks have passed.'
      : 'Native resource creation is disabled. Complete the dedicated-account checks before enabling.',
  );
}
