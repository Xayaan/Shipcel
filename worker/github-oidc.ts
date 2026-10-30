import { z } from 'zod';
import { limit } from './auth';
import { fromBase64url } from './crypto';
import { providerJSON } from './providers';
import { AppError, now, type Env } from './types';

// GitHub Actions' OIDC tokens (docs.github.com/en/actions/reference/security/oidc). The workflow
// Shipcel adds asks GitHub for one with Shipcel's address as its audience: it names the run's
// repository, branch and commit, signed by GitHub with RS256 and the keys at its JWKS address.
export const ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS = `${ACTIONS_ISSUER}/.well-known/jwks`;
// Seconds of clock difference allowed between GitHub and Cloudflare.
const SKEW = 60;
// GitHub's tokens last minutes: one that claims to last longer than this is refused.
const MAX_LIFETIME = 3600;
// GitHub's keys are kept for an hour. A key ID not among them (GitHub rotates its keys) fetches
// them again, at most once a minute.
const KEYS_FOR_MS = 3_600_000;
const REFETCH_AFTER_MS = 60_000;

const headerSchema = z.object({
  alg: z.literal('RS256'),
  kid: z.string().min(1).max(200),
});
const claimsSchema = z.object({
  iss: z.literal(ACTIONS_ISSUER),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number(),
  nbf: z.number().optional(),
  jti: z.string().min(1).max(200),
  repository: z.string().regex(/^[\w-]+\/[\w.-]+$/),
  // GitHub's IDs, as strings; up to 15 digits stay exact as numbers.
  repository_id: z.string().regex(/^[1-9]\d{0,14}$/),
  repository_owner_id: z.string().regex(/^[1-9]\d{0,14}$/),
  ref: z.string().max(300),
  ref_type: z.string().max(20),
  event_name: z.string().max(60),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  run_id: z.string().max(40),
});
export type ActionsRun = z.infer<typeof claimsSchema>;
const jwksSchema = z.object({
  keys: z.array(
    z
      .object({
        kty: z.string(),
        kid: z.string().optional(),
        n: z.string().optional(),
        e: z.string().optional(),
      })
      .passthrough(),
  ),
});

// A CI system's token signer: where its keys are, its name, and what to say when it can't be
// reached. GitLab's ID tokens are checked the same way (worker/git-sources.ts).
export type Signer = { jwks: string; name: string; unreachable: string };
const GITHUB: Signer = {
  jwks: JWKS,
  name: 'GitHub',
  unreachable:
    'Shipcel couldn’t reach GitHub to check this run. Re-run the job.',
};

const caches = new Map<string, { at: number; keys: Map<string, JsonWebKey> }>();
async function fetchKeys(signer: Signer) {
  let body: unknown;
  try {
    body = await providerJSON<unknown>(signer.jwks);
  } catch {
    throw new AppError(503, signer.unreachable);
  }
  const keys = new Map<string, JsonWebKey>();
  for (const k of jwksSchema.parse(body).keys)
    if (k.kty === 'RSA' && k.kid && k.n && k.e)
      keys.set(k.kid, { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true });
  const cache = { at: Date.now(), keys };
  caches.set(signer.jwks, cache);
  return cache;
}
async function signingKey(signer: Signer, kid: string) {
  const cache = caches.get(signer.jwks);
  const age = cache ? Date.now() - cache.at : Infinity;
  const fresh = cache && age < KEYS_FOR_MS ? cache : null;
  const keys =
    !fresh || (!fresh.keys.has(kid) && age >= REFETCH_AFTER_MS)
      ? (await fetchKeys(signer)).keys
      : fresh.keys;
  const jwk = keys.get(kid);
  return jwk
    ? crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      )
    : null;
}

const refused = (why: string) =>
  new AppError(401, `Shipcel refused GitHub’s token for this run: ${why}.`);
const decoded = (part: string): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(part)));
  } catch {
    return null;
  }
};

// What a signed token says, once its RS256 signature checks out with a key the signer lists.
export async function signedClaims(
  token: string,
  signer: Signer,
  refuse: (why: string) => AppError,
): Promise<unknown> {
  const [head, body, signature, extra] = token.split('.');
  if (!head || !body || !signature || extra !== undefined)
    throw refuse('it isn’t a signed token');
  const header = headerSchema.safeParse(decoded(head));
  if (!header.success)
    throw refuse(`it isn’t signed the way ${signer.name} signs`);
  const key = await signingKey(signer, header.data.kid);
  if (!key) throw refuse(`${signer.name} doesn’t list the key that signed it`);
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      fromBase64url(signature),
      new TextEncoder().encode(`${head}.${body}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw refuse(`${signer.name}’s signature doesn’t match`);
  return decoded(body);
}

// A token made for this Shipcel alone, valid now, not made to last longer than the signer's
// do, and used once: `once` names it for that.
export async function checkedToken(
  env: Env,
  claims: {
    aud: string | string[];
    exp: number;
    iat: number;
    nbf?: number;
  },
  options: {
    audience: string;
    lifetime: number;
    signer: string;
    once: string;
  },
  refuse: (why: string) => AppError,
) {
  const audiences = [claims.aud].flat();
  if (audiences.length !== 1 || audiences[0] !== options.audience)
    throw refuse(`it was made for another address than ${options.audience}`);
  const t = now();
  if (claims.exp <= t - SKEW) throw refuse('it expired');
  if (Math.max(claims.iat, claims.nbf ?? claims.iat) > t + SKEW)
    throw refuse('it isn’t valid yet');
  if (claims.exp - t > options.lifetime)
    throw refuse(`it lasts longer than ${options.signer}’s tokens do`);
  try {
    await limit(env, options.once, 1, claims.exp - t + SKEW);
  } catch (error) {
    if (error instanceof AppError && error.status === 429)
      throw refuse('it was used already');
    throw error;
  }
}

// The run a token describes, once GitHub's signature, its issuer, its audience (this Shipcel)
// and its times check out. Each token signs in once: a copy of it is refused.
export async function verifyActionsToken(
  env: Env,
  token: string,
  audience: string,
): Promise<ActionsRun> {
  const claims = claimsSchema.safeParse(
    await signedClaims(token, GITHUB, refused),
  );
  if (!claims.success)
    throw refused('it doesn’t describe a GitHub Actions run');
  const run = claims.data;
  await checkedToken(
    env,
    run,
    {
      audience,
      lifetime: MAX_LIFETIME,
      signer: 'GitHub',
      once: `actions-run:${run.jti}`,
    },
    refused,
  );
  return run;
}
