import { Hono } from 'hono';
import type { AppEnv } from './types';
import { requireIdentity } from './auth';

export const plans = new Hono<AppEnv>();
plans.get('/', async (c) => {
  const { workspaceId } = requireIdentity(c);
  const limits = await c.env.DB.prepare(
    'SELECT plan,project_limit FROM workspace_limits WHERE workspace_id=?',
  )
    .bind(workspaceId)
    .first<{ plan: string; project_limit: number }>();
  const projects = await c.env.DB.prepare(
    'SELECT COUNT(*) AS count FROM projects WHERE workspace_id=?',
  )
    .bind(workspaceId)
    .first<{ count: number }>();
  const pipelines = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM deployment_jobs WHERE workspace_id=? AND created_at>=CAST(strftime('%s','now','start of month') AS INTEGER)",
  )
    .bind(workspaceId)
    .first<{ count: number }>();
  return c.json({
    name: limits?.plan || 'free',
    price: 0,
    // Matches Cloudflare's Workers Free plan: 100 Workers per account, one build at a time,
    // and no monthly cap on new pipelines (migration 0014).
    projectLimit: limits?.project_limit || 100,
    pipelineLimit: null,
    projects: projects?.count || 0,
    pipelines: pipelines?.count || 0,
    concurrentSetups: 1,
    period: 'calendar month (UTC)',
    infrastructureBilledBy: 'Cloudflare',
  });
});
