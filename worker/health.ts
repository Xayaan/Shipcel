import { z } from 'zod';
import { activeGrant, grantToken } from './auth';
import { cloudflare } from './providers';
import { AppError, now, type Env } from './types';
import { notify } from './notifications';

type Health = {
  operation_id: string;
  workspace_id: string;
  project_id: string;
  account_id: string;
  kind: 'build' | 'promotion';
  target: string;
  status: string;
  step: string;
  detail: string | null;
  attempts: number;
  started_at: number;
  checked_at: number | null;
  lease_until: number;
};

// The account's workers.dev subdomain, or null when none is registered (Cloudflare error
// 10007). Every Worker's free address is <worker>.<subdomain>.workers.dev.
export async function workersSubdomain(token: string, accountId: string) {
  try {
    const { subdomain } = await cloudflare<{ subdomain?: string | null }>(
      token,
      `/accounts/${accountId}/workers/subdomain`,
      {},
      { missingCodes: [10007] },
    );
    return subdomain && /^[a-z0-9-]{1,63}$/.test(subdomain) ? subdomain : null;
  } catch (error) {
    if (error instanceof AppError && error.status === 404) return null;
    throw error;
  }
}

// Shared by the initial deployment and later changes: the workers.dev homepage only,
// without following redirects or reading the body. `version` pins the request to one
// version of a gradual deployment (Cloudflare's version override header).
export async function probeHomepage(
  token: string,
  accountId: string,
  workerName: string,
  version?: string,
) {
  const subdomain = await workersSubdomain(token, accountId);
  if (!subdomain)
    throw new AppError(
      409,
      'This account has no verified workers.dev subdomain. Check the Cloudflare dashboard.',
    );
  const url = `https://${workerName}.${subdomain}.workers.dev/`;
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
      ...(version && {
        headers: {
          'Cloudflare-Workers-Version-Overrides': `${workerName}="${version}"`,
        },
      }),
    });
    await response.body?.cancel();
    return { url, status: response.status as number | null, ok: response.ok };
  } catch {
    return { url, status: null, ok: false };
  }
}

// Recorded with the operation result. A promotion waits for its first probe so the new
// version can propagate; a build is read immediately.
export function trackHealth(
  env: Env,
  h: {
    operationId: string;
    workspaceId: string;
    projectId: string;
    accountId: string;
    kind: Health['kind'];
    target: string;
  },
) {
  return env.DB.prepare(
    "INSERT INTO operation_health(operation_id,workspace_id,project_id,account_id,kind,target,status,step,started_at,checked_at) VALUES (?,?,?,?,?,?,'pending',?,?,?)",
  ).bind(
    h.operationId,
    h.workspaceId,
    h.projectId,
    h.accountId,
    h.kind,
    h.target,
    h.kind === 'build' ? 'build' : 'probe',
    now(),
    h.kind === 'build' ? null : now(),
  );
}

