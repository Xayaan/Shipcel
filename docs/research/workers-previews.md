DESIGN BRIEF: Moving Cloudcel branch previews to Cloudflare Worker Previews
Date: 8 Oct 2026. This brief combines six research reports and a read-only check of the local code. No live Cloudflare calls were made. Everything below is documentation, source or fixture evidence, not live deployment evidence.

SOURCE KEYS

- [P] /workers/previews/ (updated 24 Sep 2026)
- [GS] /workers/previews/get-started/
- [CFG] /workers/previews/configuration/
- [RES] /workers/previews/resources/
- [CD] /workers/previews/custom-domains/
- [TD] /workers/previews/test-and-debug/
- [EX] /workers/previews/examples/
- [CW] /workers/previews/compare-workflows/
- [CMD] /workers/wrangler/commands/workers/ (preview sections)
- [BB] /workers/ci-cd/builds/build-branches/
- [BC] /workers/ci-cd/builds/configuration/
- [BO] /workers/ci-cd/builds/ (overview)
- [BAPI] /workers/ci-cd/builds/api-reference/
- [TRIG] the REST trigger create/update pages
- [BGET] the REST "Get build" page
- [GH] /workers/ci-cd/builds/git-integration/github-integration/
- [GL] the GitLab integration page
- [VU] /workers/versions-and-deployments/version-urls/
- [CL] changelog 2026-09-22-worker-previews
- [AX] changelog 2026-08-14-workers-access
- [OAS] github.com/cloudflare/api-schemas openapi.json at commit a6aa0f6d (7 Oct 2026). Previews paths start at line 353026, `workers_Preview` at 727786, `workers_PreviewDeployment` at 728010, Builds previews at 118132-118439.
- [W] node_modules/wrangler/wrangler-dist/cli.js, Wrangler 4.148.0. Numbers are line numbers.
- [WS] node_modules/wrangler/config-schema.json
- [VP] node_modules/@cloudflare/vite-plugin/dist/index.mjs, version 1.63.0
- [ISS] github.com/cloudflare/developer-platform/issues/73
- [CC] Cloudcel source and HANDOFF.md

Ranking rule: the local Wrangler 4.148.0 source [W] is the ground truth for what the CLI does. [OAS] is the best evidence for the REST API. The prose docs decide intended product behaviour. Nothing here proves what the server actually does.

======================================================================

1. FACTS
   \======================================================================

1.1 What Workers Previews are

- Each Preview is an isolated, production-like environment for one branch, under the same Worker. It has its own variables, secrets, bindings, URL and observability. [P]
- `npx wrangler preview` creates or updates the Preview for the current branch. It is the counterpart of `wrangler deploy`. [P; GS]
- Previews are not Worker versions, active deployments or gradual deployments. [BO L75] So they do not appear in production version history.
- Cloudflare's guidance [CW]:
  - Previews are "the recommended way to test changes before production."
  - "Do not use Version URLs for branch or pull request testing."
  - The migration is from `versions upload --preview-alias X` to `npx wrangler preview --name X`.
- Launched 22 Sep 2026. [CL] The CLI marks every preview command `status: "open beta"`. [W 343850-343854]
- Requires Wrangler 4.135.0 or later as a project dependency. [P; GS] Cloudcel pins 4.148.0 through `npx wrangler@4.148.0`. [CC repository-plan.ts:757]

1.2 Configuration schema

- Previews do not inherit production settings. [CFG; P]
- A `previews` block is required but may be empty (`"previews": {}`). [CFG; GS]
- The config file on the current branch is the source of truth. Git carries the base branch's block into new branches. [CFG]
- When the block is missing, Wrangler builds a suggested block and throws a UserError. [W 343695-343813; error at 343740-343791]
  - It only offers to write the block into the file when the run is interactive, not CI, not `--json`, and a dashboard Base config exists. [W 343792-343810]
  - Any `<REPLACE_ME>` placeholder left in the block is a hard error. [W 343696-343706]
  - Result: in Workers Builds, a repository without a `previews` block fails every preview build.
