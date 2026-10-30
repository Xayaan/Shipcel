import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { limit, requireIdentity } from './auth';
import { base64url, digest, randomToken, seal, unseal } from './crypto';
import {
  AppError,
  appOrigin,
  now,
  type AppEnv,
  type Env,
  type OutgoingEmail,
} from './types';

// Deploy notifications, per project: a webhook (Slack, Discord or any HTTPS endpoint), a
// Telegram chat through the customer's own bot, and an email address whose owner confirmed
// it. Events go to an outbox (webhook_deliveries, a row per channel); the scheduled handler
// delivers them, never following redirects, and retries twice before giving up.

export const notifications = new Hono<AppEnv>();
export const EVENTS = [
  'deployment.ready',
  'deployment.failed',
  'upload.deployed',
  'health.unhealthy',
  'health.healthy',
] as const;
// The budget guard's (worker/budgets.ts): sent to every channel whatever events it chose,
// since they are what stops a runaway bill.
export const BUDGET_EVENTS = [
  'budget.alert',
  'budget.paused',
  'budget.resumed',
] as const;
type Event = (typeof EVENTS)[number] | (typeof BUDGET_EVENTS)[number] | 'test';
type Channel = 'webhook' | 'telegram' | 'email';
const MAX_ATTEMPTS = 3;
const TELEGRAM = 'https://api.telegram.org';
// One confirmation email per project this often, whatever the address, and this many an
// hour across a workspace.
const CONFIRM_EVERY = 600;
const CONFIRMS_AN_HOUR = 5;

// A public https endpoint: no credentials in the address, no IP literals, and no local
// or single-label host names. Workers can't reach private networks either way.
const webhookUrl = z
  .string()
  .max(2000)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      host.includes('.') &&
      !/^\[|^[\d.]+$/.test(host) &&
      !/(^|\.)(localhost|local|internal|localdomain)$/.test(host)
    );
  }, 'Use an https address on a public host name.');
const chosenEvents = z
  .array(z.enum(EVENTS))
  .min(1)
  .max(EVENTS.length)
  .transform((events) => [...new Set(events)]);
const botToken = z
  .string()
  .trim()
  .regex(
    /^\d{5,16}:[\w-]{30,64}$/,
    'Paste the token @BotFather gave your bot.',
  );
const chatId = z
  .string()
  .trim()
  .regex(
    /^(-?\d{1,20}|@[A-Za-z]\w{4,31})$/,
    'A chat id is a number, or @ and a channel’s name.',
  );
const context = (workspaceId: string, projectId: string, kind: string) =>
  `webhook:${kind}:${workspaceId}:${projectId}`;

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

type Webhook = {
  project_id: string;
  workspace_id: string;
  url_sealed: string;
  host: string;
  secret_sealed: string;
  events_json: string;
  last_status: string | null;
  last_error: string | null;
  last_sent_at: number | null;
};
const webhookFor = (env: Env, projectId: string) =>
  env.DB.prepare('SELECT * FROM project_webhooks WHERE project_id=?')
    .bind(projectId)
    .first<Webhook>();

type ChannelRow = {
  project_id: string;
  workspace_id: string;
  kind: 'telegram' | 'email';
  target_sealed: string;
  label: string;
  events_json: string;
  confirmed_at: number | null;
  last_status: string | null;
  last_error: string | null;
  last_sent_at: number | null;
};
type TelegramTarget = { botToken: string; chatId: string };
// The token is the confirm and stop links' (worker/notification-pages.ts); the origin is
// where those links point.
type EmailTarget = { address: string; token: string; origin: string };
const channelFor = (env: Env, projectId: string, kind: ChannelRow['kind']) =>
  env.DB.prepare(
    'SELECT * FROM notification_channels WHERE project_id=? AND kind=?',
  )
    .bind(projectId, kind)
    .first<ChannelRow>();
const channelContext = (row: {
  kind: string;
  workspace_id: string;
  project_id: string;
}) => `notify:${row.kind}:${row.workspace_id}:${row.project_id}`;

