import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database } from './helpers/database';

// Choosing repositories in the same visit to GitHub (worker/auth.ts): after signing in, someone
// whose GitHub hasn't installed Shipcel's app goes on to GitHub's page for choosing repositories,
// and the app's setup URL (/api/auth/github/installed) brings them back to where they started.
let db: ReturnType<typeof database>;
const install = 'https://github.com/apps/shipcel-test/installations/new';
const returnCookie = '__Host-cloudcel_github_return';

beforeEach(() => {
  db = database();
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

// GitHub, faked: the token, the person, and how many installations of Shipcel's app they have
// (null: GitHub fails to say).
function github(id: number, installations: number | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token')
        return Response.json({
          access_token: 'github-access',
          refresh_token: 'github-refresh',
          expires_in: 28800,
        });
      if (url === 'https://api.github.com/user')
        return Response.json({ id, login: `user-${id}` });
      if (url === 'https://api.github.com/user/installations?per_page=1')
        return installations === null
          ? Response.json({ message: 'Server Error' }, { status: 500 })
          : Response.json({ total_count: installations, installations: [] });
      throw new Error(`Unexpected provider URL ${url}`);
    }),
  );
}
// A sign-in, from GitHub's start to its callback.
async function signIn(session = '', back?: string) {
  const start = await db.request(
    `/auth/github/start${back === undefined ? '' : `?return=${encodeURIComponent(back)}`}`,
    {},
    session,
  );
  const state = new URL(start.headers.get('Location')!).searchParams.get(
    'state',
  )!;
  const browser = start.headers.get('Set-Cookie')!.split(';')[0];
  return db.request(
    `/auth/github/callback?state=${state}&code=authorization-code`,
    {},
    [session, browser].filter(Boolean).join('; '),
  );
}
const cookieOf = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0];
const installed = (cookie = '', query = '') =>
  db.request(`/auth/github/installed${query}`, {}, cookie);

describe('choosing repositories while signing in', () => {
  it('goes on to GitHub’s page for choosing repositories when the app isn’t installed, and back to Connections', async () => {
    github(101, 0);
    const callback = await signIn();
    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe(install);
    const back = cookieOf(callback, returnCookie)!;
    expect(back).toBe(`${returnCookie}=connections`);
    // Still signed in on the way: the session cookie came with the same answer.
    expect(cookieOf(callback, '__Host-cloudcel_session')).toBeTruthy();
    // GitHub sends the browser to the setup URL; the installation_id it adds is not used.
    const done = await installed(
      back,
      '?installation_id=1&setup_action=install',
    );
    expect(done.status).toBe(302);
    expect(done.headers.get('Location')).toBe(
      '/app/?connection=repositories#connections',
    );
    expect(done.headers.get('Set-Cookie')).toContain(`${returnCookie}=;`);
  });

  it('comes back to the CLI’s page when the sign-in started there', async () => {
    github(102, 0);
    const callback = await signIn('', 'cli-setup');
    expect(callback.headers.get('Location')).toBe(install);
    const done = await installed(cookieOf(callback, returnCookie)!);
    expect(done.headers.get('Location')).toBe(
      '/app/?connection=repositories#cli-setup',
    );
  });

  it('asks nothing more of someone who already chose repositories, or when GitHub can’t say', async () => {
    github(103, 2);
    const callback = await signIn();
    expect(callback.headers.get('Location')).toBe(
      '/app/?connection=success#connections',
    );
    expect(cookieOf(callback, returnCookie)).toBeUndefined();
    github(104, null);
    const failed = await signIn();
    expect(failed.headers.get('Location')).toBe(
      '/app/?connection=success#connections',
    );
  });

  it('does the same when an owner connects GitHub while signed in', async () => {
    const who = await db.user(5);
    github(5, 0);
    const callback = await signIn(who.cookie);
    expect(callback.headers.get('Location')).toBe(install);
    expect(
      db.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM provider_grants WHERE provider='github'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it('only goes back to a page of Shipcel’s own', async () => {
    for (const forged of [
      `${returnCookie}=https%3A%2F%2Fevil.example`,
      `${returnCookie}=cli-login%3Anot-a-code`,
      '',
    ])
      expect((await installed(forged)).headers.get('Location')).toBe(
        '/app/?connection=repositories#connections',
      );
  });
});