- Settings that stay top level only: `assets`, `compatibility_date`, `compatibility_flags`, and DO/container `migrations`. [CFG; W 177936-177991]
- Top-level value is used unless `previews` overrides it: `observability`, `logpush`, `limits`, `placement`, `cache`. [W 177596-177611, 177992-178005] `cache` is not in [CFG]'s table.
- Must be declared in `previews` (not inherited): [CFG; W 177547]
  - `vars`, `define`, `tail_consumers`
  - all storage and data bindings
  - `queues.producers`, `workflows`, `services`
  - DO env bindings (`previews.durable_objects.bindings`)
  - `containers`
  - API bindings (`ai`, `browser`, `images`, and so on)
- Bindings sent with a Preview deployment come only from `config.previews`, plus the top-level `assets.binding`. [W 177547, 178016]
- Must not be declared in `previews`: queue consumers, crons, production routes. Queue `consumers` passes validation but is never sent. [CFG; W 177417]
- Allowed keys:
  - The runtime validator accepts 42 keys; unknown keys produce only a warning. [W 25776-26103, 20232-20245]
  - The JSON schema lists 47 keys with `additionalProperties: false`. [WS 4408-5787]
- `previews` is inheritable by `env.<name>`. [W 21801-21808] Every preview command must then pass the same `--env`. [CW]
- Previews Base config:
  - It is a Worker-level field `previews_base_config` holding `env` (bindings), `observability`, `logpush`, `limits`, `placement`, `cache` and `tail_consumers`.
  - It is read and written with GET/PATCH `/accounts/{a}/workers/workers/{worker}` (merge-patch). [W 177054-177072, 343029-343050]
  - The docs say it seeds NEW Previews. Base secrets change only new Previews. [CFG]
  - Containers cannot come from the Base config: the converter sets `containers: void 0`. [W 343029-343050]
- workers.dev Preview URLs need the Worker subdomain `previews_enabled` set (`preview_urls: true` in config). [CD]
  - When `preview_urls` is omitted, `wrangler deploy` sends `previews_enabled: undefined` and the server decides. [W 160657-160665, 160733-160741]
  - The CLI warning says the value then follows the workers.dev status. [W 160762-160773]

1.3 Resource behaviour

- Provisioned automatically per Preview [RES; P]:
  - Durable Objects (same-Worker class without `script_name`): a new namespace and storage for each Preview. State persists across that Preview's deployments and is deleted with the Preview.
  - Containers: a new container app and instances for each Preview. Support is described as partial.
- Isolated only if the Preview binds a different resource: KV (`id`), D1 (`database_id`), R2 (`bucket_name`), queue producers, Vectorize, Hyperdrive, Analytics Engine, Pipelines, Secrets Store, and others. [RES] Previews that share an ID share the data.
- No automatic provisioning for Preview bindings:
  - `provisionBindings` is called only from `deployWorker` and `uploadWorkerVersion`, never from `runPreview` or `previewHandler`. [W 170327; calls at 176042 and 176572]
  - `--x-provision` and `--x-auto-create` are global flags that default to true. [W 361358-361371] They parse on `wrangler preview` but do nothing there.
  - A `previews` binding without an ID is sent with `undefined` for the ID. [W 177335-177338]
- Recommended D1 pattern [RES]:
  - One shared staging database, bound in `previews.d1_databases` on the base branch.
  - Migrations applied with a separate migrations config before running `wrangler preview`.
  - Isolating one branch means editing both files.
- Not supported or not isolated [RES; CFG]:
  - Service bindings always reach the production deployment of the bound Worker. For same-Worker calls, use `ctx.exports`.
  - Workflows bind to existing deployed Workflows.
  - Queue consumers are not supported.
  - Crons and zone routes are production only.
  - `wrangler tail` does not support Previews. [TD]
- Deleting a Preview removes its DO namespace. Its container app can remain and must be deleted by the prefix `${worker}_${previewSlug}_`. [RES; W 177584-177595]

1.4 Naming

- The Preview name defaults to the branch. Wrangler resolves it in this order [W 177100-177114]:
  1. `WORKERS_CI_BRANCH`
  2. `GITHUB_HEAD_REF` or `GITHUB_REF_NAME`
  3. `CI_COMMIT_REF_NAME`
  4. `git branch --show-current`
     On a detached HEAD with none of these set, the command fails. [W 178154-178163]
