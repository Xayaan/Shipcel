// Small helpers shared by sign-in and realtime. Runs in the Workers runtime.

export const now = () => Math.floor(Date.now() / 1000);

export function toBase64Url(bytes: ArrayBuffer | Uint8Array) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function fromBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]*$/.test(value))
    throw new HttpError(400, 'Invalid encoding.');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export const randomToken = (bytes = 32) =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256(data: string | Uint8Array<ArrayBuffer>) {
  const input =
    typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

export const hashToken = async (token: string) =>
  toBase64Url(await sha256(token));

// Constant-time comparison of two strings of possibly different length.
export function safeEqual(a: string, b: string) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++)
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

export const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'invalid_request',
  ) {
    super(message);
  }
}

export const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...init.headers,
    },
  });

// Requests from the hosted sign-in page must come from this origin (CSRF).
export function requireSameOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  if (origin !== new URL(request.url).origin)
    throw new HttpError(403, 'Cross-site request refused.');
  if (!request.headers.get('Content-Type')?.startsWith('application/json'))
    throw new HttpError(415, 'Send JSON.');
}

export async function readJson(request: Request, limit = 65536) {
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, 'Request is too large.');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

// Host-only, HTTPS-only cookies that JavaScript can't read.
export const hostCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

export function cookie(request: Request, name: string) {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}