async function ownedProject(c: Context<AppEnv>) {
  const who = requireIdentity(c, 'owner');
  const p = await c.env.DB.prepare(
    'SELECT id, name FROM projects WHERE id=? AND workspace_id=?',
  )
    .bind(c.req.param('id'), who.workspaceId)
    .first<{ id: string; name: string }>();
  if (!p) throw new AppError(404, 'Project not found.');
  return { who, p };
}

const shownChannel = (row: ChannelRow | null) =>
  row && {
    label: row.label,
    events: JSON.parse(row.events_json) as string[],
    confirmed: row.confirmed_at !== null,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastSentAt: row.last_sent_at,
  };

notifications.get('/projects/:id/notifications', async (c) => {
  const { p } = await ownedProject(c);
  const hook = await webhookFor(c.env, p.id);
  return c.json({
    webhook: hook && {
      host: hook.host,
      events: JSON.parse(hook.events_json) as string[],
      lastStatus: hook.last_status,
      lastError: hook.last_error,
      lastSentAt: hook.last_sent_at,
    },
    telegram: shownChannel(await channelFor(c.env, p.id, 'telegram')),
    email: shownChannel(await channelFor(c.env, p.id, 'email')),
    // Email needs a sender set up on this Shipcel (SETUP.md).
    emailReady: Boolean(c.env.NOTIFY_EMAIL && c.env.NOTIFY_FROM),
  });
});