- The CLI does not sanitize the name and sets no length limit. It sends the raw name and URL-encodes it in API paths. [W 176963-176968, 178199]
- `sanitizeBranchName` and the 63-character, 4-hex-hash alias logic exist only on the legacy `versions upload --preview-alias` path. [W 176822-176876, 215289]
- The server's rules [OAS `workers_Preview`]:
  - `name`: maxLength 256, pattern `^[a-zA-Z0-9]([a-zA-Z0-9\-_/.+=]*[a-zA-Z0-9])?$`
  - `slug`: read-only. The example maps `feature/my-branch` to `feature-my-branch`.
- The Worker the Preview belongs to is chosen as `WRANGLER_CI_OVERRIDE_NAME ?? --worker-name ?? config.name`. [W 177260-177271]
  - The CI override wins over `--worker-name`.
  - In `wrangler preview`, `--name` is the Preview name, not the Worker name. [CMD; W 343849-343897]

1.5 URLs

- workers.dev [P; CD]:
  - Preview URL (always the latest deployment): `<preview-name>-<worker>.<subdomain>.workers.dev`
  - Deployment URL (immutable): `<deployment-id>-<worker>.<subdomain>.workers.dev`
- Custom domain [P; CD]:
  - Preview URL: `<preview-name>.app.example.com`
  - Deployment URL: `<deployment-id>-<preview-name>.app.example.com`
  - Configured with a route that has `custom_domain: true` and `previews_enabled: true` (`enabled: false` makes it Preview-only), applied with `wrangler deploy`.
  - Cloudflare creates a wildcard DNS record and certificate. Deeper hostnames may need Advanced Certificate Manager. [CD]
- The CLI never builds URLs. It prints `preview.urls` and `deployment.urls` from the API, or "no active URLs" plus a fix. [W 178043-178061, 177749-177832]
- workers.dev Preview URLs send `X-Robots-Tag: noindex`; custom-domain Preview URLs do not. [P; CD]
- All Preview URLs are public by default. Cloudflare Access can protect every Preview on an account, one Worker's Previews, or specific hostnames. [P; CD; AX]

1.6 Limits

- Previews per Worker: 100 on Free, 500 on Paid. [P]
- Deployments per Preview: 100 on both. [P]
- At either limit, the least recently deployed Preview or the oldest deployment is deleted automatically. [P]
- Not stated: name and hostname limits, per-account limits, rate limits, pricing. [P; overview report §11]

1.7 REST API (beta: `x-fern-availability: beta`, audience "sdk"; not in the rendered API docs or the JS SDK) [OAS]

- Base path: `/accounts/{account_id}/workers/workers/{worker_id}/previews`. `worker_id` may be an ID or a name.
- Preview endpoints:
  - GET list: `page`, `per_page` (max 100), `order_by` (deployed_on, updated_on, created_on, slug or name), `order`, and `slug`/`name` partial-match filters.
  - GET, POST, PATCH, PUT and DELETE `.../{preview_id}`. `preview_id` may be the ID, slug or URL-encoded name.
  - DELETE takes an optional `?force` and returns only the envelope.
- Deployment endpoints:
  - GET list and GET one: `deployment_id` may be a UUID, an 8-character prefix, or `latest`.
  - POST (multipart).
  - PATCH `/deployments/latest` (JSON merge-patch; creates a new deployment).
  - DELETE.
- Preview object: `id`, `slug`, `name`, `urls[]`, `tags`, `observability`, `logpush`, `tail_consumers`, `created_on`, `updated_on`, `deployed_on`.
- PreviewDeployment object:
  - `id`, `number`, `urls[]`, `author_email`, `source`, `created_on`
  - `annotations`: `workers/commit_sha`, `workers/tag`, `workers/pull_request_url`, `workers/pull_request_number`, and others
- Token groups:
  - Read endpoints: Workers Scripts Read/Write or Workers Tail Read.
  - PUT, DELETE and DELETE deployment: Workers Scripts Write.
  - Create, Edit, Create deployment and Patch latest: not stated.
- Hidden Builds endpoints (`x-forge-hidden`, generally available):
  - `/accounts/{a}/builds/workers/{script_tag}/previews[...]`, whose summaries include `branch`, `auto_build` and `auto_delete`.
  - `POST .../migrate_to_previews`.
  - They return no URLs.
