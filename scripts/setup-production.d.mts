// Types for setup-production.mjs, which npm run production:setup runs directly in Node.
export type Page = { status: number; body: string };
export type SetupDeps = {
  // The command's arguments, such as ['--github-app', 'shipcel'].
  args?: string[];
  run(
    command: string,
    args: string[],
    options?: {
      capture?: boolean;
      input?: string;
      env?: Record<string, string>;
    },
  ): Promise<{ code: number; stdout: string }>;
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  open(url: string): void | Promise<void>;
  serve(
    handler: (path: string, query: URLSearchParams) => Page,
  ): Promise<{ url: string; close(): void }>;
  fetch: typeof globalThis.fetch;
  say(line: string): void;
  random(bytes: number): string;
  readConfig(): Promise<string>;
  writeConfig(text: string): Promise<void>;
};
export function setupProduction(deps: SetupDeps): Promise<void>;
export function withDatabaseId(config: string, id: string): string;
export function serve(
  handler: (path: string, query: URLSearchParams) => Page,
): Promise<{ url: string; close(): void }>;
