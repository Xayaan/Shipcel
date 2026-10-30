import { Hono } from 'hono';
import { z } from 'zod';
import { cloudflare } from './providers';
import { AppError, now, type AppEnv } from './types';
import { target, type Target } from './operations';
import { trackHealth } from './health';
import { d1 } from './migrations';
import { protectingApplication } from './access';

export const operationRecovery = new Hono<AppEnv>();
type Outcome = {
  status: 'succeeded' | 'not_applied' | 'needs_attention';
  detail?: string;
  result?: Record<string, unknown>;
  track?: { kind: 'build' | 'promotion'; target: string };
};
type Operation = {
  id: string;
  kind: string;
  status: string;
  intent_json: string | null;
  created_at: number;
  updated_at: number;
};
const notApplied = (what: string): Outcome => ({
  status: 'not_applied',
  detail: `Cloudflare shows that ${what} did not happen. You can submit it again.`,
});
// Allows for clock differences between Shipcel and Cloudflare timestamps.
const since = (iso: unknown, after: number) =>
  typeof iso === 'string' && Date.parse(iso) / 1000 >= after - 300;

// Reads Cloudflare state to learn whether an interrupted operation took effect.
// Read-only: nothing is repeated, and the user decides whether to submit it again.
async function check(
  t: Target,
  op: Operation,
  intent: Record<string, unknown>,
): Promise<Outcome> {
  const split = op.kind.indexOf(':');
  const action = split < 0 ? op.kind : op.kind.slice(0, split);
  const subject = split < 0 ? '' : op.kind.slice(split + 1);
  if (action === 'secret.set' || action === 'secret.remove') {
    const names = z
      .array(z.object({ name: z.string() }))
      .parse(await cloudflare(t.token, `${t.script}/secrets`))
      .map((s) => s.name);
    const present = names.includes(subject);
    if (action === 'secret.remove')
      return present
        ? notApplied('the secret removal')
        : { status: 'succeeded', result: { name: subject } };
    return present
      ? {
          status: 'needs_attention',
          detail: `Cloudflare shows a secret named ${subject}, but it never reveals values, so Shipcel cannot confirm this change. Set it again to be sure.`,
        }
      : notApplied('the secret change');
  }
  if (action === 'domain.attach' || action === 'domain.detach') {
    const domains = z
      .array(
        z.object({
          id: z.string(),
          hostname: z.string(),
          service: z.string(),
          environment: z.string().optional(),
        }),
      )
      .parse(await cloudflare(t.token, `${t.root}/workers/domains`));
    if (action === 'domain.detach')
      return domains.some((d) => d.id === subject)
        ? notApplied('the domain detachment')
        : { status: 'succeeded', result: { id: subject } };
    const found = domains.find((d) => d.hostname === subject);
    if (!found) return notApplied('the domain attachment');
    if (
      found.service !== t.job.worker_name ||
      (found.environment && found.environment !== 'production')
    )
      return {
        status: 'needs_attention',
        detail: `${subject} is attached to another Worker. Review it in Cloudflare.`,
      };
    return {
      status: 'succeeded',
      result: { id: found.id, hostname: found.hostname },
    };
  }
  if (action === 'buildvar.set' || action === 'buildvar.remove') {
    const { name, trigger } = z
      .object({
        name: z.string(),
        trigger: z.string().regex(/^[a-f0-9-]{16,64}$/i),
      })
      .parse(intent);
    const present =
      name in
      z
        .record(z.string(), z.unknown())
        .parse(
          (await cloudflare(
            t.token,
            `${t.root}/builds/triggers/${trigger}/environment_variables`,
          )) ?? {},
        );
    if (action === 'buildvar.remove')
      return present
        ? notApplied('the build variable removal')
        : { status: 'succeeded', result: { name } };
    return present
      ? {
          status: 'needs_attention',
          detail: `Cloudflare shows a build variable named ${name}, but Shipcel keeps no value to compare. Set it again to be sure.`,
        }
      : notApplied('the build variable change');
  }
  if (action === 'previews.protect' || action === 'previews.unprotect') {
    const { appId } = z
      .object({
        appId: z
          .string()
          .regex(/^[\w-]{1,64}$/)
          .optional(),
      })
      .parse(intent);
    const app = await protectingApplication(t, appId);
    if (action === 'previews.unprotect')
      return app
        ? notApplied('removing the protection')
        : { status: 'succeeded', result: { removed: true } };
    // An application that already protected previews counts only if it changed since.
    return app && since(app.updated_at, op.created_at)
      ? { status: 'succeeded', result: { appId: app.id } }
      : notApplied('the protection change');
  }
  if (action === 'kv.put' || action === 'kv.delete') {
    const { namespaceId, key } = z
      .object({
        namespaceId: z.string().regex(/^[a-f0-9]{32}$/),
        key: z.string(),
      })
      .parse(intent);
    // The exact key comes first among the keys it prefixes.
    const query = new URLSearchParams({ prefix: key, limit: '10' });
    const present = z
      .array(z.object({ name: z.string() }))
      .parse(
        await cloudflare(
          t.token,
          `${t.root}/storage/kv/namespaces/${namespaceId}/keys?${query}`,
        ),
      )
      .some((k) => k.name === key);
    if (action === 'kv.delete')
      return present
        ? notApplied('the key deletion')
        : { status: 'succeeded', result: { key } };
    return present
      ? {
          status: 'needs_attention',
          detail:
            'Cloudflare shows this key, but Shipcel keeps no copy of the value to compare. Set it again to be sure.',
        }
      : notApplied('the key change');
  }
  if (action === 'r2.put' || action === 'r2.delete') {
    const { bucket, key, jurisdiction } = z
      .object({
        bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
        key: z.string(),
        jurisdiction: z
          .string()
          .regex(/^[a-z-]{2,16}$/)
          .optional(),
      })
      .parse(intent);
    const query = new URLSearchParams({ prefix: key, per_page: '1' });
    const [first] = z
      .array(
        z.object({ key: z.string(), last_modified: z.string().optional() }),
      )
      .parse(
        await cloudflare(
          t.token,
          `${t.root}/r2/buckets/${bucket}/objects?${query}`,
          {
            headers: jurisdiction ? { 'cf-r2-jurisdiction': jurisdiction } : {},
          },
        ),
      );
    const present = first?.key === key;
    if (action === 'r2.delete')
      return present
        ? notApplied('the object deletion')
        : { status: 'succeeded', result: { key } };
    // An object may already have had this key, so only one changed since the upload began counts.
    return present && since(first.last_modified, op.created_at)
      ? { status: 'succeeded', result: { key } }
      : notApplied('the upload');
  }
  if (action === 'schedules.set') {
    const wanted = z.array(z.string()).parse(intent.crons);
    const current = z
      .object({ schedules: z.array(z.object({ cron: z.string() })) })
      .parse(await cloudflare(t.token, `${t.script}/schedules`))
      .schedules.map((s) => s.cron);
    return current.length === wanted.length &&
      wanted.every((cron) => current.includes(cron))
      ? { status: 'succeeded', result: { crons: wanted } }
      : notApplied('the schedule change');
  }
  if (action === 'version.split') {
    // subject: `<version>@<share>,<version>@<share>`, the first being rolled out.
    const wanted = subject.split(',').map((part) => {
      const [version, share] = part.split('@');
      return { version_id: version, percentage: Number(share) };
    });
    const { deployments } = z
      .object({
        deployments: z.array(
          z.object({
            created_on: z.string().optional(),
            versions: z.array(
              z.object({ version_id: z.string(), percentage: z.number() }),
            ),
          }),
        ),
      })
      .parse(await cloudflare(t.token, `${t.script}/deployments`));
    const splits = (d: (typeof deployments)[number]) =>
      wanted.every((w) =>
        d.versions.some(
          (v) => v.version_id === w.version_id && v.percentage === w.percentage,
        ),
      );
    if (
      (deployments[0] && splits(deployments[0])) ||
      deployments.some((d) => splits(d) && since(d.created_on, op.created_at))
    )
      return {
        status: 'succeeded',
        result: { versions: wanted },
        track: {
          kind: 'promotion',
          target: `${wanted[0].version_id}@${wanted[0].percentage}`,
        },
      };
    return notApplied('the traffic split');
  }
  if (action === 'version.promote') {
    const { deployments } = z
      .object({
        deployments: z.array(
          z.object({
            created_on: z.string().optional(),
            versions: z.array(
              z.object({ version_id: z.string(), percentage: z.number() }),
            ),
          }),
        ),
      })
      .parse(await cloudflare(t.token, `${t.script}/deployments`));
    const promotes = (d: (typeof deployments)[number]) =>
      d.versions.some((v) => v.version_id === subject && v.percentage === 100);
    if (
      (deployments[0] && promotes(deployments[0])) ||
      deployments.some((d) => promotes(d) && since(d.created_on, op.created_at))
    )
      return {
        status: 'succeeded',
        result: { versionId: subject },
        track: { kind: 'promotion', target: subject },
      };
    return notApplied('the version promotion');
  }
  if (action === 'build.redeploy') {
    const commit = z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .parse(intent.commit);
    const builds = z
      .array(
        z.object({
          build_uuid: z.string().regex(/^[a-f0-9-]{16,64}$/i),
          created_at: z.string().optional(),
          trigger_uuid: z.string().optional(),
          trigger: z.object({ trigger_uuid: z.string() }).partial().optional(),
          build_trigger_metadata: z
            .object({ commit_hash: z.string() })
            .partial()
            .optional(),
        }),
      )
      .parse(
        await cloudflare(
          t.token,
          `${t.root}/builds/workers/${t.job.worker_tag}/builds?per_page=50`,
        ),
      );
    const build = builds.find(
      (b) =>
        (b.trigger?.trigger_uuid ?? b.trigger_uuid) === t.job.trigger_uuid &&
        b.build_trigger_metadata?.commit_hash === commit &&
        since(b.created_at, op.created_at),
    );
    return build
      ? {
          status: 'succeeded',
          result: { buildId: build.build_uuid, commit },
          track: { kind: 'build', target: build.build_uuid },
        }
      : notApplied('the build');
  }
  if (action === 'd1.migrate') {
    const { databaseId, migrations } = z
      .object({ databaseId: z.string(), migrations: z.array(z.string()) })
      .parse(intent);
    const tracked = await d1(
      t,
      databaseId,
      "SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'",
    );
    const applied = tracked[0]?.results?.length
      ? z
          .array(z.object({ name: z.string() }))
          .parse(
            (
              await d1(
                t,
                databaseId,
                'SELECT name FROM "d1_migrations" ORDER BY id',
              )
            )[0]?.results ?? [],
          )
          .map((r) => r.name)
      : [];
    const done = migrations.filter((m) => applied.includes(m));
    if (done.length === migrations.length)
      return { status: 'succeeded', result: { databaseId, applied: done } };
    if (!done.length) return notApplied('the migrations');
    return {
      status: 'needs_attention',
      detail: `Applied: ${done.join(', ')}. Not applied: ${migrations
        .filter((m) => !done.includes(m))
        .join(', ')}. Check the migrations again to continue.`,
    };
  }
  return {
    status: 'needs_attention',
    detail:
      action === 'd1.restore'
        ? 'Cloudflare does not report whether this restore finished. Check the database in the dashboard; Time Travel keeps both states.'
        : action === 'd1.query'
          ? 'Cloudflare does not report whether this SQL ran. Check the data in the table browser; the restore point recorded just before it can undo it.'
          : 'Shipcel cannot check this kind of operation automatically. Review it in Cloudflare.',
  };
}