- Wrangler calls get, create, edit, delete, deployment get/create/patch, base-config get/patch, and auto-creation of the parent Worker. [W 176950-177072] It never calls list.

1.8 Wrangler commands (4.148.0)

- `wrangler preview [script]` flags: `--name`, `--tag`, `--message`, `--json`, `--ignore-base-config`, `--worker-name`, `--var KEY:VALUE`, `--secrets-file`, and the global `--env`/`--config`. [W 343849-343897]
- `wrangler preview delete`: `--name`, `-y`, `--worker-name`.
- `wrangler preview secret put|delete|list|bulk` and `wrangler preview base-config secret put|delete|list|bulk`. [W 361580-361625]
- There is no `wrangler preview list`.
- A run does: GET preview → POST or PATCH preview → POST deployment (multipart) → deploy any container images. [W 178149-178309]
  - It auto-creates a missing parent Worker without asking in CI. [W 178120-178148]
- Output record with `preview_id`, `preview_slug`, `preview_urls`, `deployment_id` and `deployment_urls` goes to `WRANGLER_OUTPUT_FILE_*`. [W 343958-343969]
- Annotations:
  - Commit SHA only from `GITHUB_SHA`, `CI_COMMIT_SHA`, `CIRCLE_SHA1` or `COMMIT_SHA`. [W 177134-177136]
  - PR metadata from GitHub Actions, GitLab or generic `PULL_REQUEST_URL`/`PR_URL` variables. [W ~177202-177257]
  - When `CI` is `1` or `true` and the flags are absent, the tag falls back to the short HEAD SHA and the message to the commit message. [W 177115-177117, 178166-178167]

1.9 Workers Builds integration and PR comments

- The Preview command defaults to `npx wrangler preview`. [BC L26, L47; BB L32] It runs after the build command on every push to a non-production branch when Preview Builds are enabled. [BB L39]
- The trigger API is unchanged: at most two triggers per Worker, production and preview. [BAPI L49]
  - There is no preview-specific field. The preview trigger's `deploy_command` is the Preview command, shown by example only. [BAPI L399-423; TRIG]
  - Requires a user-scoped token. [BAPI L23]
- Workers connected to Builds before Previews launched need a one-time dashboard switch, which "cannot be reversed". [BB L43-52] No documented API exists. The hidden `migrate_to_previews` endpoint is in [OAS] only.
- GitHub: the Cloudflare app posts a PR comment with build status, and "A Preview URL will be provided for builds which perform `wrangler preview`". Pushes update the same Preview URL, and each deployment also gets an immutable URL. [GH L25-31]
- GitLab: the same, with MR comments. [GL L23-31]
- Changing the Preview command to `versions upload` yields Version URLs, which use production-configured resources. [BC L77]
- Builds does not delete Previews when a PR closes. The documented pattern is a CI job running `wrangler preview delete --name pr-<N> -y`. [EX L120-137; BB]

====================================================================== 2. CONTRADICTIONS AND GAPS
======================================================================

1. Base config versus file block.
   - [CFG] says the block is "required". [W] confirms that a missing block is fatal in CI even when a Base config exists.
   - [CFG] says the Base config seeds new Previews. But the CLI's missing-binding check treats the Base config's `env` as available bindings [W 178282-178293, 178096-178119], and [OAS] has an `ignore_defaults` parameter on deployment create. Both suggest the server applies Base `env` to deployments.
   - How the server merges them is not stated anywhere. This is the most important open question for Cloudcel (section 3.3).
2. Naming.
   - The docs say nothing about naming. [OAS] gives the allowed pattern and a 256-character maximum. [W] does no sanitization.
   - Cloudcel's `previewAlias` (HANDOFF.md:82) copies the legacy alias algorithm [W 176822-176876], which does not apply to Previews.
   - Hostname-label overflow (`<slug>-<worker>` over 63 characters) is not stated.
3. URL example. [OAS] gives the example `https://feature-my-branch-my-worker.workers.dev` with no account subdomain, which contradicts [P]. Treat the [OAS] example as illustrative.
4. `preview_urls`.
   - [WS] gives default false and describes it with Version URL wording (`<version>-<name>...`).
   - [CD] says "omitted means unchanged; with no existing setting, it depends on workers_dev."
   - [W] decides: when omitted, nothing is sent and the server decides.
