// source 'adapter': added by a framework adapter at build time; optional if the repository disables it.
// 'hyperdrive': a Postgres or MySQL database added to the project earlier (worker/hyperdrive.ts),
// bound by its configuration `id`; a deploy creates nothing for it.
export type ResourceRequest = {
  type: 'd1' | 'r2' | 'kv' | 'hyperdrive';
  binding: string;
  source?: 'adapter';
  id?: string;
};
// A container the repository declares. 'default': Cloudflare schedules up to maxInstances
// instances of instanceType. 'durable_object' (beta): the Durable Object's code starts its
// container and chooses the instance type, so both are null.
export type ContainerRequest = {
  className: string;
  policy: 'default' | 'durable_object';
  // Dockerfile paths in the repository, or registry image references.
  images: string[];
  instanceType: string | null;
  maxInstances: number | null;
};
export interface RepositoryInspection {
  repository: string;
  branch: string;
  commit: string;
  adapter: string;
  buildCommand: string;
  resources: ResourceRequest[];
  containers: ContainerRequest[];
  warnings: string[];
  issues: string[];
  ready: boolean;
  workerName?: string;
  // A Next.js app's incremental cache, when open-next.config.ts sets one.
  openNextCache?: 'r2' | 'kv' | 'static-assets';
  // A site without a Wrangler configuration: what Shipcel deploys, and how it's served.
  site?: { preset: string; directory: string; spa: boolean };
}
