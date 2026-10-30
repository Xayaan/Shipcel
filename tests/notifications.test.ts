import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { database, projectInput } from './helpers/database';
import { now } from '../worker/types';
import { deliverNotifications, notify } from '../worker/notifications';
import { cloudflareUploads } from './helpers/cloudflare-uploads';
import app from '../worker/index';

// Deploy notifications: one webhook per project (Slack, Discord or any HTTPS endpoint).
// Events go to an outbox and the scheduled handler delivers them, signed, with retries.
let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>,
  projectId: string;
const hook = 'https://hooks.example.com/services/T000/B000/secret-path';
let received: {
  url: string;
  headers: Headers;
  body: string;
  redirect?: string;
}[];
let answer: number;

const request = (path: string, init: RequestInit = {}, cookie = who.cookie) =>
  db.request(`/projects/${projectId}${path}`, init, cookie);
const configure = (body: Record<string, unknown>) =>
  request('/notifications', { method: 'PUT', body: JSON.stringify(body) });
const deliveries = () =>
  db.sqlite
    .prepare(
      'SELECT event, status, attempts FROM webhook_deliveries ORDER BY created_at, rowid',
    )
    .all();

beforeEach(async () => {
  db = database();
  who = await db.user(1);
  const created = await db.request(
    '/projects',
    { method: 'POST', body: JSON.stringify(projectInput('notify-app')) },
    who.cookie,
  );
  projectId = ((await created.json()) as { id: string }).id;
  received = [];
  answer = 200;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
      const url = String(raw);
      if (url.startsWith('https://hooks.example.com/')) {
        received.push({
          url,
          headers: new Headers(init.headers),
          body: String(init.body),
          redirect: init.redirect,
        });
        return new Response('ok', { status: answer });
      }
      throw new Error(`Unexpected ${url}`);
    }),
  );
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe('webhook settings', () => {
  it('keeps the address encrypted, shows only its host, and gives a signing secret once', async () => {
    const response = await configure({
      url: hook,
      events: ['deployment.ready', 'deployment.failed'],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      host: string;
      events: string[];
      signingSecret: string;
    };
    expect(body).toMatchObject({
      host: 'hooks.example.com',
      events: ['deployment.ready', 'deployment.failed'],
    });
    expect(body.signingSecret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const shown = await (await request('/notifications')).json();
    expect(shown).toMatchObject({
      webhook: {
        host: 'hooks.example.com',
        events: ['deployment.ready', 'deployment.failed'],
        lastStatus: null,
      },
    });
    const stored = JSON.stringify(
      db.sqlite.prepare('SELECT * FROM project_webhooks').all(),
    );
    expect(stored).not.toContain('secret-path');
    expect(stored).not.toContain(body.signingSecret);
    expect(JSON.stringify(shown)).not.toContain('secret-path');
  });

  it('refuses addresses that are not public https endpoints, and unknown events', async () => {
    for (const url of [
      'http://hooks.example.com/x',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://user:pass@hooks.example.com/x',
      'https://intranet/x',
      'https://printer.local/x',
      'not a url',
    ])
      expect(
        (await configure({ url, events: ['deployment.ready'] })).status,
        url,
      ).toBe(400);
    expect(
      (await configure({ url: hook, events: ['everything'] })).status,
    ).toBe(400);
    expect(db.sqlite.prepare('SELECT * FROM project_webhooks').all()).toEqual(
      [],
    );
  });

  it('is changed only in the dashboard, never with an API token', async () => {
    const token = (
      (await (
        await db.request(
          '/tokens',
          { method: 'POST', body: JSON.stringify({ name: 'Agent' }) },
          who.cookie,
        )
      ).json()) as { token: string }
    ).token;
    const response = await app.request(
      `https://shipcel.test/api/projects/${projectId}/notifications`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: hook, events: ['deployment.ready'] }),
      },
      db.env,
    );
    expect(response.status).toBe(403);
  });

  it('stays inside the workspace and can be removed', async () => {
    await configure({ url: hook, events: ['deployment.ready'] });
    const other = await db.user(2);
    expect((await request('/notifications', {}, other.cookie)).status).toBe(
      404,
    );
    expect((await request('/notifications', { method: 'DELETE' })).status).toBe(
      200,
    );
    expect(await (await request('/notifications')).json()).toMatchObject({
      webhook: null,
      telegram: null,
      email: null,
    });
  });
});

