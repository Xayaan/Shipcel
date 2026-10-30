// A software passkey authenticator for tests: produces the same WebAuthn structures a
// browser and authenticator would (CBOR attestation object, authenticator data, DER
// ECDSA signatures), so the service's verification runs unchanged.
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;

export const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  ).toString('base64url');
export const fromB64url = (text: string) =>
  new Uint8Array(Buffer.from(text, 'base64url'));
export const sha256 = async (data: string | Uint8Array) =>
  new Uint8Array(
    await subtle.digest(
      'SHA-256',
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : new Uint8Array(data),
    ),
  );

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

function head(major: number, length: number) {
  if (length < 24) return [(major << 5) | length];
  if (length < 256) return [(major << 5) | 24, length];
  if (length < 65536) return [(major << 5) | 25, length >> 8, length & 255];
  return [
    (major << 5) | 26,
    (length >>> 24) & 255,
    (length >> 16) & 255,
    (length >> 8) & 255,
    length & 255,
  ];
}

export function encodeCbor(value: Cbor): Uint8Array {
  const parts: number[] = [];
  const write = (v: Cbor) => {
    if (typeof v === 'number')
      parts.push(...(v >= 0 ? head(0, v) : head(1, -1 - v)));
    else if (typeof v === 'string') {
      const bytes = new TextEncoder().encode(v);
      parts.push(...head(3, bytes.length), ...bytes);
    } else if (v instanceof Uint8Array) parts.push(...head(2, v.length), ...v);
    else if (Array.isArray(v)) {
      parts.push(...head(4, v.length));
      v.forEach(write);
    } else {
      parts.push(...head(5, v.size));
      for (const [k, item] of v) {
        write(k);
        write(item);
      }
    }
  };
  write(value);
  return new Uint8Array(parts);
}

// ECDSA raw (r || s) to DER, as authenticators send it.
export function rawToDer(raw: Uint8Array) {
  const integer = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let value = bytes.slice(i);
    if (value[0] & 0x80) value = new Uint8Array([0, ...value]);
    return [0x02, value.length, ...value];
  };
  const body = [...integer(raw.slice(0, 32)), ...integer(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

export class Authenticator {
  private keys!: webcrypto.CryptoKeyPair;
  readonly credentialId = webcrypto.getRandomValues(new Uint8Array(32));
  userHandle = '';
  signCount = 0;
  constructor(
    readonly rpId: string,
    readonly origin: string,
  ) {}

  async create(
    options: { challenge: string; user: { id: string } },
    overrides: { origin?: string } = {},
  ) {
    this.keys = (await subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )) as webcrypto.CryptoKeyPair;
    this.userHandle = options.user.id;
    const jwk = await subtle.exportKey('jwk', this.keys.publicKey);
    const cose = encodeCbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromB64url(jwk.x!)],
        [-3, fromB64url(jwk.y!)],
      ]),
    );
    const authData = new Uint8Array([
      ...(await sha256(this.rpId)),
      0x45, // user present, user verified, attested credential data
      0,
      0,
      0,
      0,
      ...new Uint8Array(16),
      this.credentialId.length >> 8,
      this.credentialId.length & 255,
      ...this.credentialId,
      ...cose,
    ]);
    const clientDataJSON = JSON.stringify({
      type: 'webauthn.create',
      challenge: options.challenge,
      origin: overrides.origin ?? this.origin,
      crossOrigin: false,
    });
    return {
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(new TextEncoder().encode(clientDataJSON)),
        attestationObject: b64url(
          encodeCbor(
            new Map<Cbor, Cbor>([
              ['fmt', 'none'],
              ['attStmt', new Map()],
              ['authData', authData],
            ]),
          ),
        ),
      },
    };
  }

  async get(
    options: { challenge: string },
    overrides: {
      signCount?: number;
      origin?: string;
      flags?: number;
      forge?: boolean;
    } = {},
  ) {
    this.signCount = overrides.signCount ?? this.signCount + 1;
    const count = this.signCount;
    const authData = new Uint8Array([
      ...(await sha256(this.rpId)),
      overrides.flags ?? 0x05, // user present, user verified
      (count >>> 24) & 255,
      (count >> 16) & 255,
      (count >> 8) & 255,
      count & 255,
    ]);
    const clientData = new TextEncoder().encode(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: options.challenge,
        origin: overrides.origin ?? this.origin,
      }),
    );
    const signed = new Uint8Array([...authData, ...(await sha256(clientData))]);
    // A forged assertion is signed by a key the service has never seen.
    const signer = overrides.forge
      ? (
          (await subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-256' },
            true,
            ['sign', 'verify'],
          )) as webcrypto.CryptoKeyPair
        ).privateKey
      : this.keys.privateKey;
    const raw = new Uint8Array(
      await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer, signed),
    );
    return {
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(rawToDer(raw)),
        userHandle: this.userHandle,
      },
    };
  }
}

export async function signingKey() {
  const pair = (await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as webcrypto.CryptoKeyPair;
  return {
    ...(await subtle.exportKey('jwk', pair.privateKey)),
    kid: 'test-key-1',
  };
}

export async function verifyJwt(token: string, jwk: webcrypto.JsonWebKey) {
  const [header, payload, signature] = token.split('.');
  const key = await subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const valid = await subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    fromB64url(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return {
    valid,
    claims: JSON.parse(Buffer.from(payload, 'base64url').toString()),
  };
}

export async function hs256(claims: Record<string, unknown>, secret: string) {
  const part = (v: unknown) =>
    b64url(new TextEncoder().encode(JSON.stringify(v)));
  const input = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}`;
  const key = await subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return `${input}.${b64url(await subtle.sign('HMAC', key, new TextEncoder().encode(input)))}`;
}
