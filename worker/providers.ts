import { z } from 'zod';
import { AppError } from './types';

// errorDetail: surface the provider's first error message (bounded, control characters
// removed). Only for calls whose errors describe the user's own input, such as D1 SQL.
// missingCodes: provider error codes that mean "not found", reported as 404 whatever the
// HTTP status.
// oauth: a token endpoint. Its OAuth error answer (RFC 6749 section 5.2: a 400 or 401 with an
// `error` code) is thrown as an OAuthError carrying the code.
type ProviderOptions = {
  errorDetail?: boolean;
  timeout?: number;
  missingCodes?: number[];
  oauth?: boolean;
};
// A token endpoint's refusal, with the provider's code: invalid_grant, invalid_client, or
// GitHub's own, such as bad_refresh_token, which GitHub sends with a 200.
export class OAuthError extends AppError {
  constructor(public code: string) {
    super(401, 'Authorization was rejected. Reconnect the account.');
  }
}
export function oauthError(body: unknown) {
  const code = (body as { error?: unknown } | null)?.error;
  return typeof code === 'string' && /^[\w.-]{1,100}$/.test(code)
    ? new OAuthError(code)
    : null;
}
const missing = (body: unknown, codes?: number[]) =>
  !!codes &&
  ((body as { errors?: { code?: unknown }[] } | null)?.errors ?? []).some(
    (e) => typeof e?.code === 'number' && codes.includes(e.code),
  );
const notFound = () =>
  new AppError(
    404,
    'The provider resource was not found or is not accessible.',
  );
function detail(body: unknown) {
  const message = (body as { errors?: { message?: unknown }[] } | null)
    ?.errors?.[0]?.message;
  return typeof message === 'string'
    ? message
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, 300)
    : '';
}

// A refusal names the provider's own reason when it gives one in its structured errors
// (never a raw body), and the server log names the request, without its query string.
async function denied(response: Response, url: string, init: RequestInit) {
  let reason = '';
  try {
    reason = detail(JSON.parse(await boundedText(response, 65536)));
  } catch {
    /* Not JSON: no reason to show. */
  }
  console.warn(
    `Provider denied ${init.method ?? 'GET'} ${new URL(url).pathname}${reason ? `: ${reason}` : ''}`,
  );
  return new AppError(
    403,
    `The provider denied access${reason ? ` (${reason})` : ''}. Check the app installation and granted permissions.`,
  );
}

async function boundedText(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '',
    bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      text += decoder.decode(chunk.value, { stream: true });
      if (bytes >= limit) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    return '';
  }
  return text;
}