describe('delivery', () => {
  async function signingSecret(
    events = ['deployment.ready', 'deployment.failed'],
  ) {
    return (
      (await (await configure({ url: hook, events })).json()) as {
        signingSecret: string;
      }
    ).signingSecret;
  }
  const scope = () => ({ workspaceId: who.workspaceId, projectId });

  it('queues only the events the project asked for, then delivers them signed', async () => {
    const secret = await signingSecret();
    await notify(db.env, {
      ...scope(),
      event: 'deployment.ready',
      text: 'notify-app is live at https://notify-app.example.workers.dev/',
      data: { url: 'https://notify-app.example.workers.dev/' },
    });
    await notify(db.env, {
      ...scope(),
      event: 'health.healthy',
      text: 'notify-app is healthy.',
      data: {},
    });
    expect(deliveries()).toEqual([
      { event: 'deployment.ready', status: 'pending', attempts: 0 },
    ]);
    await deliverNotifications(db.env);
    expect(received).toHaveLength(1);
    const [sent] = received;
    expect(sent.url).toBe(hook);
    expect(sent.redirect).toBe('manual');
    const payload = JSON.parse(sent.body);
    // Slack reads text and Discord reads content.
    expect(payload).toMatchObject({
      event: 'deployment.ready',
      text: 'notify-app is live at https://notify-app.example.workers.dev/',
      content: 'notify-app is live at https://notify-app.example.workers.dev/',
      project: { id: projectId, name: 'notify-app' },
      data: { url: 'https://notify-app.example.workers.dev/' },
    });
    const timestamp = sent.headers.get('X-Shipcel-Timestamp')!;
    expect(sent.headers.get('X-Shipcel-Event')).toBe('deployment.ready');
    expect(sent.headers.get('X-Shipcel-Signature')).toBe(
      `sha256=${createHmac('sha256', secret).update(`${timestamp}.${sent.body}`).digest('hex')}`,
    );
    // The same under Cloudcel's names, for receivers set up before the rename.
    expect(sent.headers.get('X-Cloudcel-Signature')).toBe(
      sent.headers.get('X-Shipcel-Signature'),
    );
    expect(sent.headers.get('X-Cloudcel-Timestamp')).toBe(timestamp);
    expect(sent.headers.get('X-Cloudcel-Event')).toBe('deployment.ready');
    expect(deliveries()).toEqual([
      { event: 'deployment.ready', status: 'sent', attempts: 1 },
    ]);
    expect(await (await request('/notifications')).json()).toMatchObject({
      webhook: { lastStatus: 'sent' },
    });
  });

  it('retries a failing endpoint twice, then gives up', async () => {
    await signingSecret();
    answer = 500;
    await notify(db.env, {
      ...scope(),
      event: 'deployment.failed',
      text: 'notify-app needs attention.',
      data: {},
    });
    await deliverNotifications(db.env);
    expect(deliveries()).toEqual([
      { event: 'deployment.failed', status: 'pending', attempts: 1 },
    ]);
    // Not due again yet.
    await deliverNotifications(db.env);
    expect(received).toHaveLength(1);
    for (const attempt of [2, 3]) {
      db.sqlite
        .prepare('UPDATE webhook_deliveries SET next_attempt_at=?')
        .run(now() - 1);
      await deliverNotifications(db.env);
      expect(received).toHaveLength(attempt);
    }
    expect(deliveries()).toEqual([
      { event: 'deployment.failed', status: 'failed', attempts: 3 },
    ]);
    expect(await (await request('/notifications')).json()).toMatchObject({
      webhook: { lastStatus: 'failed', lastError: 'HTTP 500' },
    });
  });

  it('never sends a message twice when deliveries overlap', async () => {
    await signingSecret();
    await notify(db.env, {
      ...scope(),
      event: 'deployment.ready',
      text: 'notify-app is live.',
      data: {},
    });
    await Promise.all([
      deliverNotifications(db.env),
      deliverNotifications(db.env),
    ]);
    expect(received).toHaveLength(1);
    expect(deliveries()).toEqual([
      { event: 'deployment.ready', status: 'sent', attempts: 1 },
    ]);
  });

  it('sends a test notification at once', async () => {
    await signingSecret(['deployment.ready']);
    const response = await request('/notifications/test', { method: 'POST' });
    expect(await response.json()).toEqual({
      status: 'sent',
      detail: 'HTTP 200',
    });
    expect(JSON.parse(received[0].body)).toMatchObject({ event: 'test' });
  });

  it('tells a direct upload’s deploy to the webhook', async () => {
    await db.grant(who, 'cloudflare');
    const fx = cloudflareUploads();
    const fallback = fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) =>
        String(raw).startsWith('https://hooks.example.com/')
          ? (fallback as typeof globalThis.fetch)(raw, init)
          : fx.handler(raw, init),
      ),
    );
    await signingSecret(['upload.deployed']);
    const { assetHash } = await import('../shared/assets');
    const content = btoa('<h1>Hi</h1>');
    const hash = assetHash(content, '/index.html');
    const upload = (await (
      await request('/uploads', {
        method: 'POST',
        body: JSON.stringify({
          files: [{ path: '/index.html', hash, size: 11 }],
        }),
      })
    ).json()) as { uploadId: string };
    await request(`/uploads/${upload.uploadId}/files`, {
      method: 'POST',
      body: JSON.stringify({ files: [{ hash, content }] }),
    });
    const deployed = await request(`/uploads/${upload.uploadId}/deploy`, {
      method: 'POST',
      body: JSON.stringify({ requestId: crypto.randomUUID(), confirm: true }),
    });
    expect(deployed.status).toBe(200);
    expect(deliveries()).toEqual([
      { event: 'upload.deployed', status: 'pending', attempts: 0 },
    ]);
    await deliverNotifications(db.env);
    expect(JSON.parse(received[0].body).text).toContain(
      'https://00000001-notify-app.test-account.workers.dev',
    );
  });
});