// One step of tracking: at most every 20 seconds, never past 45 minutes, and a change is
// unhealthy only after three failed probes. Nothing is rolled back automatically.
export async function advanceHealth(env: Env, operationId: string) {
  const h = await env.DB.prepare(
    "UPDATE operation_health SET lease_until=? WHERE operation_id=? AND status='pending' AND lease_until<=? AND (checked_at IS NULL OR checked_at<=?) RETURNING *",
  )
    .bind(now() + 60, operationId, now(), now() - 20)
    .first<Health>();
  if (!h) return;
  const finish = (
    fields: Partial<Pick<Health, 'status' | 'step' | 'detail' | 'attempts'>>,
  ) =>
    env.DB.prepare(
      'UPDATE operation_health SET status=?,step=?,detail=?,attempts=?,checked_at=?,lease_until=0 WHERE operation_id=? AND lease_until=?',
    )
      .bind(
        fields.status ?? h.status,
        fields.step ?? h.step,
        fields.detail ?? h.detail,
        fields.attempts ?? h.attempts,
        now(),
        h.operation_id,
        h.lease_until,
      )
      .run();
  try {
    if (now() - h.started_at > 2700)
      return await finish({
        status: 'unknown',
        detail:
          'Health tracking exceeded 45 minutes. Check the deployment in Cloudflare.',
      });
    const job = await env.DB.prepare(
      "SELECT worker_name,worker_tag,account_id FROM deployment_jobs WHERE workspace_id=? AND project_id=? AND environment='production' AND worker_tag IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    )
      .bind(h.workspace_id, h.project_id)
      .first<{ worker_name: string; worker_tag: string; account_id: string }>();
    const grant = await activeGrant(env, h.workspace_id, 'cloudflare');
    if (
      !job ||
      job.account_id !== h.account_id ||
      grant?.account_id !== h.account_id
    )
      return await finish({
        status: 'unknown',
        detail:
          'The project or its Cloudflare account access changed, so Shipcel stopped checking this change.',
      });
    const token = await grantToken(env, grant),
      root = `/accounts/${h.account_id}`;
    const workers = z
      .array(z.object({ id: z.string(), tag: z.string() }))
      .parse(await cloudflare(token, `${root}/workers/scripts`));
    if (
      !workers.some((w) => w.id === job.worker_name && w.tag === job.worker_tag)
    )
      return await finish({
        status: 'unknown',
        detail:
          'The Worker was replaced or is no longer accessible, so Shipcel stopped checking this change.',
      });
    let step = h.step;
    // A promotion's target is `<version>`, or `<version>@<share>` for a traffic split.
    const [version, share] = h.target.split('@');
    const expected = share ? Number(share) : 100;
    if (step === 'build') {
      const build = z
        .object({ build_outcome: z.string().nullable().optional() })
        .parse(await cloudflare(token, `${root}/builds/builds/${h.target}`));
      if (!build.build_outcome)
        return await finish({ detail: 'The build is still running.' });
      if (build.build_outcome !== 'success') {
        await finish({
          status: 'build_failed',
          detail:
            'The build did not succeed, so Cloudflare kept serving the previous version. Open the build logs in Cloudflare.',
        });
        return await notify(env, {
          workspaceId: h.workspace_id,
          projectId: h.project_id,
          event: 'deployment.failed',
          text: (name) =>
            `A build of ${name} failed, so Cloudflare kept serving the previous version.`,
          data: { build: h.target, status: 'build_failed' },
        });
      }
      step = 'probe';
    } else if (h.kind === 'promotion') {
      const active = z
        .object({
          deployments: z.array(
            z.object({
              versions: z.array(
                z.object({ version_id: z.string(), percentage: z.number() }),
              ),
            }),
          ),
        })
        .parse(
          await cloudflare(
            token,
            `${root}/workers/scripts/${job.worker_name}/deployments`,
          ),
        );
      // The first deployment is the one serving traffic.
      if (
        !active.deployments[0]?.versions.some(
          (v) => v.version_id === version && v.percentage === expected,
        )
      )
        return await finish({
          status: 'unknown',
          detail:
            'Another deployment replaced this version before Shipcel could check it.',
        });
    }
    const probe = await probeHomepage(
      token,
      h.account_id,
      job.worker_name,
      h.kind === 'promotion' && expected < 100 ? version : undefined,
    );
    const seen = probe.status === null ? 'no response' : `HTTP ${probe.status}`;
    if (probe.ok) {
      await finish({
        status: 'healthy',
        step,
        detail: `The homepage returned ${seen} (${probe.url}).`,
      });
      return await notify(env, {
        workspaceId: h.workspace_id,
        projectId: h.project_id,
        event: 'health.healthy',
        text: (name) =>
          `${name}: the ${h.kind === 'build' ? 'new build' : 'version change'} is healthy (${seen}).`,
        data: { kind: h.kind, target: h.target, url: probe.url },
      });
    }
    const attempts = h.attempts + 1;
    if (attempts < 3)
      return await finish({
        step,
        attempts,
        detail: `Check ${attempts} of 3 got ${seen}. Shipcel will check again shortly.`,
      });
    await finish({
      status: 'unhealthy',
      step,
      attempts,
      detail: `The homepage returned ${seen} on three checks. The change is live; inspect its logs in Cloudflare or promote a previous version.`,
    });
    return await notify(env, {
      workspaceId: h.workspace_id,
      projectId: h.project_id,
      event: 'health.unhealthy',
      text: (name) =>
        `${name}: the homepage returned ${seen} on three checks after the ${h.kind === 'build' ? 'new build' : 'version change'}. Roll back in Shipcel if needed.`,
      data: { kind: h.kind, target: h.target, url: probe.url },
    });
  } catch (error) {
    await finish({
      detail:
        error instanceof AppError
          ? error.message
          : 'Shipcel could not read the deployment state. It will try again.',
    });
  }
}

export async function scheduledHealthChecks(env: Env) {
  const { results } = await env.DB.prepare(
    "SELECT operation_id FROM operation_health WHERE status='pending' AND lease_until<=? AND (checked_at IS NULL OR checked_at<=?) ORDER BY checked_at LIMIT 10",
  )
    .bind(now(), now() - 20)
    .all<{ operation_id: string }>();
  await Promise.allSettled(
    results.map((r) => advanceHealth(env, r.operation_id)),
  );
}

export type BuildRecord = { build_uuid: string; created_at?: string };
type ScanScope = {
  workspace_id: string;
  project_id: string;
  account_id: string;
};
// Records builds Cloudflare reports for a project. Builds that are new since the project's
// baseline and less than an hour old get a follow-up check, unless one already exists
// (builds Shipcel started itself are tracked by their operation).
export async function registerBuilds(
  env: Env,
  scope: ScanScope,
  builds: BuildRecord[],
) {
  const scan = await env.DB.prepare(
    'SELECT baseline_at FROM build_scans WHERE project_id=?',
  )
    .bind(scope.project_id)
    .first<{ baseline_at: number }>();
  const statements: D1PreparedStatement[] = [];
  for (const build of builds.filter((b) =>
    /^[a-f0-9-]{16,64}$/i.test(b.build_uuid),
  )) {
    if (
      await env.DB.prepare('SELECT 1 FROM observed_builds WHERE build_uuid=?')
        .bind(build.build_uuid)
        .first()
    )
      continue;
    const created = Date.parse(build.created_at ?? '') / 1000;
    statements.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO observed_builds(build_uuid,workspace_id,project_id,created_at,first_seen_at) VALUES (?,?,?,?,?)',
      ).bind(
        build.build_uuid,
        scope.workspace_id,
        scope.project_id,
        Number.isFinite(created) ? created : null,
        now(),
      ),
    );
    if (
      scan &&
      created >= scan.baseline_at &&
      created >= now() - 3600 &&
      !(await env.DB.prepare(
        'SELECT 1 FROM operation_health WHERE project_id=? AND target=?',
      )
        .bind(scope.project_id, build.build_uuid)
        .first())
    )
      statements.push(
        trackHealth(env, {
          operationId: `push:${build.build_uuid}`,
          workspaceId: scope.workspace_id,
          projectId: scope.project_id,
          accountId: scope.account_id,
          kind: 'build',
          target: build.build_uuid,
        }),
      );
  }
  statements.push(
    scan
      ? env.DB.prepare(
          'UPDATE build_scans SET scanned_at=? WHERE project_id=?',
        ).bind(now(), scope.project_id)
      : env.DB.prepare(
          'INSERT INTO build_scans(project_id,workspace_id,baseline_at,scanned_at) VALUES (?,?,?,?)',
        ).bind(scope.project_id, scope.workspace_id, now(), now()),
  );
  await env.DB.batch(statements);
}

