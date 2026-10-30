// Passkey sign-up and sign-in endpoints for the hosted sign-in page.
import { complete, issuerOf } from './oidc';
import {
  createUser,
  getAuthRequest,
  readSettings,
  requireSignin,
  startSession,
  type Env,
} from './store';
import {
  HttpError,
  json,
  now,
  randomToken,
  readJson,
  requireSameOrigin,
} from './util';
import { verifyAssertion, verifyRegistration } from './webauthn';

const CHALLENGE_LIFETIME = 300;
const rpIdOf = (request: Request) => new URL(request.url).hostname;
const text = (value: unknown, max: number) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.trim().length <= max
    ? value.trim()
    : null;

// Every passkey call comes from the hosted page in the browser that started the sign-in,
// while sign-in is on.
async function body(request: Request, env: Env) {
  requireSameOrigin(request);
  requireSignin(await readSettings(env));
  const data = await readJson(request);
  if (!data || typeof data !== 'object')
    throw new HttpError(400, 'Invalid request.');
  const fields = data as Record<string, unknown>;
  return {
    data: fields,
    authRequest: await getAuthRequest(env, fields.request, request),
  };
}

async function newChallenge(
  env: Env,
  requestId: string,
  kind: 'register' | 'login',
  extra: { userHandle?: string; name?: string; email?: string | null } = {},
) {
  const id = randomToken(16);
  const challenge = randomToken(32);
  await env.DB.prepare(
    'INSERT INTO challenges (id,request_id,kind,challenge,user_handle,name,email,expires_at) VALUES (?,?,?,?,?,?,?,?)',
  )
    .bind(
      id,
      requestId,
      kind,
      challenge,
      extra.userHandle ?? null,
      extra.name ?? null,
      extra.email ?? null,
      now() + CHALLENGE_LIFETIME,
    )
    .run();
  return { id, challenge };
}

// Each challenge works once, for the sign-in request it was issued to.
async function useChallenge(
  env: Env,
  id: unknown,
  requestId: string,
  kind: string,
) {
  if (typeof id !== 'string') throw new HttpError(400, 'Invalid request.');
  const row = await env.DB.prepare(
    'DELETE FROM challenges WHERE id=? AND request_id=? AND kind=? AND expires_at>? RETURNING *',
  )
    .bind(id, requestId, kind, now())
    .first<{
      challenge: string;
      user_handle: string | null;
      name: string | null;
      email: string | null;
    }>();
  if (!row)
    throw new HttpError(400, 'This passkey request expired. Try again.');
  return row;
}

function credential(data: Record<string, unknown>) {
  const value = data.credential as
    | { rawId?: unknown; type?: unknown; response?: Record<string, unknown> }
    | undefined;
  if (
    !value ||
    value.type !== 'public-key' ||
    typeof value.rawId !== 'string' ||
    !value.response
  )
    throw new HttpError(400, 'Invalid passkey response.');
  const field = (name: string) => {
    const v = value.response![name];
    if (typeof v !== 'string' || v.length > 16384)
      throw new HttpError(400, 'Invalid passkey response.');
    return v;
  };
  return { rawId: value.rawId, field, response: value.response };
}

