// From compatibility date 2026-04-21 the `workers` module comes from the workers-py
// package, which pywrangler includes; pywrangler reads wrangler.jsonc, not wrangler.json.
import { pageStyles, predeploy, taglineFor } from './common.ts';
import type { Kit, KitMeta } from './types.ts';

// What the App catalog shows.
export const meta = {
  id: 'python',
  name: 'Python',
  subtitle: 'Python Workers & FastAPI',
  runtime: 'Python Workers',
  family: 'Python',
  symbol: 'Py',
  color: 'blue',
  description:
    'A Python Worker starter kit that runs and deploys with pywrangler (it needs uv), or an import of a Python Worker. Projects with packages such as FastAPI, or a compatibility date from 2026-04-21, deploy with pywrangler from a committed pyproject.toml and uv.lock. Only Pyodide-compatible packages work. Kit and fixtures run locally.',
  docs: 'https://developers.cloudflare.com/workers/languages/python/',
  bindings: true,
} as const satisfies KitMeta;

// What an exported project contains, beyond what every kit gets.
export const kit: Kit = {
  config: () => ({
    main: 'src/entry.py',
    compatibility_flags: ['python_workers'],
    observability: { enabled: true },
  }),
  scripts: {
    dev: 'uv run pywrangler dev',
    build: 'uv run pywrangler deploy --dry-run --outdir dist',
    predeploy,
    deploy: 'uv run pywrangler deploy',
  },
  dependencies: {},
  ignore: '__pycache__/\npython_modules/\n.venv/\n.venv-workers/\n',
  configFile: 'wrangler.jsonc',
  files: (project) => {
    const files: Record<string, string> = {};
    const tagline = taglineFor(project, meta.name);
    files['pyproject.toml'] =
      `[project]\nname = "${project.name}"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = []\n\n[dependency-groups]\ndev = ["workers-py", "workers-runtime-sdk"]\n`;
    const page = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${project.name}</title><style>${pageStyles}</style></head><body><main><span class="eyebrow">Built with Shipcel</span><h1>Your app. Your infrastructure.</h1><p>${tagline}</p><a href="/api/health">Check your API →</a></main></body></html>`;
    files['src/entry.py'] =
      `from urllib.parse import urlparse\n\nfrom workers import Response, WorkerEntrypoint\n\nPAGE = ${JSON.stringify(page)}\n\n\nclass Default(WorkerEntrypoint):\n    async def fetch(self, request):\n        path = urlparse(request.url).path\n        if path == "/api/health":\n            return Response.json({"ok": True, "app": "${project.name}"})\n` +
      (project.database
        ? '        # The D1 database is self.env.DB, for example:\n        # rows = await self.env.DB.prepare("SELECT 1 AS one").all()\n'
        : '') +
      `        if path != "/":\n            return Response("Not found", status=404)\n        return Response(PAGE, headers={"Content-Type": "text/html; charset=utf-8"})\n`;
    return files;
  },
  readme: {
    runLocally:
      'pywrangler installs the `workers` SDK into `python_modules/` and runs your Python Worker in Wrangler. It needs [uv](https://docs.astral.sh/uv/).\n',
    notes:
      'Install [uv](https://docs.astral.sh/uv/), then run `uv lock` and commit `uv.lock` with `package-lock.json`. From compatibility date 2026-04-21, Python Workers get the `workers` module from the workers-py package, so this kit runs and deploys with pywrangler, which includes it, and Shipcel deploys it the same way. Add packages such as FastAPI to `dependencies` in `pyproject.toml` and run `uv lock` again. Only pure-Python and Pyodide-compatible packages work.',
  },
};
