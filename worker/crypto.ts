import { AppError } from './types';

const encoder = new TextEncoder();
export function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
export function fromBase64url(value: string) {
  return Uint8Array.from(
    atob(value.replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0),
  );
}
export const randomToken = () =>
  base64url(crypto.getRandomValues(new Uint8Array(32)));
export async function digest(value: string) {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(value)),
    ),
  );
}
function keyBytes(secret: string | undefined) {
  if (!secret || !/^[a-f0-9]{64}$/i.test(secret))
    throw new AppError(
      503,
      'Configure the server token encryption key before connecting accounts.',
    );
  return Uint8Array.from(secret.match(/../g)!, (byte) => parseInt(byte, 16));
}
export function encryptionReady(secret?: string) {
  return !!secret && /^[a-f0-9]{64}$/i.test(secret);
}
async function key(secret?: string) {
  return crypto.subtle.importKey('raw', keyBytes(secret), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}
export async function seal(
  value: unknown,
  secret: string | undefined,
  context: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    await key(secret),
    encoder.encode(JSON.stringify(value)),
  );
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
}
export async function unseal<T>(
  value: string,
  secret: string | undefined,
  context: string,
): Promise<T> {
  const [version, nonce, payload, extra] = value.split('.');
  if (version !== 'v1' || !nonce || !payload || extra)
    throw new AppError(
      503,
      'Stored credentials cannot be read. Reconnect this account.',
    );
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64url(nonce),
        additionalData: encoder.encode(context),
      },
      await key(secret),
      fromBase64url(payload),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    throw new AppError(
      503,
      'Stored credentials cannot be read. Reconnect this account.',
    );
  }
}