operationRecovery.post(
  '/projects/:id/operations/:operationId/reconcile',
  async (c) => {
    const t = await target(c);
    const op = await c.env.DB.prepare(
      'SELECT id,kind,status,intent_json,created_at,updated_at FROM project_operations WHERE id=? AND workspace_id=? AND project_id=?',
    )
      .bind(c.req.param('operationId'), t.who.workspaceId, t.p.id)
      .first<Operation>();
    if (!op) throw new AppError(404, 'Operation not found.');
    const stale = op.status === 'running' && op.updated_at < now() - 120;
    if (op.status !== 'needs_attention' && !stale)
      throw new AppError(
        409,
        'Only operations that need attention can be checked.',
      );
    const outcome = await check(t, op, JSON.parse(op.intent_json || '{}'));
    const error = outcome.status === 'succeeded' ? null : outcome.detail;
    const tracked =
      outcome.track &&
      (await c.env.DB.prepare(
        'SELECT 1 FROM operation_health WHERE operation_id=?',
      )
        .bind(op.id)
        .first());
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE project_operations SET status=?,error=?,result_json=COALESCE(?,result_json),reconciled_at=?,updated_at=? WHERE id=? AND (status='needs_attention' OR (status='running' AND updated_at<?))",
      ).bind(
        outcome.status,
        error ?? null,
        outcome.result ? JSON.stringify(outcome.result) : null,
        now(),
        now(),
        op.id,
        now() - 120,
      ),
      ...(outcome.track && !tracked
        ? [
            trackHealth(c.env, {
              operationId: op.id,
              workspaceId: t.who.workspaceId,
              projectId: t.p.id,
              accountId: t.job.account_id,
              ...outcome.track,
            }),
          ]
        : []),
    ]);
    return c.json({
      id: op.id,
      status: outcome.status,
      error: error ?? null,
      result: outcome.result ?? null,
    });
  },
);
