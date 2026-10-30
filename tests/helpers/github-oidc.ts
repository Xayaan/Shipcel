// GitHub Actions' OIDC tokens for tests: a key pair of the test's own, served as GitHub's JWKS,
// and tokens signed with it the way GitHub makes them for a run (claims as GitHub documents
// them, docs.github.com/en/actions/reference/security/oidc). Fixtures, not GitHub's own tokens.
export const issuer = 'https://token.actions.githubusercontent.com';
export const jwksUrl = `${issuer}/.well-known/jwks`;

export type ActionsKey = CryptoKeyPair & { kid: string };
export async function actionsKey(kid: string): Promise<ActionsKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  return { ...pair, kid };
}

// GitHub's JWKS document listing these keys.
export async function jwks(keys: ActionsKey[]) {
  return Response.json({
    keys: await Promise.all(
      keys.map(async (k) => ({
        ...(await crypto.subtle.exportKey('jwk', k.publicKey)),
        kid: k.kid,
        use: 'sig',
        alg: 'RS256',
        x5t: 'thumbprint',
      })),
    ),
  });
}

const part = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
// A token for a push to main of alice/landing (repository 501, owner 42), valid for five
// minutes; `claims` and `header` change what it says.
export async function runToken(
  key: ActionsKey,
  audience: string,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) {
  const t = Math.floor(Date.now() / 1000);
  const head = part({ typ: 'JWT', alg: 'RS256', kid: key.kid, ...header });
  const body = part({
    iss: issuer,
    aud: audience,
    iat: t,
    nbf: t - 10,
    exp: t + 300,
    jti: crypto.randomUUID(),
    sub: 'repo:alice/landing:ref:refs/heads/main',
    repository: 'alice/landing',
    repository_id: '501',
    repository_owner_id: '42',
    ref: 'refs/heads/main',
    ref_type: 'branch',
    event_name: 'push',
    sha: 'd'.repeat(40),
    run_id: '7001',
    ...claims,
  });
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${Buffer.from(signature).toString('base64url')}`;
}
