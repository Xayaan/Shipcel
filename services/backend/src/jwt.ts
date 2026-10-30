// JSON Web Tokens: ES256 for sign-in tokens (public keys published as JWKS) and HS256 for
// realtime channel tokens that the app's own server signs with the realtime secret.
import { fromBase64Url, HttpError, now, toBase64Url } from './util';

export type Claims = Record<string, unknown> & { exp?: number };
type SigningKey = JsonWebKey & { kid: string };

const encodePart = (value: unknown) =>
  toBase64Url(new TextEncoder().encode(JSON.stringify(value)));

const ecdsa = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export function parseSigningKey(secret: string | undefined) {
  if (!secret)
    throw new HttpError(500, 'Sign-in is not configured.', 'server_error');
  const key = JSON.parse(secret) as SigningKey;
  if (key.kty !== 'EC' || key.crv !== 'P-256' || !key.d || !key.kid)
    throw new HttpError(500, 'Sign-in key is invalid.', 'server_error');
  return key;
}

export function publicJwk(key: SigningKey) {
  return {
    kty: key.kty,
    crv: key.crv,
    x: key.x,
    y: key.y,
    kid: key.kid,
    alg: 'ES256',
    use: 'sig',
  };
}

// Access tokens use typ "at+jwt" (RFC 9068) so they can't be confused with ID tokens.
export async function signEs256(claims: Claims, key: SigningKey, typ = 'JWT') {
  const input = `${encodePart({ alg: 'ES256', typ, kid: key.kid })}.${encodePart(claims)}`;
  const privateKey = await crypto.subtle.importKey('jwk', key, ecdsa, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${toBase64Url(signature)}`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function split(token: string) {
  const parts = token.split('.');
  if (parts.length !== 3)
    throw new HttpError(401, 'Invalid token.', 'invalid_token');
  let header: unknown;
  let claims: unknown;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1])));
    signature = fromBase64Url(parts[2]);
  } catch {
    throw new HttpError(401, 'Invalid token.', 'invalid_token');
  }
  // A header or payload such as null or [] is not a JWT.
  if (!isObject(header) || !isObject(claims))
    throw new HttpError(401, 'Invalid token.', 'invalid_token');
  return {
    header: header as { alg?: unknown; kid?: unknown; typ?: unknown },
    claims: claims as Claims,
    input: new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    signature,
  };
}

function checkTime(claims: Claims) {
  if (typeof claims.exp !== 'number' || claims.exp <= now())
    throw new HttpError(401, 'Token expired.', 'invalid_token');
}

export async function verifyEs256(
  token: string,
  key: SigningKey,
  options: { typ?: string; allowExpired?: boolean } = {},
) {
  const { header, claims, input, signature } = split(token);
  if (header.alg !== 'ES256' || header.kid !== key.kid)
    throw new HttpError(401, 'Invalid token.', 'invalid_token');
  if (options.typ && header.typ !== options.typ)
    throw new HttpError(401, 'Invalid token.', 'invalid_token');
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: key.kty, crv: key.crv, x: key.x, y: key.y },
    ecdsa,
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    signature,
    input,
  );
  if (!valid) throw new HttpError(401, 'Invalid token.', 'invalid_token');
  if (!options.allowExpired) checkTime(claims);
  return claims;
}

const hmacKey = (secret: string, usage: KeyUsage) =>
  crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );

export async function signHs256(claims: Claims, secret: string) {
  const input = `${encodePart({ alg: 'HS256', typ: 'JWT' })}.${encodePart(claims)}`;
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret, 'sign'),
    new TextEncoder().encode(input),
  );
  return `${input}.${toBase64Url(signature)}`;
}

export async function verifyHs256(token: string, secret: string) {
  const { header, claims, input, signature } = split(token);
  if (header.alg !== 'HS256')
    throw new HttpError(401, 'Invalid token.', 'invalid_token');
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret, 'verify'),
    signature,
    input,
  );
  if (!valid) throw new HttpError(401, 'Invalid token.', 'invalid_token');
  checkTime(claims);
  return claims;
}

export const tokenAlgorithm = (token: string) => {
  try {
    return split(token).header.alg;
  } catch {
    return undefined;
  }
};
