import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database, projectInput } from './helpers/database';
import { deliverNotifications, notify } from '../worker/notifications';
import type { OutgoingEmail } from '../worker/types';
import app from '../worker/index';

// Telegram and email beside a project's webhook (worker/notifications.ts, and the pages an
// email's links open, worker/notification-pages.ts). Telegram is faked as its Bot API
// documents (core.telegram.org/bots/api); email goes to a stand-in for Cloudflare's Email
// Service binding.
const BOT = `123456789:${'A'.repeat(35)}`;
const ORIGIN = 'https://shipcel.test';

let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>;
let projectId: string;
let telegram: {
  updates: unknown[];
  updatesError: { error_code: number; description: string } | null;
  sendError: string | null;
  sent: { chat_id: string; text: string }[];
};
let mails: OutgoingEmail[];

const request = (path: string, init: RequestInit = {}, cookie = who.cookie) =>
  db.request(`/projects/${projectId}${path}`, init, cookie);
const put = (path: string, body: Record<string, unknown>) =>
  request(path, { method: 'PUT', body: JSON.stringify(body) });
const settings = async () =>
  (await (await request('/notifications')).json()) as {
    telegram: {
      label: string;
      events: string[];
      lastStatus: string | null;
    } | null;
    email: { label: string; confirmed: boolean } | null;
    emailReady: boolean;
  };
// A form posted from one of Shipcel's own pages, as a browser sends it.
const form = (path: string, token: string, origin = ORIGIN) =>
  app.request(
    `${ORIGIN}/api${path}`,
    {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token }).toString(),
    },
    db.env,
  );
const page = (path: string) => app.request(`${ORIGIN}/api${path}`, {}, db.env);
const linkIn = (mail: OutgoingEmail, kind: 'confirm' | 'stop') =>
  new RegExp(
    `${ORIGIN}/api/notifications/email/${kind}\\?token=([\\w-]{43})`,
  ).exec(mail.text)![1];
const deployed = () =>
  notify(db.env, {
    workspaceId: who.workspaceId,
    projectId,
    event: 'deployment.ready',
    text: (name) => `${name} is live.`,
    data: {},
  });

