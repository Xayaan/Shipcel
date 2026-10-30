import { describe, expect, it } from 'vitest';
import {
  previewCommand,
  previewRefusal,
  previewsBlock,
  previewsBlockIssues,
  previewsSnippet,
  repositoryPlan,
  stagingName,
  type StagingResource,
} from '../worker/repository-plan';

// Branch and pull request previews use Cloudflare's Worker Previews: `wrangler preview`
// deploys each branch as a Preview of the production Worker. Previews inherit no bindings,
// so the committed configuration needs a `previews` block that binds separate staging
// copies of the app's databases, namespaces and buckets.
const staging: StagingResource[] = [
  {
    type: 'd1',
    binding: 'DB',
    name: 'my-app-pv-a1b2c3-db',
    id: '60000000-0000-4000-8000-000000000001',
  },
  {
    type: 'kv',
    binding: 'CACHE',
    name: 'my-app-pv-a1b2c3-cache',
    id: '0123456789abcdef0123456789abcdef',
  },
  {
    type: 'r2',
    binding: 'FILES',
    name: 'my-app-pv-a1b2c3-files',
    id: 'my-app-pv-a1b2c3-files',
  },
];
const files = (config: Record<string, unknown>) => ({
  'package.json': JSON.stringify({ scripts: { build: 'vite build' } }),
  'package-lock.json': '{}',
  'wrangler.json': JSON.stringify({
    name: 'my-app',
    main: 'src/index.js',
    compatibility_date: '2026-10-07',
    ...config,
  }),
});

describe('preview commands and refusals', () => {
  it('deploys each branch with wrangler preview on the production Worker', () => {
    expect(previewCommand('configured-worker', 'my-app')).toBe(
      'npx wrangler@4.156.0 preview --worker-name my-app',
    );
    expect(previewCommand('astro', 'my-app')).toBe(
      'npx wrangler@4.156.0 preview --worker-name my-app',
    );
    expect(() => previewCommand('configured-worker', 'My App')).toThrow();
    expect(() => previewCommand('nextjs', 'my-app')).toThrow();
  });

  it('explains which apps cannot have previews yet', () => {
    expect(previewRefusal('configured-worker')).toBeNull();
    expect(previewRefusal('python')).toBeNull();
    expect(previewRefusal('nextjs')).toContain(
      'service bindings from a Preview always reach production',
    );
    expect(previewRefusal('container')).toContain('container');
    expect(previewRefusal('python-packages')).toContain('pywrangler');
    expect(previewRefusal('direct-upload')).toContain('direct upload');
  });
});

describe('staging resource names', () => {
  it('names staging copies after the Worker, a random suffix and the binding', () => {
    expect(stagingName('my-app', 'a1b2c3', 'DB')).toBe('my-app-pv-a1b2c3-db');
    expect(stagingName('my-app', 'a1b2c3', 'USER_FILES')).toBe(
      'my-app-pv-a1b2c3-user-files',
    );
  });

  it('stays a valid 63-character bucket name for the longest Worker and binding names', () => {
    const name = stagingName('w'.repeat(63), 'a1b2c3', 'B'.repeat(30));
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
    expect(name).toContain('-pv-a1b2c3-');
    // Truncating the Worker name never leaves a hyphen before -pv-.
    expect(
      stagingName(
        `${'w'.repeat(20)}-${'x'.repeat(42)}`,
        'a1b2c3',
        'B'.repeat(30),
      ),
    ).not.toContain('--');
  });
});

describe('the previews block', () => {
  it('binds every staging copy, and IMAGES for Astro', () => {
    expect(previewsBlock(staging, 'configured-worker')).toEqual({
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'my-app-pv-a1b2c3-db',
          database_id: '60000000-0000-4000-8000-000000000001',
        },
      ],
      kv_namespaces: [
        { binding: 'CACHE', id: '0123456789abcdef0123456789abcdef' },
      ],
      r2_buckets: [{ binding: 'FILES', bucket_name: 'my-app-pv-a1b2c3-files' }],
    });
    expect(previewsBlock([], 'configured-worker')).toEqual({});
    expect(previewsBlock([], 'astro')).toEqual({
      images: { binding: 'IMAGES' },
    });
  });

  it('gives a snippet to paste at the top level of the configuration', () => {
    const snippet = previewsSnippet(staging.slice(0, 1), 'configured-worker');
    expect(snippet.startsWith('"preview_urls": true,\n"previews": {')).toBe(
      true,
    );
    // The snippet is valid inside an object.
    expect(JSON.parse(`{${snippet}}`)).toEqual({
      preview_urls: true,
      previews: previewsBlock(staging.slice(0, 1), 'configured-worker'),
    });
  });

  it('accepts exactly the staging copies, plus plain variables', () => {
    expect(
      previewsBlockIssues(
        {
          ...previewsBlock(staging, 'configured-worker'),
          vars: { MODE: 'preview', RETRIES: 2, DEBUG: true },
          observability: { enabled: true },
        },
        staging,
      ),
    ).toEqual([]);
    expect(previewsBlockIssues({}, [])).toEqual([]);
  });

  it('asks for the block when it is missing', () => {
    expect(previewsBlockIssues(undefined, [])[0]).toContain(
      'Add a previews block',
    );
    expect(previewsBlockIssues(['no'], [])[0]).toContain('must be an object');
  });

  it('refuses bindings to anything but the staging copies, such as production data', () => {
    const production = {
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'my-app-db',
          database_id: '70000000-0000-4000-8000-000000000001',
        },
      ],
    };
    expect(previewsBlockIssues(production, staging.slice(0, 1))).toEqual([
      expect.stringContaining('DB'),
    ]);
    expect(
      previewsBlockIssues(
        {
          kv_namespaces: [{ binding: 'OTHER', id: 'f'.repeat(32) }],
        },
        [],
      ),
    ).toEqual([expect.stringContaining('OTHER')]);
  });

  it('reports staging copies the block leaves out', () => {
    expect(previewsBlockIssues({}, staging.slice(0, 2))).toEqual([
      expect.stringContaining('DB'),
      expect.stringContaining('CACHE'),
    ]);
  });

  it('refuses settings Shipcel does not review yet', () => {
    expect(
      previewsBlockIssues(
        { services: [{ binding: 'API', service: 'other' }] },
        [],
      )[0],
    ).toContain('services');
    expect(
      previewsBlockIssues({ vars: { NESTED: { a: 1 } } }, [])[0],
    ).toContain('vars');
  });
});

describe('repository inspection with previews settings', () => {
  it('accepts a previews block and preview_urls, and hands the block on for review', () => {
    const block = previewsBlock(staging.slice(0, 1), 'configured-worker');
    const plan = repositoryPlan(
      files({
        d1_databases: [{ binding: 'DB' }],
        preview_urls: true,
        previews: block,
      }),
    );
    expect(plan.issues).toEqual([]);
    expect(plan.previews).toEqual(block);
    expect(plan.previewUrls).toBe(true);
    expect(repositoryPlan(files({})).previews).toBeUndefined();
  });

  it('refuses a preview_urls setting that is not true or false', () => {
    expect(
      repositoryPlan(files({ preview_urls: 'yes' })).issues.join(' '),
    ).toContain('preview_urls');
  });
});
