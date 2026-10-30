// Who may use the light client, and how much: an optional key in the address, which the Worker
// checks before anything reaches the Durable Object, and a rate limit per client, which the
// object keeps (it sees every request, so its count is exact).

// With a key set (the RPC_KEY secret), every address starts with /<key>. That part comes off
// before the request goes on, so the object never sees it. Without one, anyone who finds the
// address can use it. Returns the request to pass on, or null.
export async function unlock(request, key) {
  if (!key) return request;
  const url = new URL(request.url);
  const [, first, ...rest] = url.pathname.split('/');
  if (!(await same(first, key))) return null;
  url.pathname = `/${rest.join('/')}`;
  return new Request(url, request);
}

// Compared as SHA-256 digests, so how long a comparison takes says nothing about the key.
async function same(given, key) {
  const digest = async (text) =>
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    );
  const [a, b] = await Promise.all([digest(given), digest(key)]);
  return a.every((byte, i) => byte === b[i]);
}

// Whom a request counts against: its IP address, or for IPv6 its /64, which one person usually
// holds whole. Cloudflare sets CF-Connecting-IP; a caller can't.
export function clientOf(ip) {
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  if (ip.includes('.')) return ip.slice(ip.lastIndexOf(':') + 1); // ::ffff:192.0.2.1
  const [head, tail] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const zeros = Array(Math.max(0, 8 - left.length - right.length)).fill('0');
  const groups = [...left, ...zeros, ...right].slice(0, 4);
  return `${groups.map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// Each client may make `burst` calls at once, refilled at `perSecond`; a batch counts each call
// in it. Kept in memory: a restart forgives everyone.
export class RateLimit {
  #clients = new Map(); // client -> { tokens, at }, the most recently seen last
  #perSecond;
  #burst;
  #maxClients;
  #now;

  constructor({ perSecond, burst, maxClients = 10_000, now = Date.now }) {
    this.#perSecond = perSecond;
    this.#burst = burst;
    this.#maxClients = maxClients;
    this.#now = now;
  }

  // Takes `calls` from the client's allowance: 0 when they may go ahead, or else the whole
  // seconds until they could.
  take(client, calls = 1) {
    const now = this.#now();
    const tokens = this.#tokens(this.#clients.get(client), now);
    if (tokens < calls) return Math.ceil((calls - tokens) / this.#perSecond);
    this.#clients.delete(client);
    this.#clients.set(client, { tokens: tokens - calls, at: now });
    if (this.#clients.size > this.#maxClients) this.forget();
    return 0;
  }

  // Forgets the clients whose allowance is whole again, then, while there are still too many,
  // those seen longest ago.
  forget() {
    const now = this.#now();
    for (const [client, seen] of this.#clients)
      if (this.#tokens(seen, now) >= this.#burst) this.#clients.delete(client);
    for (const client of this.#clients.keys()) {
      if (this.#clients.size <= this.#maxClients) break;
      this.#clients.delete(client);
    }
  }

  get size() {
    return this.#clients.size;
  }

  #tokens(seen, now) {
    if (!seen) return this.#burst;
    const refilled = ((now - seen.at) / 1000) * this.#perSecond;
    return Math.min(this.#burst, seen.tokens + refilled);
  }
}