export async function providerJSON<T>(
  url: string,
  init: RequestInit = {},
  options: ProviderOptions = {},
): Promise<T> {
  let response: Response;
  try {
    // Workers accept only "follow" or "manual"; a redirect is never followed with
    // credentials and is treated as a failed response below.
    response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeout ?? 12000),
    });
  } catch {
    throw new AppError(
      502,
      'The provider did not respond. Check its dashboard before retrying a resource operation.',
    );
  }
  if (options.oauth && (response.status === 400 || response.status === 401)) {
    let body: unknown = null;
    try {
      body = JSON.parse(await boundedText(response, 65536));
    } catch {
      /* Not an OAuth error answer: it fails below like any other. */
    }
    const refused = oauthError(body);
    if (refused) throw refused;
  }
  if (response.status === 401)
    throw new AppError(
      401,
      'Provider authorization expired. Reconnect the account.',
    );
  if (response.status === 403) throw await denied(response, url, init);
  if (response.status === 429)
    throw new AppError(
      429,
      'The provider is rate limiting requests. Try again later.',
    );
  if (!response.ok && (options.errorDetail || options.missingCodes)) {
    const text = await boundedText(response, 65536);
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* Truncated or non-JSON bodies fall back to the generic message. */
    }
    if (missing(body, options.missingCodes)) throw notFound();
    const message = options.errorDetail ? detail(body) : '';
    if (message) throw new AppError(502, `Cloudflare reported: ${message}`);
  }
  if (!response.ok)
    throw response.status === 404
      ? notFound()
      : new AppError(
          502,
          'The provider rejected this operation. Check provider setup and account permissions.',
        );
  const reader = response.body?.getReader();
  if (!reader)
    throw new AppError(502, 'The provider returned an empty response.');
  const decoder = new TextDecoder();
  let text = '',
    bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2_000_000) {
        await reader.cancel();
        throw new AppError(502, 'Provider response exceeded the allowed size.');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      502,
      'The provider response was interrupted. Check its dashboard before retrying.',
    );
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError(502, 'The provider returned an invalid response.');
  }
}
export function github<T>(token: string, path: string, init: RequestInit = {}) {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new AppError(400, 'Invalid GitHub API path.');
  return providerJSON<T>(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Shipcel',
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
}
// The whole response envelope, for lists that page with result_info.
async function envelope<T>(
  token: string,
  path: string,
  init: RequestInit = {},
  options: ProviderOptions = {},
) {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new AppError(400, 'Invalid Cloudflare API path.');
  const result = await providerJSON<{
    success: boolean;
    result: T;
    result_info?: Record<string, unknown>;
  }>(
    `https://api.cloudflare.com/client/v4${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body && !(init.body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...init.headers,
      },
    },
    options,
  );
  if (!result.success && missing(result, options.missingCodes))
    throw notFound();
  if (!result.success && options.errorDetail && detail(result))
    throw new AppError(502, `Cloudflare reported: ${detail(result)}`);
  if (!result.success)
    throw new AppError(
      502,
      'Cloudflare could not complete this request. Check the selected account and permissions.',
    );
  return result;
}
export async function cloudflare<T>(
  token: string,
  path: string,
  init: RequestInit = {},
  options: ProviderOptions = {},
) {
  return (await envelope<T>(token, path, init, options)).result;
}
export async function cloudflarePage<T>(
  token: string,
  path: string,
  init: RequestInit = {},
) {
  const { result, result_info } = await envelope<T>(token, path, init);
  return { result, info: result_info ?? {} };
}
// A raw body (a KV value, an R2 object), streamed. The timeout covers the response
// headers only, so a long download is not cut off.
export async function cloudflareBody(
  token: string,
  path: string,
  headers: Record<string, string> = {},
) {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new AppError(400, 'Invalid Cloudflare API path.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { Authorization: `Bearer ${token}`, ...headers },
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch {
    throw new AppError(
      502,
      'The provider did not respond. Check its dashboard before retrying a resource operation.',
    );
  } finally {
    clearTimeout(timer);
  }
  if (response.ok) return response;
  await response.body?.cancel();
  if (response.status === 401)
    throw new AppError(
      401,
      'Provider authorization expired. Reconnect the account.',
    );
  if (response.status === 403)
    throw new AppError(
      403,
      'The provider denied access. Check the app installation and granted permissions.',
    );
  if (response.status === 429)
    throw new AppError(
      429,
      'The provider is rate limiting requests. Try again later.',
    );
  throw response.status === 404
    ? notFound()
    : new AppError(
        502,
        'The provider rejected this operation. Check provider setup and account permissions.',
      );
}
export const providerPath = (value: string) => encodeURIComponent(value);

// The D1 databases a Worker binds, by binding name, from its settings (`script` is the
// Worker's path under its account).
export async function workerDatabases(token: string, script: string) {
  const { bindings = [] } = z
    .object({
      bindings: z
        .array(
          z.object({
            name: z.string(),
            type: z.string(),
            id: z.string().optional(),
          }),
        )
        .optional(),
    })
    .parse(await cloudflare(token, `${script}/settings`));
  return bindings
    .filter((b) => b.type === 'd1' && b.id)
    .map((b) => ({ binding: b.name, id: b.id! }));
}