5. Observability inheritance. The domains-debug report says this is not stated. [W 177597-177600] shows a fallback to the top level, which settles it for the CLI.
6. Schema versus validator. These keys are in [WS] but not in the [W] validator: `secrets`, `cloudchamber`, `connect`, `agent_memory`, `vpc_networks`. Using them gives a warning only. Whether `previews.secrets.required` is enforced is not stated.
7. Builds `preview_url`. [BGET] describes it as the URL of "the Worker version this build deployed", which is Version URL wording. Its meaning for `wrangler preview` builds is unclear, so it should not be relied on.
8. GitLab. The Git-integration index says "commit statuses"; [GL] describes MR comments.
9. Durable Objects. Cloudcel's `previewRefusal` text (repository-plan.ts:735; HANDOFF.md:68) is true for Version URLs [VU] but false for Previews, which provision DO namespaces and container apps per Preview [RES].
10. Old alias URLs. Whether Builds still sets `WRANGLER_CI_GENERATE_PREVIEW_ALIAS` [W 19820, 215289] for new Workers whose preview trigger runs `versions upload` is not stated. Cloudcel's current computed alias URLs may therefore not exist for new Workers. This risk applies to the current design whether or not Cloudcel switches.
11. REST availability. The Previews REST API is in [OAS] (beta) but missing from the rendered docs, `llms.txt`, and the JS SDK (5.2.0 and 7.3.0). Wrangler reads `deployment.preview_id` and `deployment.preview_name` [W 342931, 342936], which [OAS] does not define.
12. Deletion propagation. [RES] says a deleted Preview stops serving after deletion propagates. [ISS] reports one hostname still serving more than 4 hours after deletion.
13. Hidden fields. The hidden Builds `auto_delete` and `auto_build` fields [OAS] suggest an automatic cleanup feature that no prose page documents.
14. Worker count. The Builds [OAS] says a Preview "is a Worker in its own right" (it has a script tag). Whether Previews count toward the 100-Workers-per-account Free limit is not stated.

====================================================================== 3. IMPACT ON CLOUDCEL
======================================================================

3.1 Should Cloudcel switch? Yes, as the target design. Enabling it for customers should wait for the live checks in section 4.

Reasons:

- It matches the owner's goal directly: Builds comments a Preview URL on GitHub and GitLab PRs [GH L29-31; GL], with a stable URL per branch and an immutable URL per deploy.
- It removes the second Worker per project.
  - Today, `cc-<project>-pv-<id12>` (repository-plan.ts:716-729) uses a Worker slot. The Free plan offer is 100 projects matched to 100 Workers (HANDOFF.md:40).
  - Whether Previews consume Worker slots is unknown (gap 14).
- It no longer depends on the legacy alias path, which Cloudflare advises against [CW; BC L77] (gap 10).
- DO and container isolation per Preview becomes available, which removes the stated reason for refusing containers and DOs. [RES]
- Production rollback is unaffected: Previews are not Worker versions [BO L75], so the version list behind the existing rollback stays clean. That rollback is `POST .../deployments` at 100% in operations.ts:350.

Costs:

- The customer's committed config must contain `previews`.
- KV, D1 and R2 for Previews must be pre-created; Wrangler will not create them.
- The API is beta and undocumented in the rendered docs.
- Branch names outside the [OAS] pattern will fail.

3.2 Build trigger commands

- Production trigger: unchanged. `npx wrangler@4.148.0 deploy --no-autoconfig --x-provision --x-auto-create --name <worker>` (repository-plan.ts:757).
- Preview trigger, on the same production Worker (same `external_script_id`, `build_command`, `build_token_uuid`, `root_directory` and path filters):
  - `deploy_command`: `npx wrangler@4.148.0 preview --worker-name <worker>`
  - `branch_includes: ["*"]`, `branch_excludes: [<production branch>]` [BAPI L399-423]
  - No `--name`: the Preview name comes from `WORKERS_CI_BRANCH` [W 177100-177114].
  - Drop `--x-provision` and `--x-auto-create`; they do nothing here [W 361358-361371, 170327].
  - Add `--env <name>` wherever production uses an env [CW].
