// Static assets for direct uploads, shared by the API, the dashboard's drag-and-drop, the
// shipcel CLI and the MCP server so all of them hash and validate files the same way.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// Cloudflare's static-assets limits on the Workers Free plan are 20,000 files per version
// and 25 MiB per file. Through Shipcel a file can be up to 24 MiB, so it still fits in one
// upload request after base64 encoding.
export const MAX_FILES = 20000;
export const MAX_FILE_BYTES = 24 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 34 * 1024 * 1024;
export const MAX_WORKER_BYTES = 1024 * 1024;
export const MAX_RULES_BYTES = 64 * 1024;

// Files that configure the deployment instead of being served.
export const SPECIAL_FILES = ['/_worker.js', '/_redirects', '/_headers'];

export function extensionOf(path: string) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

// Cloudflare's asset hash, as Wrangler computes it: BLAKE3 of the base64 content followed
// by the extension, first 32 hex characters.
export const assetHash = (base64: string, path: string) =>
  bytesToHex(
    blake3(new TextEncoder().encode(base64 + extensionOf(path))),
  ).slice(0, 32);

export function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// A path served from the site root: /index.html, /assets/app.js. No "..", empty or
// hidden segments (except /.well-known), no backslashes or control characters.
export function assetPathProblem(path: string) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 1024)
    return 'must start with / and be at most 1024 characters';
  if (/[\\\u0000-\u001f\u007f?#]/.test(path))
    return 'contains a character that is not allowed';
  const segments = path.slice(1).split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..'))
    return 'has an empty, "." or ".." segment';
  if (
    segments.some(
      (s, i) => s.startsWith('.') && !(i === 0 && s === '.well-known'),
    )
  )
    return 'is a hidden file';
  return null;
}

const types: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  json: 'application/json',
  map: 'application/json',
  webmanifest: 'application/manifest+json',
  xml: 'application/xml',
  rss: 'application/rss+xml',
  atom: 'application/atom+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  zip: 'application/zip',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};

// The Content-Type Cloudflare serves the file with. "application/null" tells Cloudflare to
// send no Content-Type, as Wrangler does for unknown types.
export function contentTypeOf(path: string) {
  const type = types[extensionOf(path).toLowerCase()];
  if (!type) return 'application/null';
  return type.startsWith('text/') ? `${type}; charset=utf-8` : type;
}
