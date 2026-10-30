import { join } from 'node:path';

// Environment for credential-free verification. Wrangler must never reuse a saved
// login or start an interactive one: an empty config directory hides saved OAuth
// tokens, and an obviously invalid token makes any API call fail instead of
// prompting. Shell variables such as CLOUDFLARE_ACCOUNT_ID are not inherited.
export function offlineEnv(root) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    CI: 'true',
    XDG_CONFIG_HOME: join(root, 'config'),
    CLOUDFLARE_API_TOKEN: 'offline-verification-invalid-token',
    WRANGLER_SEND_METRICS: 'false',
    WRANGLER_LOG_PATH: join(root, 'wrangler-logs'),
  };
}
