// Passkeys (WebAuthn Level 2): registration and sign-in verification with ES256 (P-256)
// and RS256 keys. Attestation is not requested ("none"); user verification is required.
import { decodeCbor, type CborValue } from './cbor';
import { fromBase64Url, HttpError, sha256, toBase64Url } from './util';

export type Expected = { challenge: string; origin: string; rpId: string };
export type StoredPasskey = {
  publicKey: JsonWebKey;
  algorithm: number;
  signCount: number;
};

const invalid = () => new HttpError(400, 'Invalid passkey data.');

function readClientData(encoded: string, type: string, expected: Expected) {
  const bytes = fromBase64Url(encoded);
  let data: {
    type?: string;
    challenge?: string;
    origin?: string;
    crossOrigin?: boolean;
  };
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw invalid();
  }
  if (
    data.type !== type ||
    data.challenge !== expected.challenge ||
    data.origin !== expected.origin ||
    data.crossOrigin === true
  )
    throw new HttpError(
      400,
      'The passkey response does not match this sign-in.',
    );
  return bytes;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

async function readAuthenticatorData(bytes: Uint8Array, rpId: string) {
  if (bytes.length < 37) throw invalid();
  if (!sameBytes(bytes.slice(0, 32), await sha256(rpId)))
    throw new HttpError(400, 'The passkey belongs to another site.');
  const flags = bytes[32];
  if (!(flags & 0x01))
    throw new HttpError(400, 'The passkey did not confirm user presence.');
  if (!(flags & 0x04))
    throw new HttpError(
      400,
      'The passkey did not verify the user (PIN or biometrics).',
    );
  const signCount = new DataView(
    bytes.buffer,
    bytes.byteOffset + 33,
    4,
  ).getUint32(0);
  return { flags, signCount };
}

function coseToJwk(key: CborValue): { jwk: JsonWebKey; algorithm: number } {
  if (!(key instanceof Map)) throw invalid();
  const kty = key.get(1);
  const alg = key.get(3);
  if (kty === 2 && alg === -7) {
    const crv = key.get(-1);
    const x = key.get(-2);
    const y = key.get(-3);
    if (crv !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array))
      throw invalid();
    if (x.length !== 32 || y.length !== 32) throw invalid();
    return {
      algorithm: -7,
      jwk: { kty: 'EC', crv: 'P-256', x: toBase64Url(x), y: toBase64Url(y) },
    };
  }
  if (kty === 3 && alg === -257) {
    const n = key.get(-1);
    const e = key.get(-2);
    if (
      !(n instanceof Uint8Array) ||
      !(e instanceof Uint8Array) ||
      n.length < 256
    )
      throw invalid();
    return {
      algorithm: -257,
      jwk: { kty: 'RSA', n: toBase64Url(n), e: toBase64Url(e) },
    };
  }
  throw new HttpError(400, 'This kind of passkey is not supported.');
}

const importVerifyKey = (jwk: JsonWebKey, algorithm: number) =>
  algorithm === -7
    ? crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      )
    : crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );

// Authenticators return ECDSA signatures in DER; WebCrypto expects raw r || s.
export function derToRaw(der: Uint8Array) {
  let position = 0;
  const expect = (value: number) => {
    if (der[position++] !== value) throw invalid();
  };
  expect(0x30);
  const total = der[position++];
  if (total + 2 !== der.length) throw invalid();
  const integer = () => {
    expect(0x02);
    const length = der[position++];
    let value = der.slice(position, position + length);
    position += length;
    while (value.length > 32 && value[0] === 0) value = value.slice(1);
    if (value.length > 32) throw invalid();
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return padded;
  };
  const r = integer();
  const s = integer();
  const raw = new Uint8Array(64);
  raw.set(r);
  raw.set(s, 32);
  return raw;
}

export async function verifyRegistration(
  response: { clientDataJSON: string; attestationObject: string },
  expected: Expected,
) {
  readClientData(response.clientDataJSON, 'webauthn.create', expected);
  const { value } = decodeCbor(fromBase64Url(response.attestationObject));
  if (!(value instanceof Map)) throw invalid();
  const data = value.get('authData');
  if (!(data instanceof Uint8Array)) throw invalid();
  const { flags, signCount } = await readAuthenticatorData(data, expected.rpId);
  // Attested credential data: AAGUID (16 bytes), ID length (2), ID, COSE public key.
  if (!(flags & 0x40) || data.length < 55) throw invalid();
  const idLength = (data[53] << 8) | data[54];
  if (idLength < 16 || idLength > 1023 || data.length < 55 + idLength)
    throw invalid();
  const credentialId = data.slice(55, 55 + idLength);
  const { jwk, algorithm } = coseToJwk(decodeCbor(data, 55 + idLength).value);
  await importVerifyKey(jwk, algorithm);
  return {
    credentialId: toBase64Url(credentialId),
    publicKey: jwk,
    algorithm,
    signCount,
  };
}

export async function verifyAssertion(
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
  },
  stored: StoredPasskey,
  expected: Expected,
) {
  const clientData = readClientData(
    response.clientDataJSON,
    'webauthn.get',
    expected,
  );
  const data = fromBase64Url(response.authenticatorData);
  const { signCount } = await readAuthenticatorData(data, expected.rpId);
  const signed = new Uint8Array(data.length + 32);
  signed.set(data);
  signed.set(await sha256(clientData), data.length);
  const key = await importVerifyKey(stored.publicKey, stored.algorithm);
  const signature = fromBase64Url(response.signature);
  const valid =
    stored.algorithm === -7
      ? await crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          key,
          derToRaw(signature),
          signed,
        )
      : await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
  if (!valid) throw new HttpError(400, 'The passkey signature is not valid.');
  // A counter that does not increase suggests a cloned authenticator.
  if (stored.signCount > 0 && signCount <= stored.signCount)
    throw new HttpError(
      400,
      'This passkey was refused because it may have been copied.',
    );
  return { signCount };
}