- Removed from the current flow:
  - the preview Worker
  - the first build of the production commit
  - the `configure_previews` step and its intent (deployments.ts:703-718; recovery.ts `intent_configure_previews`)
  - The preview trigger is created directly in its final form.
- Adapters:
  - python-packages: `pywrangler preview` is unverified, so refuse previews.
  - Next.js: see 3.4.

3.3 Separate D1, KV and R2 resources for Previews

- Auto-provisioning is not available for Previews [W 170327 call sites; RES; docs silent]. Cloudcel must create staging resources through the resource APIs it already uses for remote provisioning, after resource consent.
- Use one shared set per project (D1, KV, R2), named for example `<worker>-preview-<binding>`.
  - This matches Cloudflare's shared-staging recommendation [RES "D1 migrations"].
  - It keeps Free-plan resource counts low.
  - It matches today's behaviour, where all branches share one separate set.
  - Per-branch isolation requires per-branch config edits [RES step 3], so it should not be the default.
- Ways to get the bindings into Previews:
  - A. Customer-committed block (docs-sanctioned, works on documented behaviour alone).
    - Cloudcel inspects the config at the production-branch head and refuses to enable previews until a `previews` block exists.
    - It generates the exact JSONC or TOML snippet with the staging IDs.
    - Cloudcel's GitHub access appears to be read-only (contents reads only: deployments.ts:91, migrations.ts:82). It cannot open the PR itself unless scopes are expanded.
  - B. `"previews": {}` committed, plus Cloudcel PATCHing `previews_base_config.env` on the Worker [W 177061-177072].
    - Keeps IDs out of the repository and lets Cloudcel manage them.
    - Depends on how the server merges Base config (gap 1), so it must be verified live first.
    - Cannot carry containers [W 343029-343050].
  - C. Rewriting the config inside the Builds step: not recommended. It is fragile across TOML, JSONC and redirected configs, and hides configuration that [CFG] treats as the source of truth.
- In every case, the `previews` block must exist on each branch. Branches cut before the block was committed fail until they are rebased [CFG].
- Vite-plugin frameworks (Astro, SvelteKit, React Router):
  - @cloudflare/vite-plugin 1.63.0 validates `previews` [VP 42679] and writes its output config by spreading the resolved config [VP 58789-58796], so the block is probably passed through.
  - A fixture test is needed. Older plugin versions in customer repositories may drop it.
- D1 migrations for the preview database: reuse Manage → Database with the `preview` environment (HANDOFF.md:83, 105), pointed at the staging `database_id`. Migrations must be applied before Previews depend on them [RES]; Builds will not run them.

3.4 Next.js and containers

- Next.js: Previews do not fix the problem. `WORKER_SELF_REFERENCE` is a service binding, and service bindings from a Preview reach production [RES; CFG]. The documented workaround is `ctx.exports` [RES], which OpenNext would have to adopt; that is unverified.
  - Keep the refusal, rewording the reason.
  - A degraded mode that omits the binding needs a live test of what breaks.
- Containers and DO Workers: possible in principle [RES; W 177584-177595, 177718-177726].
  - Requirements:
    - `previews.containers` in the committed file (the Base config cannot supply it)
    - `previews.durable_objects.bindings` when code reads from `env`
    - Docker in the Builds environment
    - container-app cleanup on delete
  - Container support is described as "partial" [RES].
  - Containers need Workers Paid. This is outside the sources; verify it.
  - Keep both refusals until verified live. DO-only Workers (no containers) are the easier first case to unblock.

3.5 Listing, URLs and deletion

- List: `GET /accounts/{a}/workers/workers/{worker}/previews?per_page=100&order_by=deployed_on&order=desc`. Show `name`, `slug`, `urls[]` and `deployed_on`. [OAS]
- Deployments: `GET .../previews/{id}/deployments` returns immutable `urls[]`, `number`, `created_on` and `annotations`.
  - Map a deployment to a commit through `workers/tag`. That is the short SHA only if Builds sets `CI=true` [W 177115-177117]. Builds may not set the `commit_sha` source variables [W 177134-177136].