notifications.put('/projects/:id/notifications', async (c) => {
  const { who, p } = await ownedProject(c);
  const input = z
    .object({ url: webhookUrl, events: chosenEvents })
    .strict()
    .parse(await c.req.json());
  const signingSecret = `whsec_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const key = c.env.TOKEN_ENCRYPTION_KEY;
  await c.env.DB.prepare(
    'INSERT INTO project_webhooks(project_id,workspace_id,url_sealed,host,secret_sealed,events_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET url_sealed=excluded.url_sealed, host=excluded.host, secret_sealed=excluded.secret_sealed, events_json=excluded.events_json, last_status=NULL, last_error=NULL, updated_at=excluded.updated_at',
  )
    .bind(
      p.id,
      who.workspaceId,
      await seal(input.url, key, context(who.workspaceId, p.id, 'url')),
      new URL(input.url).hostname,
      await seal(signingSecret, key, context(who.workspaceId, p.id, 'secret')),
      JSON.stringify(input.events),
      who.userId,
      now(),
      now(),
    )
    .run();
  // The signing secret is shown once; Shipcel keeps it only encrypted.
  return c.json({
    host: new URL(input.url).hostname,
    events: input.events,
    signingSecret,
  });
});

notifications.delete('/projects/:id/notifications', async (c) => {
  const { p } = await ownedProject(c);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM project_webhooks WHERE project_id=?').bind(
      p.id,
    ),
    c.env.DB.prepare(
      "DELETE FROM webhook_deliveries WHERE project_id=? AND channel='webhook' AND status='pending'",
    ).bind(p.id),
  ]);
  return c.json({ removed: true });
});

// A project's Telegram chat or email address, in place of the one it had.
async function saveChannel(
  env: Env,
  row: Pick<ChannelRow, 'project_id' | 'workspace_id' | 'kind' | 'label'> & {
    target: TelegramTarget | EmailTarget;
    events: string[];
    tokenHash: string | null;
    confirmedAt: number | null;
    userId: string;
  },
) {
  await env.DB.prepare(
    'INSERT INTO notification_channels(project_id,workspace_id,kind,target_sealed,label,events_json,token_hash,confirmed_at,confirm_sent_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,kind) DO UPDATE SET target_sealed=excluded.target_sealed, label=excluded.label, events_json=excluded.events_json, token_hash=excluded.token_hash, confirmed_at=excluded.confirmed_at, confirm_sent_at=excluded.confirm_sent_at, last_status=NULL, last_error=NULL, last_sent_at=NULL, created_by=excluded.created_by, created_at=excluded.created_at',
  )
    .bind(
      row.project_id,
      row.workspace_id,
      row.kind,
      await seal(row.target, env.TOKEN_ENCRYPTION_KEY, channelContext(row)),
      row.label,
      JSON.stringify(row.events),
      row.tokenHash,
      row.confirmedAt,
      row.tokenHash ? now() : null,
      row.userId,
      now(),
    )
    .run();
}

// One call to Telegram's Bot API (core.telegram.org/bots/api), as the customer's bot.
async function telegram<T>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
) {
  let response: Response;
  try {
    response = await fetch(`${TELEGRAM}/bot${token}/${method}`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false as const, code: 0, description: 'No response' };
  }
  const answer = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    error_code?: number;
    description?: string;
  };
  return answer.ok
    ? { ok: true as const, result: answer.result as T }
    : {
        ok: false as const,
        code: answer.error_code ?? response.status,
        description: (answer.description ?? `HTTP ${response.status}`).slice(
          0,
          200,
        ),
      };
}

type Chat = {
  id: number;
  title?: string;
  first_name?: string;
  username?: string;
};
// The chat the bot heard from last: a message to it, or a group or channel it joined.
async function newestChat(token: string) {
  const updates = await telegram<Record<string, { chat?: Chat } | undefined>[]>(
    token,
    'getUpdates',
  );
  if (!updates.ok)
    throw new AppError(
      409,
      updates.code === 409
        ? 'This bot has a webhook, so Shipcel can’t see its chats. Give the chat id instead.'
        : `Telegram didn’t list the bot’s chats: ${updates.description}`,
    );
  const chat = updates.result
    .map((u) => (u.message ?? u.channel_post ?? u.my_chat_member)?.chat)
    .filter((found): found is Chat => Boolean(found))
    .at(-1);
  if (!chat)
    throw new AppError(
      409,
      'Send your bot a message, or add it to the group or channel, then save again.',
    );
  return {
    id: String(chat.id),
    name:
      chat.title ??
      chat.first_name ??
      (chat.username ? `@${chat.username}` : String(chat.id)),
  };
}

notifications.put('/projects/:id/notifications/telegram', async (c) => {
  const { who, p } = await ownedProject(c);
  const input = z
    .object({ botToken, chatId: chatId.optional(), events: chosenEvents })
    .strict()
    .parse(await c.req.json());
  const bot = await telegram<{ username: string }>(input.botToken, 'getMe');
  if (!bot.ok)
    throw new AppError(
      400,
      'Telegram doesn’t know this bot token. Copy it again from @BotFather.',
    );
  const chat = input.chatId
    ? { id: input.chatId, name: input.chatId }
    : await newestChat(input.botToken);
  const hello = await telegram(input.botToken, 'sendMessage', {
    chat_id: chat.id,
    text: `Shipcel will post ${p.name}’s notifications here.`,
  });
  if (!hello.ok)
    throw new AppError(
      409,
      `Telegram didn’t post to ${chat.name}: ${hello.description}`,
    );
  const label = `@${bot.result.username} in ${chat.name}`;
  await saveChannel(c.env, {
    project_id: p.id,
    workspace_id: who.workspaceId,
    kind: 'telegram',
    label,
    target: { botToken: input.botToken, chatId: chat.id },
    events: input.events,
    tokenHash: null,
    confirmedAt: now(),
    userId: who.userId,
  });
  return c.json({ label, events: input.events });
});

// An email from this Shipcel's sender, through Cloudflare's Email Service.
async function email(env: Env, message: Omit<OutgoingEmail, 'from'>) {
  if (!env.NOTIFY_EMAIL || !env.NOTIFY_FROM)
    throw new AppError(
      503,
      'Email notifications aren’t set up on this Shipcel: they need a sender address on Cloudflare’s Email Service (SETUP.md).',
    );
  try {
    await env.NOTIFY_EMAIL.send({
      from: { email: env.NOTIFY_FROM, name: 'Shipcel' },
      ...message,
    });
  } catch (error) {
    throw new AppError(
      502,
      `Cloudflare’s Email Service didn’t take the email${error instanceof Error ? `: ${error.message.slice(0, 200)}` : '.'}`,
    );
  }
}

notifications.put('/projects/:id/notifications/email', async (c) => {
  const { who, p } = await ownedProject(c);
  const input = z
    .object({
      address: z.string().trim().toLowerCase().max(254).email(),
      events: chosenEvents,
    })
    .strict()
    .parse(await c.req.json());
  const existing = await c.env.DB.prepare(
    "SELECT label, confirmed_at, confirm_sent_at FROM notification_channels WHERE project_id=? AND kind='email'",
  )
    .bind(p.id)
    .first<{
      label: string;
      confirmed_at: number | null;
      confirm_sent_at: number | null;
    }>();
  if (existing?.confirmed_at && existing.label === input.address) {
    // The same confirmed address: only what it hears about changes.
    await c.env.DB.prepare(
      "UPDATE notification_channels SET events_json=? WHERE project_id=? AND kind='email'",
    )
      .bind(JSON.stringify(input.events), p.id)
      .run();
    return c.json({
      label: input.address,
      events: input.events,
      confirmed: true,
    });
  }
  if ((existing?.confirm_sent_at ?? 0) > now() - CONFIRM_EVERY)
    throw new AppError(
      429,
      'A confirmation email went out for this project in the last ten minutes. Try again later.',
    );
  // Removing an address resets the project's wait, so a workspace has a limit of its own.
  await limit(
    c.env,
    `notify-confirm:${who.workspaceId}`,
    CONFIRMS_AN_HOUR,
    3600,
  );
  const token = randomToken();
  const origin = appOrigin(c.env, c.req.raw);
  const link = `${origin}/api/notifications/email/confirm?token=${token}`;
  const ask = `Someone in a Shipcel workspace asked to send notifications about ${p.name} (deploys, failures, health checks and budget alerts) to this address. To get them, open this link and confirm:`;
  const ignore =
    'If you didn’t expect this, ignore this email; nothing more is sent.';
  await email(c.env, {
    to: input.address,
    subject: `Confirm Shipcel notifications for ${p.name}`,
    text: `${ask}\n\n${link}\n\n${ignore}`,
    html: `<p>${escapeHtml(ask)}</p><p><a href="${link}">${link}</a></p><p>${escapeHtml(ignore)}</p>`,
  });
  await saveChannel(c.env, {
    project_id: p.id,
    workspace_id: who.workspaceId,
    kind: 'email',
    label: input.address,
    target: { address: input.address, token, origin },
    events: input.events,
    tokenHash: await digest(token),
    confirmedAt: null,
    userId: who.userId,
  });
  return c.json({
    label: input.address,
    events: input.events,
    confirmed: false,
  });
});

notifications.delete(
  '/projects/:id/notifications/:kind{telegram|email}',
  async (c) => {
    const { p } = await ownedProject(c);
    const kind = c.req.param('kind');
    await c.env.DB.batch([
      c.env.DB.prepare(
        'DELETE FROM notification_channels WHERE project_id=? AND kind=?',
      ).bind(p.id, kind),
      c.env.DB.prepare(
        "DELETE FROM webhook_deliveries WHERE project_id=? AND channel=? AND status='pending'",
      ).bind(p.id, kind),
    ]);
    return c.json({ removed: true });
  },
);

notifications.post('/projects/:id/notifications/test', async (c) => {
  const { who, p } = await ownedProject(c);
  const { channel } = z
    .object({
      channel: z.enum(['webhook', 'telegram', 'email']).default('webhook'),
    })
    .strict()
    .parse(await c.req.json().catch(() => ({})));
  const ready =
    channel === 'webhook'
      ? await webhookFor(c.env, p.id)
      : (await channelFor(c.env, p.id, channel))?.confirmed_at;
  if (!ready)
    throw new AppError(
      409,
      {
        webhook: 'Add a webhook first.',
        telegram: 'Add a Telegram chat first.',
        email: 'Add an email address, and confirm it, first.',
      }[channel],
    );
  const id = await enqueue(c.env, {
    workspaceId: who.workspaceId,
    projectId: p.id,
    projectName: p.name,
    channel,
    event: 'test',
    text: `Test notification from Shipcel for ${p.name}.`,
    data: {},
  });
  return c.json(await deliver(c.env, id));
});

async function enqueue(
  env: Env,
  n: {
    workspaceId: string;
    projectId: string;
    projectName: string;
    channel: Channel;
    event: Event;
    text: string;
    data: Record<string, unknown>;
  },
) {
  const id = crypto.randomUUID();
  const text = n.text.slice(0, 1900);
  await env.DB.prepare(
    "INSERT INTO webhook_deliveries(id,project_id,workspace_id,channel,event,payload_json,status,next_attempt_at,created_at) VALUES (?,?,?,?,?,?,'pending',?,?)",
  )
    .bind(
      id,
      n.projectId,
      n.workspaceId,
      n.channel,
      n.event,
      JSON.stringify({
        event: n.event,
        // Slack reads text; Discord reads content.
        text,
        content: text,
        project: { id: n.projectId, name: n.projectName },
        data: n.data,
        occurredAt: new Date().toISOString(),
      }),
      now(),
      now(),
    )
    .run();
  return id;
}

// Queues an event for each of the project's channels that asked for it. Never throws: a
// notification must not stop the change it reports.
export async function notify(
  env: Env,
  n: {
    workspaceId: string;
    projectId: string;
    event: Exclude<Event, 'test'>;
    // The message, or a function of the project's name.
    text: string | ((project: string) => string);
    data: Record<string, unknown>;
  },
) {
  try {
    const project = await env.DB.prepare(
      'SELECT name FROM projects WHERE id=? AND workspace_id=?',
    )
      .bind(n.projectId, n.workspaceId)
      .first<{ name: string }>();
    if (!project) return;
    const { results } = await env.DB.prepare(
      "SELECT 'webhook' AS channel, events_json FROM project_webhooks WHERE project_id=? AND workspace_id=? UNION ALL SELECT kind, events_json FROM notification_channels WHERE project_id=? AND workspace_id=? AND confirmed_at IS NOT NULL",
    )
      .bind(n.projectId, n.workspaceId, n.projectId, n.workspaceId)
      .all<{ channel: Channel; events_json: string }>();
    const text = typeof n.text === 'string' ? n.text : n.text(project.name);
    for (const { channel, events_json } of results)
      if (
        (BUDGET_EVENTS as readonly string[]).includes(n.event) ||
        (JSON.parse(events_json) as string[]).includes(n.event)
      )
        await enqueue(env, { ...n, channel, projectName: project.name, text });
  } catch {
    /* Best effort: the change itself already happened. */
  }
}

async function hmac(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

type Delivery = {
  id: string;
  project_id: string;
  workspace_id: string;
  channel: Channel;
  event: string;
  payload_json: string;
  attempts: number;
};
// What one attempt came to; `gone` when the channel was removed meanwhile.
type Outcome = { ok: boolean; detail: string; gone?: boolean };

async function toWebhook(env: Env, d: Delivery): Promise<Outcome> {
  const hook = await webhookFor(env, d.project_id);
  if (!hook || hook.workspace_id !== d.workspace_id)
    return { ok: false, detail: 'No webhook', gone: true };
  const key = env.TOKEN_ENCRYPTION_KEY;
  const url = await unseal<string>(
    hook.url_sealed,
    key,
    context(hook.workspace_id, hook.project_id, 'url'),
  );
  const secret = await unseal<string>(
    hook.secret_sealed,
    key,
    context(hook.workspace_id, hook.project_id, 'secret'),
  );
  const timestamp = String(now());
  try {
    const signature = `sha256=${await hmac(secret, `${timestamp}.${d.payload_json}`)}`;
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Shipcel-Webhooks',
        'X-Shipcel-Event': d.event,
        'X-Shipcel-Delivery': d.id,
        'X-Shipcel-Timestamp': timestamp,
        'X-Shipcel-Signature': signature,
        // The same under Cloudcel's names, for receivers set up before the rename.
        'X-Cloudcel-Event': d.event,
        'X-Cloudcel-Delivery': d.id,
        'X-Cloudcel-Timestamp': timestamp,
        'X-Cloudcel-Signature': signature,
      },
      body: d.payload_json,
    });
    await response.body?.cancel();
    return {
      ok: response.status >= 200 && response.status < 300,
      detail: `HTTP ${response.status}`,
    };
  } catch {
    return { ok: false, detail: 'No response' };
  }
}

async function toChannel(env: Env, d: Delivery): Promise<Outcome> {
  const row = await channelFor(
    env,
    d.project_id,
    d.channel as ChannelRow['kind'],
  );
  if (!row || row.workspace_id !== d.workspace_id || !row.confirmed_at)
    return {
      ok: false,
      detail:
        d.channel === 'telegram'
          ? 'No Telegram chat'
          : 'No confirmed email address',
      gone: true,
    };
  const { text } = JSON.parse(d.payload_json) as { text: string };
  if (row.kind === 'telegram') {
    const { botToken, chatId } = await unseal<TelegramTarget>(
      row.target_sealed,
      env.TOKEN_ENCRYPTION_KEY,
      channelContext(row),
    );
    const sent = await telegram(botToken, 'sendMessage', {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
    });
    return sent.ok
      ? { ok: true, detail: 'Delivered' }
      : { ok: false, detail: sent.description };
  }
  const { address, token, origin } = await unseal<EmailTarget>(
    row.target_sealed,
    env.TOKEN_ENCRYPTION_KEY,
    channelContext(row),
  );
  const stop = `${origin}/api/notifications/email/stop?token=${token}`;
  try {
    await email(env, {
      to: address,
      subject: text.split('\n')[0].slice(0, 120),
      text: `${text}\n\nStop these emails: ${stop}`,
      html: `<p>${escapeHtml(text)}</p><p><a href="${stop}">Stop these emails</a></p>`,
    });
    return { ok: true, detail: 'Sent' };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof AppError ? error.message : 'Not sent',
    };
  }
}

// One attempt. A delivery is claimed first, so overlapping runs never send it twice.
async function deliver(env: Env, id: string) {
  const d = await env.DB.prepare(
    "UPDATE webhook_deliveries SET attempts=attempts+1, next_attempt_at=? WHERE id=? AND status='pending' AND next_attempt_at<=? RETURNING *",
  )
    .bind(now() + 300, id, now())
    .first<Delivery>();
  if (!d) return { status: 'skipped', detail: 'Already being delivered.' };
  const { ok, detail, gone } =
    d.channel === 'webhook' ? await toWebhook(env, d) : await toChannel(env, d);
  const finished = ok || gone || d.attempts >= MAX_ATTEMPTS;
  const last = [ok ? 'sent' : 'failed', ok ? null : detail, now()];
  // Retries wait 1 and then 4 minutes.
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE webhook_deliveries SET status=?, last_error=?, next_attempt_at=? WHERE id=?',
    ).bind(
      ok ? 'sent' : finished ? 'failed' : 'pending',
      ok ? null : detail,
      now() + 60 * 4 ** (d.attempts - 1),
      d.id,
    ),
    ...(gone
      ? []
      : [
          d.channel === 'webhook'
            ? env.DB.prepare(
                'UPDATE project_webhooks SET last_status=?, last_error=?, last_sent_at=? WHERE project_id=?',
              ).bind(...last, d.project_id)
            : env.DB.prepare(
                'UPDATE notification_channels SET last_status=?, last_error=?, last_sent_at=? WHERE project_id=? AND kind=?',
              ).bind(...last, d.project_id, d.channel),
        ]),
  ]);
  return { status: ok ? 'sent' : 'failed', detail };
}

export async function deliverNotifications(env: Env) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM webhook_deliveries WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT 20",
  )
    .bind(now())
    .all<{ id: string }>();
  await Promise.allSettled(results.map((r) => deliver(env, r.id)));
  // Finished deliveries are kept for a week.
  await env.DB.prepare(
    "DELETE FROM webhook_deliveries WHERE status!='pending' AND created_at<?",
  )
    .bind(now() - 7 * 86400)
    .run();
}
