import { Hono, type Context } from 'hono';
import { digest } from './crypto';
import { escapeHtml } from './notifications';
import { now, type AppEnv } from './types';

// The pages an email notification's links open (worker/notifications.ts): confirming an
// address, and stopping its emails. Whoever has the email can use them, signed in or not, so
// each is a page with one button, and a mail scanner that opens the link changes nothing.
export const notificationPages = new Hono<AppEnv>();

function page(title: string, body: string, status: 200 | 404 = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 16px}button{font:inherit;padding:.5rem 1rem}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      },
    },
  );
}
const button = (token: string, label: string) =>
  `<form method="post"><input type="hidden" name="token" value="${escapeHtml(token)}"><button>${label}</button></form>`;
const gone = () =>
  page(
    'This link no longer works',
    '<p>The address was changed or removed, or its emails were stopped already.</p>',
    404,
  );

type Found = {
  project_id: string;
  label: string;
  confirmed_at: number | null;
  name: string;
};
// The email address a link's token belongs to, with its project's name.
async function addressOf(c: Context<AppEnv>, token: unknown) {
  if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) return null;
  const found = await c.env.DB.prepare(
    "SELECT n.project_id, n.label, n.confirmed_at, p.name FROM notification_channels n JOIN projects p ON p.id=n.project_id WHERE n.kind='email' AND n.token_hash=?",
  )
    .bind(await digest(token))
    .first<Found>();
  return found && { ...found, token };
}
const formToken = async (c: Context<AppEnv>) => (await c.req.parseBody()).token;

notificationPages.get('/notifications/email/confirm', async (c) => {
  const found = await addressOf(c, c.req.query('token'));
  if (!found) return gone();
  const who = escapeHtml(found.label),
    project = escapeHtml(found.name);
  return found.confirmed_at
    ? page(
        'Already confirmed',
        `<p>${who} gets ${project}’s notifications.</p>`,
      )
    : page(
        `Get ${found.name}’s notifications?`,
        `<p>Shipcel will email ${who} when ${project} is deployed, fails or needs attention.</p>${button(found.token, 'Confirm')}`,
      );
});

notificationPages.post('/notifications/email/confirm', async (c) => {
  const found = await addressOf(c, await formToken(c));
  if (!found) return gone();
  await c.env.DB.prepare(
    "UPDATE notification_channels SET confirmed_at=? WHERE project_id=? AND kind='email' AND confirmed_at IS NULL",
  )
    .bind(now(), found.project_id)
    .run();
  return page(
    'Confirmed',
    `<p>${escapeHtml(found.label)} gets ${escapeHtml(found.name)}’s notifications from now on. Each email has a link to stop them.</p>`,
  );
});

notificationPages.get('/notifications/email/stop', async (c) => {
  const found = await addressOf(c, c.req.query('token'));
  if (!found) return gone();
  return page(
    `Stop ${found.name}’s emails?`,
    `<p>Shipcel stops emailing ${escapeHtml(found.label)} about ${escapeHtml(found.name)}. Someone in its workspace can add the address again later.</p>${button(found.token, 'Stop these emails')}`,
  );
});

notificationPages.post('/notifications/email/stop', async (c) => {
  const found = await addressOf(c, await formToken(c));
  if (!found) return gone();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM notification_channels WHERE project_id=? AND kind='email'",
    ).bind(found.project_id),
    c.env.DB.prepare(
      "DELETE FROM webhook_deliveries WHERE project_id=? AND channel='email' AND status='pending'",
    ).bind(found.project_id),
  ]);
  return page(
    'Stopped',
    `<p>${escapeHtml(found.label)} gets no more emails about ${escapeHtml(found.name)}.</p>`,
  );
});
