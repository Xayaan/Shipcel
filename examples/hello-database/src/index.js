// hello-database: one Worker that uses a D1 database, a KV namespace, a Durable Object, a
// variable and a cron schedule. GET /api/check exercises each of them and says what it
// found, so one request shows whether a deploy wired everything up.
import { DurableObject } from 'cloudflare:workers';

// Counts how often it was asked, in its own storage.
export class Counter extends DurableObject {
  async next() {
    const count = ((await this.ctx.storage.get('count')) ?? 0) + 1;
    await this.ctx.storage.put('count', count);
    return count;
  }
}

async function check(env) {
  // The database: a table made on first use, one row per check.
  await env.DB.exec(
    'CREATE TABLE IF NOT EXISTS checks (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL)',
  );
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO checks (at) VALUES (?)').bind(now).run();
  const { rows } = await env.DB.prepare(
    'SELECT count(*) AS rows FROM checks',
  ).first();
  // The namespace: what this check stores, and what the schedule stored last.
  await env.CACHE.put('last-check', now);
  const stored = await env.CACHE.get('last-check');
  const lastScheduledRun = await env.CACHE.get('last-scheduled-run');
  // The Durable Object: one counter, shared by every request.
  const counter = await env.COUNTER.get(
    env.COUNTER.idFromName('checks'),
  ).next();
  return {
    greeting: env.GREETING,
    database: { rows },
    namespace: { readBack: stored === now },
    counter,
    lastScheduledRun,
  };
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/api/check')
      return new Response('Not found', { status: 404 });
    try {
      return Response.json(await check(env));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
  // Every fifteen minutes: leaves the time it ran where /api/check can show it.
  async scheduled(controller, env) {
    await env.CACHE.put(
      'last-scheduled-run',
      new Date(controller.scheduledTime).toISOString(),
    );
  },
};
