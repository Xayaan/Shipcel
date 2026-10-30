import { Hono } from 'hono';
import { z } from 'zod';
import { activeGrant, grantToken, requireIdentity } from './auth';
import { repoSchema } from './connections';
import { cloudflare, github } from './providers';
import { AppError, now, type AppEnv } from './types';
import { advanceDeployment, publicJob, type Job } from './deployments';

export const recovery = new Hono<AppEnv>();
const providerId = z.string().regex(/^[a-f0-9-]{16,64}$/i);
type Resume = {
  step: string;
  note: string;
  fields?: Partial<Pick<Job, 'worker_tag' | 'trigger_uuid' | 'build_uuid'>>;
};
const statusFor = (step: string) =>
  step === 'queued'
    ? 'queued'
    : ['building', 'health_check'].includes(step)
      ? 'building'
      : 'provisioning';

// Decides where an interrupted initial deployment continues. A provider request is
// repeated only after Cloudflare shows that the earlier one did not take effect.
async function resumePoint(job: Job, token: string): Promise<Resume> {
  const root = `/accounts/${job.account_id}`;
  if (job.step === 'intent_create_worker') {
    const workers = z
      .array(
        z.object({
          id: z.string(),
          tag: z.string(),
          created_on: z.string().optional(),
        }),
      )
      .parse(await cloudflare(token, `${root}/workers/scripts`));
    const found = workers.find((w) => w.id === job.worker_name);
    if (!found)
      return {
        step: 'create_worker',
        note: 'The Worker was not created. Shipcel is creating it again.',
      };
    // Generated names are unique, so a Worker older than this request is not ours.
    const created = Date.parse(found.created_on ?? '') / 1000;
    if (!(created >= job.created_at - 300))
      throw new AppError(
        409,
        'A Worker with the generated name existed before this deployment. Shipcel will not adopt it; inspect it in Cloudflare.',
      );
    return {
      step: 'connect_repository',
      fields: { worker_tag: providerId.parse(found.tag) },
      note: 'Found the Worker created before the interruption and continued with it.',
    };
  }
  if (job.step === 'intent_connect_repository')
    return {
      step: 'connect_repository',
      note: 'Repository connections are upserts, so Shipcel is repeating the request.',
    };
  if (job.step === 'intent_create_trigger') {
    const triggers = z
      .array(
        z.object({
          trigger_uuid: providerId,
          trigger_name: z.string().optional(),
        }),
      )
      .parse(
        await cloudflare(
          token,
          `${root}/builds/workers/${job.worker_tag}/triggers`,
        ),
      );
    const ours = triggers.filter(
      (t) => t.trigger_name === `Shipcel ${job.worker_name}`,
    );
    if (ours.length > 1)
      throw new AppError(
        409,
        'There is more than one Shipcel build trigger for this Worker. Remove the duplicate in Cloudflare, then try again.',
      );
    if (ours.length)
      return {
        step: 'start_build',
        fields: { trigger_uuid: ours[0].trigger_uuid },
        note: 'Found the build trigger created before the interruption and continued with it.',
      };
    return {
      step: 'create_trigger',
      note: 'The build trigger was not created. Shipcel is creating it again.',
    };
  }
  if (job.step === 'intent_start_build') {
    const builds = z
      .array(
        z.object({
          build_uuid: providerId,
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
          token,
          `${root}/builds/workers/${job.worker_tag}/builds?per_page=50`,
        ),
      );
    const ours = builds.find(
      (b) =>
        (b.trigger?.trigger_uuid ?? b.trigger_uuid) === job.trigger_uuid &&
        b.build_trigger_metadata?.commit_hash === job.commit_sha,
    );
    if (ours)
      return {
        step: 'building',
        fields: { build_uuid: ours.build_uuid },
        note: 'Found the initial build for the reviewed commit and resumed monitoring it.',
      };
    return {
      step: 'start_build',
      note: 'No build for the reviewed commit was found. Shipcel is starting it again.',
    };
  }
  if (job.step === 'finished')
    return {
      step: 'health_check',
      note: 'Shipcel is repeating the binding review and homepage health check.',
    };
  // Every provider mutation is preceded by an intent_ step, so no request was in flight.
  return {
    step: job.step,
    note: 'No provider request was in flight. Shipcel continued from the same step with a new monitoring window.',
  };
}

recovery.post('/deployments/:id/reconcile', async (c) => {
  const who = requireIdentity(c, 'deploy');
  z.object({ confirm: z.literal(true) })
    .strict()
    .parse(await c.req.json());
  if (c.env.NATIVE_BUILDS_ENABLED !== 'true')
    throw new AppError(
      503,
      'Deployment recovery is disabled until provider setup is verified.',
    );
  if (!who.sessionHash)
    throw new AppError(
      401,
      'Sign in with GitHub before recovering a deployment.',
    );
  const found = await c.env.DB.prepare(
    'SELECT * FROM deployment_jobs WHERE id=? AND workspace_id=?',
  )
    .bind(c.req.param('id'), who.workspaceId)
    .first<Job>();
  if (!found) throw new AppError(404, 'Deployment not found.');
  if (found.status !== 'needs_attention')
    throw new AppError(
      409,
      'Only deployments that need attention can be recovered.',
    );
  // The lease keeps scheduled processing and a second recovery request out.
  const job = await c.env.DB.prepare(
    "UPDATE deployment_jobs SET lease_until=? WHERE id=? AND status='needs_attention' AND lease_until<=? RETURNING *",
  )
    .bind(now() + 90, found.id, now())
    .first<Job>();
  if (!job)
    throw new AppError(409, 'Recovery is already running for this deployment.');
  let failure: AppError | undefined;
  try {
    const project = await c.env.DB.prepare(
      'SELECT id FROM projects WHERE id=? AND workspace_id=?',
    )
      .bind(job.project_id, job.workspace_id)
      .first();
    if (!project)
      throw new AppError(
        409,
        'This project was removed. Inspect its resources in Cloudflare.',
      );
    const [cf, gh] = await Promise.all([
      activeGrant(c.env, who.workspaceId, 'cloudflare'),
      activeGrant(c.env, who.workspaceId, 'github'),
    ]);
    // Reconnected grants are accepted only for the account that owns the deployment.
    if (!cf || cf.account_id !== job.account_id)
      throw new AppError(
        409,
        'Reconnect the Cloudflare account that owns this deployment before recovering it.',
      );
    if (!gh)
      throw new AppError(
        409,
        'Reconnect GitHub before recovering this deployment.',
      );
    const repo = repoSchema.parse(
      await github(
        await grantToken(c.env, gh),
        `/repos/${job.repository_name}`,
      ),
    );
    if (
      String(repo.id) !== job.repository_id ||
      repo.archived ||
      (!repo.permissions?.push && !repo.permissions?.admin)
    )
      throw new AppError(
        403,
        'Repository write access is required to continue this deployment.',
      );
    const resume = await resumePoint(job, await grantToken(c.env, cf));
    try {
      await c.env.DB.prepare(
        "UPDATE deployment_jobs SET step=?,status=?,error=NULL,recovery_note=?,monitor_started_at=?,health_since=NULL,cf_grant_id=?,gh_grant_id=?,worker_tag=COALESCE(?,worker_tag),trigger_uuid=COALESCE(?,trigger_uuid),build_uuid=COALESCE(?,build_uuid),updated_at=? WHERE id=? AND lease_until=? AND status='needs_attention'",
      )
        .bind(
          resume.step,
          statusFor(resume.step),
          resume.note,
          now(),
          cf.id,
          gh.id,
          resume.fields?.worker_tag ?? null,
          resume.fields?.trigger_uuid ?? null,
          resume.fields?.build_uuid ?? null,
          now(),
          job.id,
          job.lease_until,
        )
        .run();
    } catch {
      // The database allows one active setup per workspace and project.
      throw new AppError(
        409,
        'Another pipeline setup is active in this workspace. Wait for it to finish, then try again.',
      );
    }
  } catch (error) {
    failure =
      error instanceof AppError
        ? error
        : new AppError(
            502,
            'Shipcel could not read the provider state. Nothing was changed; try again later.',
          );
    await c.env.DB.prepare(
      'UPDATE deployment_jobs SET recovery_note=?,updated_at=? WHERE id=? AND lease_until=?',
    )
      .bind(
        `Recovery stopped: ${failure.message}`,
        now(),
        job.id,
        job.lease_until,
      )
      .run();
  } finally {
    await c.env.DB.prepare(
      'UPDATE deployment_jobs SET lease_until=0 WHERE id=? AND lease_until=?',
    )
      .bind(job.id, job.lease_until)
      .run();
  }
  if (failure) throw failure;
  await advanceDeployment(c.env, job.id);
  return c.json(
    publicJob(
      (await c.env.DB.prepare('SELECT * FROM deployment_jobs WHERE id=?')
        .bind(job.id)
        .first<Job>())!,
    ),
  );
});
