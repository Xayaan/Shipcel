// The App catalog: every starter kit, one file each, in the order the dashboard lists them.
// docs/guides/add-a-starter-kit.md shows how to write one. A new kit goes on both lists;
// TypeScript refuses a kit that is on one and not the other.
import * as astro from './astro.ts';
import * as docker from './docker.ts';
import * as hono from './hono.ts';
import * as n8n from './n8n.ts';
import * as nextjs from './nextjs.ts';
import * as postgres from './postgres.ts';
import * as python from './python.ts';
import * as react from './react.ts';
import * as staticSite from './static.ts';
import * as sveltekit from './sveltekit.ts';
import type { Kit } from './types.ts';
import * as umami from './umami.ts';
import * as vue from './vue.ts';
import * as wordpress from './wordpress.ts';
import * as worker from './worker.ts';

export const catalog = [
  react.meta,
  nextjs.meta,
  vue.meta,
  hono.meta,
  postgres.meta,
  astro.meta,
  sveltekit.meta,
  staticSite.meta,
  worker.meta,
  python.meta,
  docker.meta,
  umami.meta,
  n8n.meta,
  wordpress.meta,
] as const;

export const kits = {
  react: react.kit,
  nextjs: nextjs.kit,
  vue: vue.kit,
  hono: hono.kit,
  postgres: postgres.kit,
  astro: astro.kit,
  sveltekit: sveltekit.kit,
  static: staticSite.kit,
  worker: worker.kit,
  python: python.kit,
  docker: docker.kit,
  umami: umami.kit,
  n8n: n8n.kit,
  wordpress: wordpress.kit,
} satisfies Record<(typeof catalog)[number]['id'], Kit>;