// At most every five minutes per deployed project, read its recent builds.
// Branch previews build on the production Worker too. Only builds from the production
// trigger change what production serves; when Cloudflare doesn't say which trigger ran a
// build, its branch decides.
export type BuildSource = {
  trigger_uuid?: string;
  trigger?: { trigger_uuid?: string };
  branch?: string;
  build_trigger_metadata?: { branch?: string };
};
export const buildSource = {
  trigger_uuid: z.string().optional(),
  trigger: z.object({ trigger_uuid: z.string() }).partial().optional(),
  branch: z.string().optional(),
  build_trigger_metadata: z.object({ branch: z.string() }).partial().optional(),
};
export function productionBuild(
  build: BuildSource,
  job: { trigger_uuid: string | null; branch: string },
) {
  const trigger = build.trigger?.trigger_uuid ?? build.trigger_uuid;
  if (trigger && job.trigger_uuid) return trigger === job.trigger_uuid;
  const branch = build.build_trigger_metadata?.branch ?? build.branch;
  return !branch || branch === job.branch;
}

export async function scheduledBuildScans(env: Env) {
  const { results } = await env.DB.prepare(
    "SELECT j.workspace_id,j.project_id,j.account_id,j.worker_name,j.worker_tag,j.trigger_uuid,j.branch FROM deployment_jobs j LEFT JOIN build_scans s ON s.project_id=j.project_id WHERE j.status='deployed' AND j.environment='production' AND j.worker_tag IS NOT NULL AND j.trigger_uuid IS NOT NULL AND (s.scanned_at IS NULL OR s.scanned_at<=?) ORDER BY COALESCE(s.scanned_at,0) LIMIT 10",
  )
    .bind(now() - 300)
    .all<
      ScanScope & {
        worker_name: string;
        worker_tag: string;
        trigger_uuid: string;
        branch: string;
      }
    >();
  await Promise.allSettled(
    results.map(async (job) => {
      const grant = await activeGrant(env, job.workspace_id, 'cloudflare');
      if (!grant || grant.account_id !== job.account_id) return;
      const token = await grantToken(env, grant),
        root = `/accounts/${job.account_id}`;
      const workers = z
        .array(z.object({ id: z.string(), tag: z.string() }))
        .parse(await cloudflare(token, `${root}/workers/scripts`));
      if (
        !workers.some(
          (w) => w.id === job.worker_name && w.tag === job.worker_tag,
        )
      )
        return;
      const builds = z
        .array(
          z.object({
            build_uuid: z.string(),
            created_at: z.string().optional(),
            ...buildSource,
          }),
        )
        .parse(
          await cloudflare(
            token,
            `${root}/builds/workers/${job.worker_tag}/builds?per_page=10`,
          ),
        );
      await registerBuilds(
        env,
        job,
        builds.filter((b) => productionBuild(b, job)),
      );
    }),
  );
}
