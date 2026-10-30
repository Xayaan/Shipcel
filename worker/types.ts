export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ORIGIN?: string;
  AUTH_MODE?: 'local' | 'github';
  TOKEN_ENCRYPTION_KEY?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_APP_SLUG?: string;
  CLOUDFLARE_CLIENT_ID?: string;
  CLOUDFLARE_CLIENT_SECRET?: string;
  CLOUDFLARE_OAUTH_SCOPES?: string;
  NATIVE_BUILDS_ENABLED?: string;
  // Shipcel's own visitor analytics (worker/analytics.ts): a PostHog project key, which is
  // public, and its region, 'us' (the default) or 'eu'. Without a key, nothing is loaded.
  POSTHOG_KEY?: string;
  POSTHOG_REGION?: string;
  // Email notifications (worker/notifications.ts) go through Cloudflare's Email Service: a
  // `send_email` binding, and a sender address on a domain onboarded for Email Sending.
  NOTIFY_EMAIL?: { send(message: OutgoingEmail): Promise<unknown> };
  NOTIFY_FROM?: string;
};
export type OutgoingEmail = {
  from: { email: string; name: string };
  to: string;
  subject: string;
  text: string;
  html: string;
};
export type Identity = {
  userId: string;
  workspaceId: string;
  login: string;
  // Owners run the team, its connections and billing switches; developers create, deploy
  // and manage projects; viewers read.
  role: 'owner' | 'developer' | 'viewer';
  sessionHash: string | null;
  // How the request was authenticated: a browser session, or an API token (sessionHash is
  // then "pat:<token id>").
  via?: 'session' | 'token';
  // A token Shipcel made for one GitHub Actions run (worker/github-actions.ts): it deploys this
  // project only, and a run on a branch other than the production branch deploys previews only.
  actionsRun?: { projectId: string; previewOnly: boolean };
};
export type AppEnv = {
  Bindings: Env;
  Variables: { identity: Identity | null };
};
export class AppError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}
export const now = () => Math.floor(Date.now() / 1000);
export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// GitHub's runners reach Shipcel over the internet, which a Shipcel on someone's own computer
// isn't on: there, GitHub Actions can't deploy (worker/github-actions.ts).
export const reachableFromGitHub = (origin: string) =>
  !LOCAL_HOSTS.has(new URL(origin).hostname);
export function appOrigin(env: Env, request: Request) {
  const configured = env.APP_ORIGIN || new URL(request.url).origin;
  const url = new URL(configured);
  if (
    url.origin !== configured ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)))
  )
    throw new AppError(
      503,
      'APP_ORIGIN must be an HTTPS origin, or HTTP on loopback for development.',
    );
  return configured;
}
export function localMode(env: Env, request: Request) {
  return (
    env.AUTH_MODE !== 'github' && LOCAL_HOSTS.has(new URL(request.url).hostname)
  );
}
