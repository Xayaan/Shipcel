import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { cloudflare, providerPath } from './providers';
import { change, replay, target, type Target } from './operations';
import { AppError, now, type AppEnv } from './types';

// Manage → Domains → Who can open previews. Preview addresses are public to anyone with the
// link; a Cloudflare Access application on the production Worker's previews (destination
// `preview_worker`, so production stays public) makes reviewers sign in first. It lives in
// the customer's Zero Trust organization, which they set up in Cloudflare themselves:
// Cloudflare asks for a payment method there even on the free plan. Shipcel keeps only the
// application's ID; who may sign in stays in Cloudflare.
export const access = new Hono<AppEnv>();
export const accessAppName = (worker: string) => `Shipcel previews ${worker}`;
const MAX_EMAILS = 50,
  MAX_DOMAINS = 10,
  SESSION = '24h';
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/);
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const confirmation = { requestId: z.string().uuid(), confirm: z.literal(true) };
const applicationId = z.string().regex(/^[\w-]{1,64}$/);
const applicationSchema = z
  .object({
    id: applicationId,
    name: z.string().optional(),
    destinations: z
      .array(
        z
          .object({ type: z.string(), worker_id: z.string().optional() })
          .passthrough(),
      )
      .optional(),
    policies: z
      .array(
        z
          .object({
            include: z.array(z.record(z.string(), z.unknown())).optional(),
          })
          .passthrough(),
      )
      .optional(),
    session_duration: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();
type Application = z.infer<typeof applicationSchema>;

// The account's Zero Trust organization. Permission and rate-limit problems are reported as
// they are; any other answer means there is no organization yet, with Cloudflare's message.
async function organization(t: Target) {
  try {
    const found = z
      .object({ auth_domain: z.string() })
      .parse(
        await cloudflare(
          t.token,
          `${t.root}/access/organizations`,
          {},
          { errorDetail: true },
        ),
      );
    return { organization: { authDomain: found.auth_domain }, error: null };
  } catch (error) {
    if (error instanceof AppError && [401, 403, 429].includes(error.status))
      throw error;
    return {
      organization: null,
      error:
        error instanceof AppError
          ? error.message
          : 'Cloudflare did not return a Zero Trust organization.',
    };
  }
}
const loginMethods = async (t: Target) =>
  z
    .array(z.object({ name: z.string(), type: z.string() }))
    .parse(await cloudflare(t.token, `${t.root}/access/identity_providers`))
    .map(({ name, type }) => ({ name, type }));
const recorded = (c: Context<AppEnv>, t: Target) =>
  c.env.DB.prepare(
    'SELECT app_id FROM project_access WHERE project_id=? AND workspace_id=?',
  )
    .bind(t.p.id, t.who.workspaceId)
    .first<{ app_id: string }>();
async function application(t: Target, id: string) {
  try {
    return applicationSchema.parse(
      await cloudflare(t.token, `${t.root}/access/apps/${providerPath(id)}`),
    );
  } catch (error) {
    if (error instanceof AppError && error.status === 404) return null;
    throw error;
  }
}
// An application an interrupted attempt created: Shipcel's name and exactly this Worker's
// previews as its only destination.
async function adoptable(t: Target) {
  const name = accessAppName(t.job.worker_name);
  const query = new URLSearchParams({ name, exact: 'true' });
  return (
    z
      .array(applicationSchema)
      .parse(await cloudflare(t.token, `${t.root}/access/apps?${query}`))
      .find(
        (a) =>
          a.name === name &&
          a.destinations?.length === 1 &&
          a.destinations[0].type === 'preview_worker' &&
          a.destinations[0].worker_id === t.job.worker_tag,
      ) ?? null
  );
}
// The application behind an operation, for Check Cloudflare.
export const protectingApplication = async (t: Target, appId?: string) =>
  (appId && (await application(t, appId))) || (await adoptable(t));

// The emails and domains of the allow policy, and how many rules Shipcel doesn't manage.
function rulesOf(app: Application) {
  const include = app.policies?.flatMap((p) => p.include ?? []) ?? [];
  const emails: string[] = [],
    domains: string[] = [];
  for (const rule of include) {
    const person = z
      .object({ email: z.object({ email: z.string() }) })
      .safeParse(rule);
    const group = z
      .object({ email_domain: z.object({ domain: z.string() }) })
      .safeParse(rule);
    if (person.success) emails.push(person.data.email.email);
    else if (group.success) domains.push(group.data.email_domain.domain);
  }
  return {
    emails,
    domains,
    otherRules: include.length - emails.length - domains.length,
  };
}

access.get('/projects/:id/access', async (c) => {
  const t = await target(c);
  const { organization: org, error } = await organization(t);
  const row = await recorded(c, t);
  const app = org && row ? await application(t, row.app_id) : null;
  return c.json({
    organization: org,
    organizationError: error,
    loginMethods: org ? await loginMethods(t) : [],
    protection: app
      ? { ...rulesOf(app), sessionDuration: app.session_duration ?? null }
      : null,
    missing: Boolean(org && row && !app),
  });
});

// Protects preview addresses, or changes who may open them. When the organization has no
// login method at all, Cloudflare's One-time PIN (a code by email) is added, with consent;
// an organization with its own login methods is left as it is.
access.put('/projects/:id/access', async (c) => {
  const input = z
    .object({
      emails: z.array(email).max(MAX_EMAILS).default([]),
      domains: z.array(domain).max(MAX_DOMAINS).default([]),
      addLoginMethod: z.boolean().default(false),
      ...confirmation,
    })
    .strict()
    .refine((r) => r.emails.length + r.domains.length > 0, {
      message: 'Name at least one person or email domain.',
    })
    .parse(await c.req.json());
  const t = await target(c, true),
    kind = 'previews.protect';
  const previous = await replay(c, t, kind, input.requestId);
  if (previous) return previous;
  if (!(await organization(t)).organization)
    throw new AppError(
      409,
      'Set up Zero Trust in your Cloudflare account first: Access protects previews through its organization.',
    );
  const methods = await loginMethods(t);
  if (!methods.length && !input.addLoginMethod)
    throw new AppError(
      409,
      'This Zero Trust organization has no login method yet. Confirm adding Cloudflare’s One-time PIN, a code sent by email, so reviewers can sign in.',
    );
  const row = await recorded(c, t);
  const emails = [...new Set(input.emails)],
    domains = [...new Set(input.domains)];
  const body = JSON.stringify({
    type: 'self_hosted',
    name: accessAppName(t.job.worker_name),
    destinations: [{ type: 'preview_worker', worker_id: t.job.worker_tag }],
    policies: [
      {
        decision: 'allow',
        include: [
          ...emails.map((address) => ({ email: { email: address } })),
          ...domains.map((name) => ({ email_domain: { domain: name } })),
        ],
      },
    ],
    session_duration: SESSION,
    app_launcher_visible: false,
  });
  return change(
    c,
    t,
    kind,
    input.requestId,
    async () => {
      if (!methods.length)
        await cloudflare(t.token, `${t.root}/access/identity_providers`, {
          method: 'POST',
          body: JSON.stringify({
            name: 'One-time PIN',
            type: 'onetimepin',
            config: {},
          }),
        });
      const existing = await protectingApplication(t, row?.app_id);
      const saved = applicationSchema.parse(
        await cloudflare(
          t.token,
          existing
            ? `${t.root}/access/apps/${providerPath(existing.id)}`
            : `${t.root}/access/apps`,
          { method: existing ? 'PUT' : 'POST', body },
          { errorDetail: true },
        ),
      );
      await c.env.DB.prepare(
        'INSERT INTO project_access(project_id,workspace_id,account_id,worker_tag,app_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET app_id=excluded.app_id,worker_tag=excluded.worker_tag,account_id=excluded.account_id,updated_at=excluded.updated_at',
      )
        .bind(
          t.p.id,
          t.who.workspaceId,
          t.job.account_id,
          t.job.worker_tag,
          saved.id,
          t.who.userId,
          now(),
          now(),
        )
        .run();
      return {
        appId: saved.id,
        people: emails.length,
        domains: domains.length,
        loginMethodAdded: !methods.length,
      };
    },
    {
      intent: {
        workerTag: t.job.worker_tag,
        ...(row ? { appId: row.app_id } : {}),
      },
    },
  );
});

access.delete('/projects/:id/access', async (c) => {
  const input = z
    .object(confirmation)
    .strict()
    .parse(await c.req.json());
  const t = await target(c, true),
    kind = 'previews.unprotect';
  const previous = await replay(c, t, kind, input.requestId);
  if (previous) return previous;
  const row = await recorded(c, t);
  if (!row) throw new AppError(404, 'Preview addresses are not protected.');
  return change(
    c,
    t,
    kind,
    input.requestId,
    async () => {
      try {
        await cloudflare(
          t.token,
          `${t.root}/access/apps/${providerPath(row.app_id)}`,
          { method: 'DELETE' },
        );
      } catch (error) {
        // Already removed in Cloudflare counts as removed.
        if (!(error instanceof AppError && error.status === 404)) throw error;
      }
      await c.env.DB.prepare('DELETE FROM project_access WHERE project_id=?')
        .bind(t.p.id)
        .run();
      return { removed: true };
    },
    { intent: { workerTag: t.job.worker_tag, appId: row.app_id } },
  );
});
