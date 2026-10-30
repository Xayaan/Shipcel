import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { catalog, kits } from '../kits/index.ts';
import { generateKit } from '../worker/kits';

// The App catalog's contract with a contributor's new kit (docs/guides/add-a-starter-kit.md):
// each fails with the name of the kit and what it is missing.
const files = readdirSync(new URL('../kits/', import.meta.url))
  .filter((name) => !['common.ts', 'index.ts', 'types.ts'].includes(name))
  .map((name) => name.replace(/\.ts$/, ''));

describe('the App catalog', () => {
  it('lists every kit in kits/, under its file name, once', () => {
    expect([...catalog.map((meta) => meta.id)].sort()).toEqual(files.sort());
    expect(new Set(catalog.map((meta) => meta.id)).size).toBe(catalog.length);
    expect(Object.keys(kits).sort()).toEqual(files.sort());
  });

  it('gives every kit an id, the words the dashboard shows and a guide', () => {
    for (const meta of catalog) {
      expect(meta.id, meta.id).toMatch(/^[a-z0-9]+$/);
      for (const field of [
        'name',
        'subtitle',
        'runtime',
        'description',
      ] as const)
        expect(meta[field].trim(), `${meta.id}: ${field}`).not.toBe('');
      expect(meta.symbol.length, `${meta.id}: symbol`).toBeLessThanOrEqual(3);
      expect(meta.docs, `${meta.id}: docs`).toMatch(/^https:\/\//);
    }
  });

  it('pins exact versions, so a kit builds as npm run verify:kits built it', () => {
    for (const [id, kit] of Object.entries(kits))
      for (const [name, version] of Object.entries({
        ...kit.dependencies,
        ...kit.devDependencies,
      }))
        expect(version, `${id}: ${name}`).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exports every kit with the scripts, configuration and README a project needs', () => {
    for (const meta of catalog) {
      const exported = generateKit({
        id: 'p1',
        name: 'my-app',
        framework: meta.id,
        source: 'kit',
        repository: '',
        database: false,
        storage: false,
        freeOnly: !('containers' in meta),
        createdAt: '2026-10-31T00:00:00Z',
      });
      const pkg = JSON.parse(exported['package.json']);
      for (const script of ['dev', 'build', 'predeploy', 'deploy'])
        expect(pkg.scripts[script], `${meta.id}: ${script}`).toBeTruthy();
      expect(pkg.scripts.predeploy).toBe('node scripts/check-config.mjs');
      const config = exported['wrangler.json'] ?? exported['wrangler.jsonc'];
      expect(JSON.parse(config).name, meta.id).toBe('my-app');
      expect(exported['README.md'], meta.id).toContain(`· ${meta.name} ·`);
      expect(exported['scripts/check-config.mjs'], meta.id).toBeTruthy();
    }
  });
});