- Delete one Preview: `DELETE .../previews/{preview_id}` behind the existing `{confirm:true}` owner pattern (previews.ts:309).
  - For containers, also delete the leftover app by the exact `${worker}_${slug}_` prefix [RES].
- Disable previews: delete the preview trigger, then optionally delete all Previews after explicit confirmation.
- Never compute URLs. Remove `previewAlias`. When `urls` is empty, show the CLI's remedy (enable `previews_enabled`) [W 177749-177832].
- Enable workers.dev Preview URLs: `POST /workers/scripts/{worker}/subdomain {"enabled":true,"previews_enabled":true}`, the same endpoint as backend.ts:459, with header `Cloudflare-Workers-Script-Api-Date: 2025-08-01` [W 160733-160741]. A later production `wrangler deploy` without `preview_urls` lets the server re-decide [W 160762-160773].
- Cleanup of closed PRs (not automatic [BB; EX]):
  - Option: an opt-in scheduled sweep that deletes Previews whose branch no longer exists. A read-only GitHub check is enough.
  - The Free limit evicts least-recently-deployed Previews at 100 [P] as a backstop.
  - Investigate the hidden `auto_delete` field [OAS] before building this.

3.6 Protecting Previews on the Free plan

- Default: workers.dev Preview URLs only. They are public but carry automatic `noindex` [P; CD].
- Do not default to custom-domain Previews:
  - `noindex` is not added automatically there.
  - Wildcard certificates for deeper hostnames may need paid Advanced Certificate Manager [CD].
- Access can protect one Worker's Previews or Previews only [P; CD; AX]. Not in the sources:
  - the Zero Trust Free seat limit (commonly cited as 50 users) and whether onboarding needs a payment method
  - the API to enable Access on a Worker
    Offer "Protect previews" as an opt-in once these are verified.

3.7 Free-plan cost summary

- Previews: 100 per Worker, 100 deployments each, with automatic LRU eviction [P].
- Request and DO usage pricing for Previews is not stated. Assume it counts toward account allowances.
- Each push to a non-production branch is one build. Workers Free runs one build at a time (HANDOFF.md:40). Use path filters.
- One shared staging D1, KV and R2 per project.
- Containers: paid, outside the sources.

====================================================================== 4. RISKS AND UNKNOWNS NEEDING LIVE VERIFICATION
======================================================================

These need a throwaway account. The user runs the checks, and credentials stay in local or provider secret storage.

1. Builds model for API-created Workers.
   - Does a Worker created through the API, with a repo connection and an API preview trigger running `npx wrangler@4.148.0 preview --worker-name X`, use the Previews model without the dashboard switch [BB L43-52]?
   - Does the PR comment include the Preview URL for this custom command? Builds probably reads Wrangler's output-file record [W 343958-343969], but that is inference.
2. Is `WRANGLER_CI_OVERRIDE_NAME` set in Builds, and to what value? It overrides `--worker-name` [W 177260-177271].
3. How the server merges the Base config with the file's `previews` block, for new and for existing Previews (option B) (gap 1).
4. Server behaviour for branch names outside the [OAS] pattern, and for `<slug>-<worker>` labels over 63 characters. Cloudcel's Worker names can reach 63 characters (repository-plan.ts:712).
5. The `previews_enabled` default after `wrangler deploy` without `preview_urls`.
6. Whether the Builds build token has permission on the Previews endpoints. Token groups for create and deploy are not stated in [OAS].
7. Server handling of a `previews` binding with no ID [W 177335-177338].
8. Deletion propagation delay [ISS].
9. Beta API changes; whether Previews count toward Worker limits or billing (gap 14).
10. Container Previews:
    - Is Docker available in Builds?
    - Do images build and roll out?
    - Are container apps left behind?
    - Is a paid plan needed?
11. Next.js `WORKER_SELF_REFERENCE` behaviour in a Preview.
12. Does `pywrangler preview` pass through to Wrangler?
13. Does @cloudflare/vite-plugin pass `previews` through, across versions customers pin?
14. Forked PRs: does Builds build them? Today's previews are for trusted branches only (HANDOFF.md:227).
15. Secrets: Base secrets reach new Previews only [CFG]. Updating existing Previews needs `PATCH .../deployments/latest`.
16. The hidden Builds `auto_delete` and `migrate_to_previews` endpoints [OAS].
17. Whether the current alias design still produces aliases (gap 10). This decides whether the existing feature is already broken for new Workers.