beforeEach(async () => {
  db = database();
  who = await db.user(1);
  const created = await db.request(
    '/projects',
    { method: 'POST', body: JSON.stringify(projectInput('shop')) },
    who.cookie,
  );
  projectId = ((await created.json()) as { id: string }).id;
  telegram = { updates: [], updatesError: null, sendError: null, sent: [] };
  mails = [];
  db.env.NOTIFY_FROM = 'notify@shipcel.test';
  db.env.NOTIFY_EMAIL = {
    send: async (mail: OutgoingEmail) => void mails.push(mail),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
      const match = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(
        String(raw),
      );
      if (!match) throw new Error(`Unexpected ${raw}`);
      const [, token, method] = match;
      if (token !== BOT)
        return Response.json(
          { ok: false, error_code: 401, description: 'Unauthorized' },
          { status: 401 },
        );
      if (method === 'getMe')
        return Response.json({
          ok: true,
          result: { id: 1, is_bot: true, username: 'shop_alerts_bot' },
        });
      if (method === 'getUpdates')
        return telegram.updatesError
          ? Response.json(
              { ok: false, ...telegram.updatesError },
              { status: telegram.updatesError.error_code },
            )
          : Response.json({ ok: true, result: telegram.updates });
      if (method === 'sendMessage') {
        if (telegram.sendError)
          return Response.json(
            { ok: false, error_code: 403, description: telegram.sendError },
            { status: 403 },
          );
        telegram.sent.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true, result: { message_id: 1 } });
      }
      throw new Error(`Unexpected Telegram method ${method}`);
    }),
  );
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe('Telegram', () => {
  it('finds the chat that messaged the bot, says hello there, and keeps the token encrypted', async () => {
    telegram.updates = [
      { update_id: 1, message: { chat: { id: 111, first_name: 'Old' } } },
      { update_id: 2, message: { chat: { id: 42, first_name: 'Ada' } } },
    ];
    const saved = await put('/notifications/telegram', {
      botToken: BOT,
      events: ['deployment.failed', 'deployment.failed'],
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      label: '@shop_alerts_bot in Ada',
      events: ['deployment.failed'],
    });
    expect(telegram.sent).toEqual([
      { chat_id: '42', text: 'Shipcel will post shop’s notifications here.' },
    ]);
    expect((await settings()).telegram).toMatchObject({
      label: '@shop_alerts_bot in Ada',
      events: ['deployment.failed'],
    });
    const stored = JSON.stringify(
      db.sqlite.prepare('SELECT * FROM notification_channels').all(),
    );
    expect(stored).not.toContain(BOT.split(':')[1]);
    // A group, or a chat given by its id, works the same.
    telegram.updates = [
      { update_id: 3, my_chat_member: { chat: { id: -1001, title: 'Ops' } } },
    ];
    expect(
      (
        (await (
          await put('/notifications/telegram', {
            botToken: BOT,
            events: ['deployment.ready'],
          })
        ).json()) as { label: string }
      ).label,
    ).toBe('@shop_alerts_bot in Ops');
    const byId = await put('/notifications/telegram', {
      botToken: BOT,
      chatId: '@shop_ops',
      events: ['deployment.ready'],
    });
    expect(((await byId.json()) as { label: string }).label).toBe(
      '@shop_alerts_bot in @shop_ops',
    );
  });

  it('says what to do when Telegram can’t take the bot or find its chat', async () => {
    const attempt = (body: Record<string, unknown> = {}) =>
      put('/notifications/telegram', {
        botToken: BOT,
        events: ['deployment.ready'],
        ...body,
      });
    expect((await attempt({ botToken: 'not a token' })).status).toBe(400);
    const unknown = await attempt({ botToken: `987654321:${'B'.repeat(35)}` });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain('@BotFather');
    const quiet = await attempt();
    expect(quiet.status).toBe(409);
    expect(await quiet.text()).toContain('Send your bot a message');
    telegram.updatesError = {
      error_code: 409,
      description:
        'Conflict: can’t use getUpdates method while webhook is active',
    };
    const hooked = await attempt();
    expect(hooked.status).toBe(409);
    expect(await hooked.text()).toContain('Give the chat id');
    telegram.sendError = 'Forbidden: bot was blocked by the user';
    const blocked = await attempt({ chatId: '42' });
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain('bot was blocked by the user');
    expect((await settings()).telegram).toBeNull();
    expect((await attempt({ chatId: 'chat 42' })).status).toBe(400);
  });

  it('delivers the events it asked for, budget alerts always, and retries a failure', async () => {
    await put('/notifications/telegram', {
      botToken: BOT,
      chatId: '42',
      events: ['deployment.ready'],
    });
    telegram.sent = [];
    await deployed();
    await notify(db.env, {
      workspaceId: who.workspaceId,
      projectId,
      event: 'health.unhealthy',
      text: 'down',
      data: {},
    });
    await notify(db.env, {
      workspaceId: who.workspaceId,
      projectId,
      event: 'budget.paused',
      text: 'shop is paused: over budget.',
      data: {},
    });
    await deliverNotifications(db.env);
    expect(telegram.sent).toEqual([
      expect.objectContaining({ chat_id: '42', text: 'shop is live.' }),
      expect.objectContaining({
        chat_id: '42',
        text: 'shop is paused: over budget.',
      }),
    ]);
    expect((await settings()).telegram?.lastStatus).toBe('sent');
    // Telegram refusing is retried, then shown.
    telegram.sendError = 'Forbidden: bot was kicked from the group chat';
    await deployed();
    await deliverNotifications(db.env);
    expect((await settings()).telegram).toMatchObject({
      lastStatus: 'failed',
      lastError: 'Forbidden: bot was kicked from the group chat',
    });
    expect(
      db.sqlite
        .prepare(
          "SELECT status, attempts FROM webhook_deliveries WHERE channel='telegram' ORDER BY created_at DESC, rowid DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ status: 'pending', attempts: 1 });
    // Removing the webhook leaves Telegram's messages; removing Telegram drops them.
    const pending = () =>
      db.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status='pending'",
        )
        .get();
    expect((await request('/notifications', { method: 'DELETE' })).status).toBe(
      200,
    );
    expect(pending()).toEqual({ n: 1 });
    expect(
      (await request('/notifications/telegram', { method: 'DELETE' })).status,
    ).toBe(200);
    expect(pending()).toEqual({ n: 0 });
  });

  it('sends a test at once, and only to a channel that is there', async () => {
    const test = (channel?: string) =>
      request('/notifications/test', {
        method: 'POST',
        ...(channel ? { body: JSON.stringify({ channel }) } : {}),
      });
    expect((await test('telegram')).status).toBe(409);
    expect((await test()).status).toBe(409);
    await put('/notifications/telegram', {
      botToken: BOT,
      chatId: '42',
      events: ['deployment.ready'],
    });
    const sent = await test('telegram');
    expect(await sent.json()).toEqual({ status: 'sent', detail: 'Delivered' });
    expect(telegram.sent.at(-1)?.text).toBe(
      'Test notification from Shipcel for shop.',
    );
    expect((await test('pager')).status).toBe(400);
  });
});

describe('email', () => {
  it('sends notifications only once the address confirms, from a page with a button', async () => {
    const saved = await put('/notifications/email', {
      address: ' Ada@Example.com ',
      events: ['deployment.ready'],
    });
    expect(await saved.json()).toEqual({
      label: 'ada@example.com',
      events: ['deployment.ready'],
      confirmed: false,
    });
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      from: { email: 'notify@shipcel.test', name: 'Shipcel' },
      to: 'ada@example.com',
      subject: 'Confirm Shipcel notifications for shop',
    });
    // Until it is confirmed, nothing goes to it, not even a test.
    const test = await request('/notifications/test', {
      method: 'POST',
      body: JSON.stringify({ channel: 'email' }),
    });
    expect(test.status).toBe(409);
    await deployed();
    expect(
      db.sqlite.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries').get(),
    ).toEqual({ n: 0 });
    // Opening the link changes nothing; its button confirms.
    const token = linkIn(mails[0], 'confirm');
    const opened = await page(`/notifications/email/confirm?token=${token}`);
    expect(opened.headers.get('Content-Security-Policy')).toContain(
      "default-src 'none'",
    );
    expect(await opened.text()).toContain('<button>Confirm</button>');
    expect((await settings()).email?.confirmed).toBe(false);
    // The link opens from someone's mail, another site; only the form's post must be ours.
    const fromMail = await app.request(
      `${ORIGIN}/api/notifications/email/confirm?token=${token}`,
      { headers: { 'Sec-Fetch-Site': 'cross-site' } },
      db.env,
    );
    expect(fromMail.status).toBe(200);
    // Another site can't post the form.
    expect(
      (
        await form(
          '/notifications/email/confirm',
          token,
          'https://elsewhere.test',
        )
      ).status,
    ).toBe(403);
    const confirmed = await form('/notifications/email/confirm', token);
    expect(confirmed.status).toBe(200);
    expect(await confirmed.text()).toContain(
      'ada@example.com gets shop’s notifications',
    );
    expect((await settings()).email?.confirmed).toBe(true);
    // Now its events come, each with a link that stops them.
    await deployed();
    await deliverNotifications(db.env);
    expect(mails).toHaveLength(2);
    expect(mails[1]).toMatchObject({
      to: 'ada@example.com',
      subject: 'shop is live.',
    });
    expect(mails[1].html).toContain('Stop these emails');
    const stop = linkIn(mails[1], 'stop');
    expect(
      await (await page(`/notifications/email/stop?token=${stop}`)).text(),
    ).toContain('<button>Stop these emails</button>');
    expect((await form('/notifications/email/stop', stop)).status).toBe(200);
    expect((await settings()).email).toBeNull();
    expect((await page(`/notifications/email/stop?token=${stop}`)).status).toBe(
      404,
    );
    expect(
      (await page('/notifications/email/confirm?token=nonsense')).status,
    ).toBe(404);
  });

  it('keeps a confirmed address when only its events change, and limits confirmations', async () => {
    await put('/notifications/email', {
      address: 'ada@example.com',
      events: ['deployment.ready'],
    });
    await form('/notifications/email/confirm', linkIn(mails[0], 'confirm'));
    const changed = await put('/notifications/email', {
      address: 'ada@example.com',
      events: ['deployment.failed'],
    });
    expect(await changed.json()).toMatchObject({
      confirmed: true,
      events: ['deployment.failed'],
    });
    expect(mails).toHaveLength(1);
    // Another address is confirmed again, at most once in ten minutes per project.
    const other = await put('/notifications/email', {
      address: 'ops@example.com',
      events: ['deployment.failed'],
    });
    expect(other.status).toBe(429);
    db.sqlite
      .prepare(
        'UPDATE notification_channels SET confirm_sent_at=confirm_sent_at-601',
      )
      .run();
    expect(
      (
        await put('/notifications/email', {
          address: 'ops@example.com',
          events: ['deployment.failed'],
        })
      ).status,
    ).toBe(200);
    expect(mails.map((m) => m.to)).toEqual([
      'ada@example.com',
      'ops@example.com',
    ]);
    expect((await settings()).email).toMatchObject({
      label: 'ops@example.com',
      confirmed: false,
    });
    // The first address's link stopped working.
    expect(
      (await form('/notifications/email/confirm', linkIn(mails[0], 'confirm')))
        .status,
    ).toBe(404);
    // Removing the address and adding another doesn't get round the wait: a workspace sends
    // five confirmations an hour.
    const another = (address: string) =>
      put('/notifications/email', { address, events: ['deployment.failed'] });
    for (let i = 0; i < 3; i++) {
      await request('/notifications/email', { method: 'DELETE' });
      expect((await another(`ops${i}@example.com`)).status).toBe(200);
    }
    await request('/notifications/email', { method: 'DELETE' });
    expect((await another('one-more@example.com')).status).toBe(429);
  });

  it('needs a sender set up on this Shipcel, and says when Cloudflare refuses the email', async () => {
    delete db.env.NOTIFY_EMAIL;
    expect((await settings()).emailReady).toBe(false);
    const unset = await put('/notifications/email', {
      address: 'ada@example.com',
      events: ['deployment.ready'],
    });
    expect(unset.status).toBe(503);
    expect(await unset.text()).toContain('SETUP.md');
    db.env.NOTIFY_EMAIL = {
      send: async () => {
        throw new Error('sender domain not verified');
      },
    };
    const refused = await put('/notifications/email', {
      address: 'ada@example.com',
      events: ['deployment.ready'],
    });
    expect(refused.status).toBe(502);
    expect(await refused.text()).toContain('sender domain not verified');
    expect((await settings()).email).toBeNull();
  });

  it('is for owners of the project’s workspace only', async () => {
    const developer = await db.user(2, 'developer');
    db.sqlite
      .prepare('UPDATE memberships SET workspace_id=? WHERE user_id=?')
      .run(who.workspaceId, developer.userId);
    db.sqlite
      .prepare('UPDATE sessions SET workspace_id=? WHERE user_id=?')
      .run(who.workspaceId, developer.userId);
    expect(
      (
        await request(
          '/notifications/email',
          {
            method: 'PUT',
            body: JSON.stringify({
              address: 'x@example.com',
              events: ['deployment.ready'],
            }),
          },
          developer.cookie,
        )
      ).status,
    ).toBe(403);
    const stranger = await db.user(3);
    expect((await request('/notifications', {}, stranger.cookie)).status).toBe(
      404,
    );
  });
});
