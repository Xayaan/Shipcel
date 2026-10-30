import { afterEach, beforeEach, expect, it } from 'vitest';
import { database, projectInput } from './helpers/database';

// The API's answer when a request body, or a provider's response, doesn't have the shape the
// worker expects (worker/index.ts, app.onError): the fields at fault are named, so that a
// provider's drift can be read from the answer and the logs, but never their values.
let db: ReturnType<typeof database>;
beforeEach(() => {
  db = database();
});
afterEach(() => db.close());

it('names the fields of a body that doesn’t fit, never their values', async () => {
  const who = await db.user(1);
  const project = (await (
    await db.request(
      '/projects',
      { method: 'POST', body: JSON.stringify(projectInput()) },
      who.cookie,
    )
  ).json()) as { id: string };
  // Linking a repository parses its body straight against a strict schema.
  const answer = await db.request(
    `/projects/${project.id}/github-actions`,
    {
      method: 'POST',
      body: JSON.stringify({ repository: 5, confirm: true, secret: 'hunter2' }),
    },
    who.cookie,
  );
  expect(answer.status).toBe(400);
  const json = (await answer.json()) as { error: string; fields?: string[] };
  expect(json.error).toBe('Invalid request or provider response.');
  expect(json.fields).toContain('repository');
  expect(JSON.stringify(json)).not.toContain('hunter2');
});