====================================================================== 5. RECOMMENDED IMPLEMENTATION PLAN
======================================================================

Steps 1-9 can be fixture-tested locally; step 10 is live only.

0. Live verification spike (gate), done by the user. Record the results in HANDOFF.md as live evidence.
   - Workers to use: one plain Worker, one with D1, KV and R2, and one DO-only Worker.
   - Check items 1-8 and 17 from section 4.

1. worker/repository-plan.ts (pure functions)
   - `previewCommand(adapter, worker)` returns `npx wrangler@4.148.0 preview --worker-name <worker>`, keeping the name check.
   - `previewsConfigStatus(config)` reports:
     - whether the block is missing, empty, or contains `<REPLACE_ME>`
     - production bindings with no Preview counterpart
     - limitations, mirroring [W 343029-343300, 343304ff]: services, workflows, queue consumers, crons
     - DO and container requirements
   - `previewsSnippet(config, stagingIds)` produces JSONC or TOML.
   - Update `previewRefusal`:
     - Next.js: still refused, with a corrected reason.
     - Containers and python-packages: refused until verified.
     - New: a missing `previews` block.
   - Fixture tests cover JSONC, TOML, an empty block, `<REPLACE_ME>`, DO `env` bindings, containers, and a named env.

2. Staging resources
   - Create D1, KV and R2 through the API after consent; record them (for example a migration 0016 with environment `preview`).
   - Tests use mocked Cloudflare responses, including the idempotent reuse path.

3. (Only if step 0 confirms the Base-config merge.) PATCH `previews_base_config.env` with merge-patch. Tests check the request body shape.

4. worker/deployments.ts and worker/recovery.ts
   - Previews no longer create a Worker; the preview trigger goes on the production Worker as in 3.2.
   - Enable `previews_enabled` through the subdomain POST.
   - Remove `configure_previews` and the first-build trick.
   - Recovery adopts the single `Cloudcel previews <worker>` trigger.
   - Update tests/deployments.test.ts:1576, which currently asserts `versions upload`.

5. worker/previews.ts
   - GET lists Previews and their deployments from the REST API, using `urls` from the API and handling an empty list and error 10025.
   - `DELETE /projects/:id/previews/:previewId` with `{confirm:true}`.
   - Disabling deletes the trigger.
   - Remove `previewAlias`.
   - Tests use mocked responses shaped like [OAS].

6. Optional cleanup sweep (owner opt-in)
   - Delete Previews whose branch is gone, plus container apps by exact prefix.
   - Tests use a fixture GitHub and Cloudflare.

7. Manage → Database preview environment pointed at the staging database. Show "apply migrations before relying on Previews."

8. UI (Deployments → Branch previews)
   - A requirements checklist: `previews` block, staging resources, Preview URLs enabled.
   - Per Preview: Preview URL, latest Deployment URL, PR link, delete.
   - An Access note.
   - Playwright fixtures.

9. Optional, offline: point `CLOUDFLARE_API_BASE_URL` [W 19795-19799] at a local mock server and run the pinned Wrangler 4.148.0 `wrangler preview`.
   - This captures the exact create and deploy requests and the missing-block failure under `CI=true`.
   - Treat the result as fixture evidence only.

10. Docs, HANDOFF.md (lines 68, 82-84, 196, 227) and docs/qa-report.md:25.
    - Leave old preview jobs marked `disabled`. The platform has not been deployed live (HANDOFF.md:7), so no live migration is needed.
    - Re-run the live checklist after deployment before claiming support.

Relevant files:

- worker/repository-plan.ts (lines 716-758)
- worker/deployments.ts (lines 665-672, 703-718)
- worker/previews.ts (lines 67, 133, 170, 309)
- worker/recovery.ts
- worker/operations.ts (line 350)
- worker/backend.ts (lines 457-461)
- tests/deployments.test.ts (line 1576)
- HANDOFF.md
- node_modules/wrangler/wrangler-dist/cli.js
- node_modules/@cloudflare/vite-plugin/dist/index.mjs
