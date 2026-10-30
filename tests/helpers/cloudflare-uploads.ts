// A fake Cloudflare for direct uploads: the assets upload session, multipart file uploads,
// script uploads, the per-script workers.dev route, the Workers API, versions,
// deployments, runtime secrets and script settings (Workers Logs). It records what it received so tests can check it.
import { expect } from 'vitest';

export const account = 'a'.repeat(32);
export const tag = 'c'.repeat(32);

export function cloudflareUploads() {
  const state = {
    stored: new Map<string, { content: string; type: string }>(),
    workers: new Map<
      string,
      { tag: string; metadata: Record<string, unknown> }
    >(),
    route: null as { enabled: boolean; previews_enabled: boolean } | null,
    calls: [] as {
      method: string;
      path: string;
      headers: Headers;
      body?: unknown;
    }[],
    // Version IDs, newest first, and the one serving traffic.
    versions: [] as string[],
    live: null as string | null,
    // Deployments, newest first: the version each one sent all traffic to.
    deployments: [] as string[],
    // Like Cloudflare, an upload session for a new name creates an empty Worker: no code,
    // no files, never deployed, until a script is uploaded.
    placeholders: new Set<string>(),
    secrets: new Map<string, string>(),
    // Metadata of versions uploaded without deploying them (wrangler versions upload).
    uploadedVersions: [] as Record<string, unknown>[],
    // Workers Logs: null, as Cloudflare reports it for a Worker made through its API. Like
    // Cloudflare (seen live on 9 Oct 2026), a script upload replaces it with its metadata's;
    // versions, deployments and secrets leave it. settingsStatus other than 200 fails reads.
    observability: null as Record<string, unknown> | null,
    settingsStatus: 200,
  };
  const cf = (result: unknown, status = 200) =>
    Response.json({ success: true, result }, { status });
  const handler = async (
    raw: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = new URL(String(raw));
    const path = url.pathname.replace('/client/v4', '');
    const method = init.method || 'GET';
    const headers = new Headers(init.headers);
    state.calls.push({
      method,
      path: path + url.search,
      headers,
      body: init.body,
    });
    const script = path.match(
      /^\/accounts\/a{32}\/workers\/(?:scripts|services|workers)\/([a-z0-9-]+)/,
    )?.[1];
    if (path === `/accounts/${account}/workers/subdomain`)
      return cf({ subdomain: 'test-account' });
    if (path === `/accounts/${account}/workers/scripts` && method === 'GET')
      return cf([...state.workers].map(([id, w]) => ({ id, tag: w.tag })));
    if (path.endsWith('/assets-upload-session')) {
      if (script && !state.workers.has(script)) state.placeholders.add(script);
      expect(headers.get('Authorization')).toBe(
        'Bearer cloudflare-access-secret',
      );
      const { manifest } = JSON.parse(String(init.body)) as {
        manifest: Record<string, { hash: string }>;
      };
      const needed = [
        ...new Set(Object.values(manifest).map((m) => m.hash)),
      ].filter((h) => !state.stored.has(h));
      return needed.length
        ? cf({ jwt: 'upload-jwt', buckets: [needed] })
        : cf({ jwt: 'completion-jwt', buckets: [] });
    }
    if (path === `/accounts/${account}/workers/assets/upload`) {
      expect(url.searchParams.get('base64')).toBe('true');
      expect(headers.get('Authorization')).toBe('Bearer upload-jwt');
      for (const [hash, value] of (init.body as FormData).entries()) {
        const part = value as File;
        state.stored.set(hash, { content: await part.text(), type: part.type });
      }
      return cf({ jwt: 'completion-jwt' }, 201);
    }
    if (
      script &&
      path.startsWith(`/accounts/${account}/workers/services/`) &&
      state.placeholders.has(script)
    )
      return cf({
        id: script,
        default_environment: {
          script: {
            tag: 'e'.repeat(32),
            deployment_id: '',
            has_assets: false,
            has_modules: false,
          },
        },
      });
    if (script && path.startsWith(`/accounts/${account}/workers/services/`))
      return state.workers.has(script)
        ? cf({
            default_environment: {
              script: {
                tag: state.workers.get(script)!.tag,
                deployment_id: 'd'.repeat(32),
                has_assets: true,
                has_modules: false,
              },
            },
          })
        : Response.json(
            { success: false, errors: [{ code: 10090, message: 'not found' }] },
            { status: 404 },
          );
    if (
      script &&
      path === `/accounts/${account}/workers/scripts/${script}` &&
      method === 'PUT'
    ) {
      const form = init.body as FormData;
      const metadata = JSON.parse(String(form.get('metadata')));
      state.placeholders.delete(script);
      state.workers.set(script, { tag, metadata });
      state.observability = metadata.observability ?? null;
      const n = state.versions.length + 1;
      // Version IDs are UUID v4, like Cloudflare's.
      const id = `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
      state.versions.unshift(id);
      state.live = id;
      state.deployments.unshift(id);
      return cf({ id: script, tag, deployment_id: id.replace(/-/g, '') });
    }
    if (script && path.endsWith('/subdomain') && method === 'POST') {
      expect(headers.get('Cloudflare-Workers-Script-Api-Date')).toBe(
        '2025-08-01',
      );
      state.route = JSON.parse(String(init.body));
      return cf(state.route);
    }
    if (script && path === `/accounts/${account}/workers/workers/${script}`)
      return cf({
        id: script,
        subdomain: {
          ...state.route,
          preview_url_suffix: `-${script}.test-account.workers.dev`,
        },
      });
    if (
      script &&
      path.endsWith(`/scripts/${script}/versions`) &&
      method === 'POST'
    ) {
      // A new version that serves no traffic until it is deployed.
      const form = init.body as FormData;
      state.uploadedVersions.push(JSON.parse(String(form.get('metadata'))));
      const n = state.versions.length + 1;
      const id = `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
      state.versions.unshift(id);
      return cf({ id, number: n, metadata: { has_preview: true } });
    }
    if (
      script &&
      path.endsWith(`/scripts/${script}/versions`) &&
      method === 'GET'
    )
      return cf({
        items: state.versions.map((id, i) => ({
          id,
          number: state.versions.length - i,
          metadata: {
            created_on: new Date(Date.UTC(2026, 9, 8, 0, i)).toISOString(),
          },
          annotations: { 'workers/message': 'Direct upload from Shipcel' },
        })),
      });
    const one = path.match(/\/versions\/([0-9a-f-]{36})$/)?.[1];
    if (script && one && method === 'GET')
      return state.versions.includes(one)
        ? cf({ id: one, number: 1 })
        : Response.json({ success: false, errors: [] }, { status: 404 });
    if (script && path.endsWith(`/scripts/${script}/deployments`)) {
      if (method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          versions: { version_id: string }[];
        };
        state.live = body.versions[0].version_id;
        state.deployments.unshift(state.live);
        return cf({ id: '50000000-0000-4000-8000-000000000002' });
      }
      return cf({
        deployments: state.deployments.map((version, i) => ({
          id: `50000000-0000-4000-8000-${String(state.deployments.length - i).padStart(12, '0')}`,
          created_on: new Date(
            Date.UTC(2026, 9, 8, 1, state.deployments.length - i),
          ).toISOString(),
          versions: [{ version_id: version, percentage: 100 }],
        })),
      });
    }
    // A Worker's settings, with the bindings a deploy from a computer reuses.
    if (
      script &&
      path === `/accounts/${account}/workers/scripts/${script}/settings` &&
      method === 'GET'
    )
      return cf({ bindings: [] });
    if (script && path.endsWith(`/scripts/${script}/script-settings`)) {
      if (state.settingsStatus !== 200)
        return Response.json(
          { success: false, errors: [{ code: 10013, message: 'unavailable' }] },
          { status: state.settingsStatus },
        );
      if (method === 'PATCH') {
        expect(headers.get('Content-Type')).toBe('application/json');
        state.observability = (
          JSON.parse(String(init.body)) as {
            observability: Record<string, unknown>;
          }
        ).observability;
      }
      return cf({
        logpush: false,
        tags: null,
        tail_consumers: null,
        observability: state.observability,
      });
    }
    const secret = path.match(/\/secrets\/([A-Za-z0-9_]+)$/)?.[1];
    if (script && secret && method === 'DELETE') {
      state.secrets.delete(secret);
      return cf(null);
    }
    if (script && path.endsWith(`/scripts/${script}/secrets`)) {
      if (method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          name: string;
          text: string;
        };
        state.secrets.set(body.name, body.text);
        return cf({ name: body.name, type: 'secret_text' });
      }
      return cf(
        [...state.secrets.keys()].map((name) => ({
          name,
          type: 'secret_text',
        })),
      );
    }
    throw new Error(`Unexpected ${method} ${url}`);
  };
  return { state, handler };
}
