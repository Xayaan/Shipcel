// Shipcel sign-in and realtime service. Shipcel deploys this Worker into the app owner's
// own Cloudflare account, with a D1 database for users and a Durable Object class for
// realtime channels. It runs within Cloudflare's free plan limits.
import {
  authorize,
  confirmLogout,
  discovery,
  jwks,
  logout,
  preflight,
  revoke,
  token,
  userinfo,
  type LogoutResult,
} from './oidc';
import { callback, isProvider, start } from './oauth';
import { emailFinish, emailStart, passwordLogin, passwordSet } from './email';
import {
  assetHeaders,
  assetPaths,
  errorPage,
  logoutPage,
  passwordJs,
  passwordPage,
  signedOutPage,
  signInCss,
  signInJs,
  signInPage,
} from './pages';
import {
  loginOptions,
  loginVerify,
  registerOptions,
  registerVerify,
} from './passkeys';
import { realtime } from './realtime';
import { data } from './data';
import {
  currentSession,
  getAuthRequest,
  getUser,
  readSettings,
  requireSignin,
  type Env,
} from './store';
import { HttpError, json } from './util';

export { Channel } from './realtime';

// Browser-facing routes render HTML errors; API routes return JSON.
const pageRoute = (path: string, method: string) =>
  path === '/authorize' ||
  path === '/sign-in' ||
  path.startsWith('/oauth/') ||
  path.startsWith('/email/') ||
  (path === '/password/set' && method === 'GET') ||
  path === '/logout';

async function route(request: Request, env: Env, path: string) {
  const method = request.method;
  if (path === '/.well-known/openid-configuration') return discovery(request);
  if (path === '/.well-known/jwks.json') return jwks(env);
  if (path === '/authorize' && method === 'GET') return authorize(request, env);
  if (path === '/sign-in' && method === 'GET') {
    const params = new URL(request.url).searchParams;
    const settings = await readSettings(env);
    requireSignin(settings);
    const authRequest = await getAuthRequest(
      env,
      params.get('request'),
      request,
    );
    return signInPage(
      settings,
      authRequest.id,
      params.get('cancelled') === '1',
    );
  }
  if (path === assetPaths.js)
    return new Response(signInJs, {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        ...assetHeaders,
      },
    });
  if (path === assetPaths.css)
    return new Response(signInCss, {
      headers: { 'Content-Type': 'text/css; charset=utf-8', ...assetHeaders },
    });
  if (path === assetPaths.passwordJs)
    return new Response(passwordJs, {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        ...assetHeaders,
      },
    });
  // Sign-in by email, and passwords (services/backend/src/email.ts).
  if (path === '/email/start' && method === 'POST')
    return emailStart(request, env);
  if (path === '/email/finish' && method === 'GET')
    return emailFinish(request, env);
  if (path === '/password/login' && method === 'POST')
    return passwordLogin(request, env);
  if (path === '/password/set' && method === 'POST')
    return passwordSet(request, env);
  if (path === '/password/set' && method === 'GET') {
    const settings = await readSettings(env);
    requireSignin(settings);
    if (!settings.password)
      throw new HttpError(404, 'Passwords aren’t turned on for this app.');
    const session = await currentSession(env, request);
    if (!session)
      throw new HttpError(
        401,
        'Sign in to the app first, then come back to set a password.',
      );
    return passwordPage(
      settings,
      (await getUser(env, session.user_id))?.email ?? null,
    );
  }
  if (method === 'POST' && path === '/passkeys/register/options')
    return registerOptions(request, env);
  if (method === 'POST' && path === '/passkeys/register/verify')
    return registerVerify(request, env);
  if (method === 'POST' && path === '/passkeys/login/options')
    return loginOptions(request, env);
  if (method === 'POST' && path === '/passkeys/login/verify')
    return loginVerify(request, env);
  const oauth = path.match(/^\/oauth\/(\w+)\/(start|callback)$/);
  if (oauth && method === 'GET' && isProvider(oauth[1]))
    return oauth[2] === 'start'
      ? start(request, env, oauth[1])
      : callback(request, env, oauth[1]);
  if (['/token', '/userinfo', '/revoke'].includes(path) && method === 'OPTIONS')
    return preflight(request, env);
  if (path === '/token' && method === 'POST') return token(request, env);
  if (path === '/userinfo' && (method === 'GET' || method === 'POST'))
    return userinfo(request, env);
  if (path === '/revoke' && method === 'POST') return revoke(request, env);
  if (path === '/logout' && (method === 'GET' || method === 'POST')) {
    const result: LogoutResult =
      method === 'GET'
        ? await logout(request, env)
        : await confirmLogout(request, env);
    if ('done' in result) return result.done;
    if ('signedOut' in result) return signedOutPage(result.signedOut);
    return logoutPage(result.confirm);
  }
  if (path.startsWith('/realtime/')) return realtime(request, env, path);
  if (path.startsWith('/data/')) return data(request, env, path);
  if (path === '/')
    return json({
      service: 'shipcel-backend',
      version: env.CLOUDCEL_BACKEND_VERSION ?? 'development',
    });
  throw new HttpError(404, 'Not found.', 'not_found');
}

export default {
  async fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    try {
      const response = await route(request, env, path);
      return response;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message =
        error instanceof HttpError
          ? error.message
          : 'Something went wrong. Try again in a moment.';
      if (!(error instanceof HttpError))
        console.error('Unhandled error', error);
      if (pageRoute(path, request.method)) return errorPage(message, status);
      return json(
        {
          error: error instanceof HttpError ? error.code : 'server_error',
          error_description: message,
        },
        { status, headers: { 'X-Content-Type-Options': 'nosniff' } },
      );
    }
  },
};
