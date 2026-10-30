// The App catalog's kits come from kits/, one file each (kits/index.ts lists them); a
// project's framework is one of their ids.
import { catalog } from '../kits/index.ts';
import type { KitMeta } from '../kits/types.ts';

export type FrameworkId = (typeof catalog)[number]['id'];
export type Framework = KitMeta & { id: FrameworkId };
export const frameworks: readonly Framework[] = catalog;
export const getFramework = (id: string) =>
  frameworks.find((f) => f.id === id)!;
// Every runtime in the catalog has a starter kit, and its GitHub repositories import.
const known = (id: string) => frameworks.some((f) => f.id === id);
export const hasKit = known;
// Runtimes that deploy containers: the Docker runtime and the services built on it. They
// need Workers Paid, and Cloudflare's builds make their images.
export const usesContainers = (id: string | null | undefined) =>
  frameworks.some((f) => f.id === id && f.containers === true);
// Runtimes whose GitHub repositories can use the native deployment pipeline.
export const hasImportAdapter = known;
// Runtimes that offer a D1 database and R2 storage.
export const allowsBindings = (id: string) =>
  frameworks.some((f) => f.id === id && f.bindings === true);

// Where a project starts: a starter kit to export, or a GitHub repository to deploy.
export type ProjectSource = 'kit' | 'github';
export interface Project {
  id: string;
  name: string;
  framework: FrameworkId;
  source: ProjectSource;
  repository: string;
  database: boolean;
  storage: boolean;
  // Shipcel refuses anything Cloudflare can bill for: R2 buckets and containers.
  freeOnly: boolean;
  createdAt: string;
  // The budget guard's last reading: over the project's budget, or paused for it.
  budget?: 'over' | 'paused' | null;
}

export interface Activity {
  id: string;
  projectId: string;
  projectName: string;
  kind: 'project.created' | 'kit.exported' | 'project.deleted';
  createdAt: string;
}

export interface ProjectInput {
  name: string;
  framework: FrameworkId;
  source: ProjectSource;
  repository: string;
  database: boolean;
  storage: boolean;
  freeOnly: boolean;
}