export async function registerOptions(request: Request, env: Env) {
  const { data, authRequest } = await body(request, env);
  const name = text(data.name, 80);
  if (!name) throw new HttpError(400, 'Enter your name.');
  const email = data.email ? text(data.email, 254) : null;
  if (data.email && (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    throw new HttpError(400, 'Enter a valid email address, or leave it empty.');
  const settings = await readSettings(env);
  const userHandle = randomToken(16);
  const { id, challenge } = await newChallenge(
    env,
    authRequest.id,
    'register',
    { userHandle, name, email },
  );
  return json({
    challengeId: id,
    publicKey: {
      challenge,
      rp: { id: rpIdOf(request), name: settings.appName },
      user: { id: userHandle, name: email ?? name, displayName: name },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      timeout: CHALLENGE_LIFETIME * 1000,
      attestation: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
    },
  });
}

export async function registerVerify(request: Request, env: Env) {
  const { data, authRequest } = await body(request, env);
  const challenge = await useChallenge(
    env,
    data.challengeId,
    authRequest.id,
    'register',
  );
  const { rawId, field } = credential(data);
  const result = await verifyRegistration(
    {
      clientDataJSON: field('clientDataJSON'),
      attestationObject: field('attestationObject'),
    },
    {
      challenge: challenge.challenge,
      origin: issuerOf(request),
      rpId: rpIdOf(request),
    },
  );
  if (result.credentialId !== rawId)
    throw new HttpError(400, 'Invalid passkey response.');
  const exists = await env.DB.prepare('SELECT 1 FROM passkeys WHERE id=?')
    .bind(result.credentialId)
    .first();
  if (exists)
    throw new HttpError(
      409,
      'This passkey is already registered. Sign in instead.',
    );
  // The email is not verified: it is never used to link accounts.
  const userId = await createUser(env, {
    id: challenge.user_handle!,
    email: challenge.email,
    emailVerified: false,
    name: challenge.name,
    picture: null,
  });
  await env.DB.prepare(
    'INSERT INTO passkeys (id,user_id,public_key,algorithm,sign_count,created_at) VALUES (?,?,?,?,?,?)',
  )
    .bind(
      result.credentialId,
      userId,
      JSON.stringify(result.publicKey),
      result.algorithm,
      result.signCount,
      now(),
    )
    .run();
  const sessionCookie = await startSession(env, userId);
  return json(
    { redirect: await complete(env, authRequest.id, userId) },
    { headers: { 'Set-Cookie': sessionCookie } },
  );
}

export async function loginOptions(request: Request, env: Env) {
  const { data, authRequest } = await body(request, env);
  const { id, challenge } = await newChallenge(env, authRequest.id, 'login');
  return json({
    challengeId: id,
    publicKey: {
      challenge,
      rpId: rpIdOf(request),
      timeout: CHALLENGE_LIFETIME * 1000,
      userVerification: 'required',
      allowCredentials: [],
    },
  });
}

export async function loginVerify(request: Request, env: Env) {
  const { data, authRequest } = await body(request, env);
  const challenge = await useChallenge(
    env,
    data.challengeId,
    authRequest.id,
    'login',
  );
  const { rawId, field, response } = credential(data);
  const passkey = await env.DB.prepare(
    'SELECT p.*, u.disabled FROM passkeys p JOIN users u ON u.id=p.user_id WHERE p.id=?',
  )
    .bind(rawId)
    .first<{
      user_id: string;
      public_key: string;
      algorithm: number;
      sign_count: number;
      disabled: number;
    }>();
  if (!passkey)
    throw new HttpError(400, 'This passkey is not registered for this app.');
  if (
    typeof response.userHandle === 'string' &&
    response.userHandle !== passkey.user_id
  )
    throw new HttpError(400, 'This passkey belongs to another account.');
  const { signCount } = await verifyAssertion(
    {
      clientDataJSON: field('clientDataJSON'),
      authenticatorData: field('authenticatorData'),
      signature: field('signature'),
    },
    {
      publicKey: JSON.parse(passkey.public_key),
      algorithm: passkey.algorithm,
      signCount: passkey.sign_count,
    },
    {
      challenge: challenge.challenge,
      origin: issuerOf(request),
      rpId: rpIdOf(request),
    },
  );
  if (passkey.disabled) throw new HttpError(403, 'This account is disabled.');
  await env.DB.prepare(
    'UPDATE passkeys SET sign_count=?, last_used_at=? WHERE id=?',
  )
    .bind(signCount, now(), rawId)
    .run();
  const sessionCookie = await startSession(env, passkey.user_id);
  return json(
    { redirect: await complete(env, authRequest.id, passkey.user_id) },
    { headers: { 'Set-Cookie': sessionCookie } },
  );
}
