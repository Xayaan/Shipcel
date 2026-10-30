# Cloudcel execution blueprint

Updated 8 October 2026. Working name: Cloudcel. Status: local planner complete; identity and provider/deployment implementation added with fixture verification. Live provider activation and broader platform milestones remain open.

## Product commitment

**Deploy and manage everything Cloudflare can genuinely support, inside the customer's own account.** Websites, JavaScript APIs, full-stack SaaS, Next.js, Python, containerized services, and WordPress are all in the product scope. Build and verify adapters in stages; do not narrow the product permanently to one developer framework.

Cloudcel sells the management and deployment experience. Customers own their infrastructure and pay Cloudflare directly. Customer-owned external services may still be required: ordinary WordPress needs MySQL, for example. Owning a Cloudflare account does not eliminate Cloudflare dependency or make applications portable to every cloud.

“Supported” is a tested capability, not a dropdown entry. Distinguish **planned**, **architecture research**, **local kit verified**, and **live deployment verified**. No claim of universal Node.js compatibility, persistent container disks, or D1 being a MySQL/PostgreSQL replacement.

## What is implemented now

- Responsive workspace with overview, projects, app catalog, activity, connections, and setup guide.
- Eleven application choices. All can be saved as plans; five have exportable kits.
- React/Vite + Hono, Vue/Vite + Hono, Hono APIs, JavaScript Workers, and static websites.
- D1/R2 binding selection for compatible templates, configuration preview, and portable ZIP exports.
- Real local D1 persistence. No invented accounts, metrics, deployments, or repository imports.
- GitHub App sign-in and repository inspection; workspace isolation, expiring sessions, same-origin checks, request limits, and parameterized SQL.
- Encrypted Cloudflare OAuth grants, account selection, serialized refresh, local disconnect, native Builds setup jobs, and server-enforced Free plan limits.
- Tests of complete browser journeys and independent installation/build of generated starters.

This is an **integration alpha**, not a launched hosting service. Unconfigured public hosting is rejected. Offline mode remains available; hosted mode requires GitHub authentication and an exact configured origin. Cloud operations are implemented behind an activation switch and have only fixture evidence. No live provider consent or cloud resource creation has been performed. See `docs/provider-setup.md`.

## Commercial validation alongside the build

Interview five prospective customers across solo SaaS developers, small teams, and WordPress agencies. Ask them to demonstrate their latest deployment and recurring operations. Measure time and mistakes rather than asking whether they like the idea.

Recruit a guided pilot with one real app per customer after the live deployment gates below. Initial success: three customers ship, two return for another deployment, and two explicitly agree to pay. Test $9/month solo and $29/month agency as hypotheses, with project/build limits. Infrastructure and external database charges are separate. Do not promise universally lower prices or unlimited builds.

Track first successful deploy time, failed attempts, repeated use, customer support time, cost per successful deploy including failed builds, and successful disconnect. Prepare demos and outreach drafts; sending messages requires authorization.

## Architecture

React/TypeScript dashboard → Hono API on Workers → D1 control-plane metadata. A registry maps an application to a versioned adapter, runtime, services, restrictions, and validation evidence. See `docs/runtime-matrix.md` and `shared/catalog.ts`.

After identity: server-side encrypted Cloudflare OAuth grants, GitHub App selected-repository access, durable deployment jobs, and isolated build runners. Never run untrusted repository code in the control-plane Worker or in a privileged shared process.

Every account grant, resource, job, artifact, secret, and event belongs to a workspace. Authorization must be checked when a job is submitted **and when it executes**. Disconnect and membership revocation stop queued work. No implicit deletion of customer infrastructure on disconnect, subscription cancellation, or project removal.

Code rollback and database rollback are separate operations. Retry resource creation idempotently; record returned IDs before advancing. Failed steps produce an inventory of created resources, not destructive automatic compensation.

## Delivery graph and rules

`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8`

`5 → 9 → 10 → 11`

`8 + 9 + 10 + 11 → 12`

After the identity and provider contracts stabilize, independent adapters and GitHub intake can be developed in parallel. Resource mutations remain serialized per environment. Each numbered item is a reviewable unit; adapter additions in step 9 are separate changes. If any item grows beyond one review, split it and record the dependency change below. No remote repository exists yet; work locally until a destination is chosen. Default model tier unless marked strongest.

### 1. Local project planner and starter export — complete (local alpha)

Context: begin with no code or provider credentials. Prove the project-planning flow with useful, independent exports.

Tasks: catalog; project CRUD; D1 persistence; optional binding declarations; configuration viewer; generated source and instructions; reject unsupported export paths; explicit “not deployed” and “not connected” states. GitHub URLs remain reference metadata.

Verify: `npm run check`, `npm test`, `npm run build`, `npm run test:browser`, `node scripts/verify-kits.mjs`. Start with `npm run db:migrate` and `npm run dev`. Check desktop/tablet/mobile, persistence, invalid inputs, duplicate names, ZIP content, removal, and local API restrictions. Verify each exported app independently.

Exit: working saved plans and locally build-verified kits. No real deployment claim. Rollback: stop the local process; no external resources exist.

### 2. Sign-in, workspaces, and authorization — implemented; live consent pending / strongest

Context: step 1 is intentionally unauthenticated and local-only. Public access is blocked until all identity controls exist.

Tasks: select identity provider; workspace membership schema; secure HttpOnly sessions; exact allowed origins; CSRF; session expiry/logout; resource ownership; authorization helper reused on every API and artifact path; request and mutation rate limits. Replace the local-only guard only after tests pass.

Verify: negative tests for missing/expired sessions, CSRF, cross-workspace object IDs, membership revocation, and role escalation; check/test/build. Exit: two test users cannot read or mutate each other's data. Rollback: restore loopback-only access and disable sign-in.

### 3. Cloudflare OAuth and selected-account grants — implemented in part; live validation pending / strongest

Context: authenticated workspaces exist. Register a real public client with verified product domain and exact callbacks before a live consent test.

Tasks: documented scope names; PKCE S256; single-use session-bound state; callback validation; encrypted token storage and key rotation; serialized refresh; account-selection authorization; revocation; disconnect; audit trail. Grants reference a workspace and selected account, never a browser-provided account ID alone.

Verify: rejected/replayed state, invalid callbacks, refresh races, expired/revoked grants, cross-workspace account selection, and successful connect/disconnect in a dedicated test account. Exit: no long-lived provider credentials in the browser or logs; disconnect preserves resources and blocks queued operations. Rollback: disable connection routes and revoke test grants.

### 4. Provisioning plans and durable job state — job engine, reviewed draft D1/R2/KV plans, and initial-job recovery implemented; live verification pending / strongest

Context: an authorized workspace can access a chosen Cloudflare account. Start with a known Hono template.

Tasks: resource/cost review before provisioning; desired/observed state; workspace/account IDs on every job and provider request; idempotency keys; job leases; retry/backoff bounds; distinguish created from adopted resources; persist IDs immediately; prevent conflicting deployments; check grant and membership again at execution time.

Verify: duplicate queue delivery, every partial-failure boundary, throttling, timeouts, revoked membership/grant after enqueue, and recovery without duplicate resources. Exit: resumable D1/R2/Worker provisioning with precise status. Rollback: pause queue and expose created-resource inventory; do not delete customer data.

### 5. Worker deployment, promotion, and health check — native adapter, version promotion, and follow-up health checks implemented; live verification pending / strongest

Context: resource jobs are reliable. Upload trusted template artifacts first; no arbitrary builds yet.

Tasks: immutable version upload; resolved bindings; additive migration tracking; version promotion; real HTTP health check; URL verification; redacted logs; previous-version rollback. Record workspace ownership on artifacts and versions.

Verify: a real app in a test customer account, binding access, failed promotion, timeout reconciliation, migration failure, health failure, and code rollback. Exit: a verified deployed URL survives Cloudcel disconnect. Rollback: restore previous Worker version; database recovery remains explicit.

### 6. GitHub App repository intake — selected-repo import implemented; native push handling chosen / strongest

Context: identity and deploy contracts exist. GitHub access is per installation and selected repository.

Tasks: owned GitHub App; minimum permissions; installation/workspace binding; webhook HMAC; replay protection; commit pinning; installation removal; repository access revocation; queue intake without executing code.

Verify: wrong signatures, replay, forged installation/repository IDs, removal and revocation during a queue delay, out-of-order commits, and unauthorized artifact reads. Exit: authorized immutable commit jobs enter the queue exactly once. Rollback: stop webhook intake; current production apps stay running.

### 7. Isolated builds and artifact delivery — native Builds adapter implemented; provider compatibility gate open / strongest

Context: trusted template deployments work, and authorized repository jobs exist. Evaluate the documented third-party integration surface of Workers Builds before choosing it; otherwise use a dedicated build provider.

Tasks: CPU/time/disk/network budgets; short-lived isolated runners; no provider credentials exposed to build scripts; separate trusted deploy stage; fork PR secret isolation; artifact hashes; bounded retention; redacted logs; latest-commit ordering; concurrency and retry quotas.

Initial proposed ceilings to validate: 10-minute builds, one active build per project, two transient retries, seven-day build-artifact retention, and seven-day preview TTL. These are proposed product limits, not Cloudflare guarantees.

Verify: malicious scripts, resource exhaustion, token extraction attempts, failure leaves production untouched, duplicate/out-of-order jobs, quota breaches, and cost per successful build. Exit: a selected repository reliably deploys with actionable errors. Rollback: disable builds, retain last healthy deployment.

### 8. Environments, domains, and repeat-use operations — operations, branch previews, and D1 backup/restore implemented with fixtures; live verification pending

Context: repository-to-deployment works. Deliver the daily workflow before paid beta.

Tasks: isolated preview resources; secret configuration with no value echo; verified domain ownership; deployment history; code rollback; cleanup rules that exclude production; resource export and disconnect; D1 backup/restore runbook. Split each independent feature into its own change when executing.

Verify: negative authorization tests, preview/production isolation, domain conflicts, cleanup races, secret redaction, rollback, and restore to a new database. Exit: operators can diagnose, redeploy, and recover an application. Rollback: feature flags stop new mutations without removing live workloads.

### 9. Framework and Python adapters — Astro, SvelteKit, Next.js (OpenNext), and Python (including FastAPI through pywrangler) import adapters fixture-verified; live verification pending

Context: the generic deployment contract is stable. Broad framework coverage is part of the product commitment.

Separate changes: Next.js/vinext (current Cloudflare recommendation, beta compatibility caveats), optional OpenNext migration path, Astro, SvelteKit, and Python Workers/FastAPI. Record adapter and package versions, expected feature coverage, unsupported APIs/packages, build output, and evidence. Add other Cloudflare-supported frameworks through the same registry contract.

Verify: each adapter's scaffold/build/local run, SSR/streaming where supported, environment bindings, assets/routing, errors, and a real deployment. Test native Python dependency limitations explicitly. Exit: each independently passes “local kit verified” then “live deployment verified.” Rollback: disable new deployments for that adapter; leave already deployed versions running.

### 10. Generic Containers adapter — Container Worker import adapter fixture-verified (local Docker image builds); live verification pending

Context: Worker orchestration exists. Containers add a different runtime and cost model; a Dockerfile alone is insufficient.

Tasks: image builds and registry ownership, architecture/size constraints, Durable Object routing, health/startup checks, autosleep, maximum instances, secrets delivery, disk/CPU/memory bounds, external persistent data bindings, rolling changes and image retention. Document ephemeral disk and snapshot semantics. Add Node/PHP/Go/Ruby examples after verification.

Verify: restart, instance replacement, cold starts, failed image pull, state loss expectations, concurrency/routing, network restrictions, quotas, and costs. Exit: a real stateless container app works with explicitly durable external data. Rollback: pin previous image and preserve external stores.

### 11. WordPress architecture and verified hosting — pending / strongest

Context: generic container lifecycle works. WordPress is committed scope, but is not presently verified by this product.

Tasks: choose customer-owned managed MySQL/MariaDB provider and connection path; define durable media persistence; define how installed plugins/themes and updates persist (reproducible images or a verified storage solution); scheduled tasks, email, TLS/domain routing, backups, and updates. Validate editor, common plugins, uploads, and commerce workloads separately. Do not use D1 as a drop-in MySQL replacement. Container snapshots are not a continuous persistence strategy.

Verify: upload media and install/update plugins/themes, restart containers, replace image/instance, and verify data survives; restore database and media into a fresh environment; execute scheduled jobs and mail; verify cache/login/admin behavior. Exit: a real WordPress deployment survives lifecycle changes and a full recovery drill. Rollback: previous tested image plus a documented database/media restoration point.

### 12. Billing, pilot, and release gates — pending / strongest for security review

Context: core operations and the runtime adapters have individual evidence. Release supported runtimes independently rather than withholding all progress until every adapter is ready.

Tasks: pricing validation, entitlement limits, signed/idempotent payment webhooks, cancellation preserving workloads, team roles, incident runbooks, tenant isolation review, load/cost budgets, accessibility review, customer docs, and guided pilot onboarding. Preserve export/disconnect when paid access ends.

Verify: check/test/build/CI; every launched runtime deploy/rollback/disconnect; billing replay and cancellation; provider outage and revoked credentials; backup restoration; first-deploy time and willingness to pay. Exit: a private beta with real successful deployments and bounded cost. Rollback: close new signups and disable new jobs, preserve customer access and running apps.

## Owner-dependent setup

Needed for live integration, after local work is reviewable:

1. Product domain and dedicated test Cloudflare account, with an agreed resource budget.
2. Cloudflare OAuth client registration, domain verification, callback URLs, scopes, and secure server-side credentials.
3. Identity provider and GitHub App registration under the intended product owner.
4. Build provider and spending/concurrency limits.
5. WordPress database and persistence approach, including who bills for external services.

Do not ask customers to paste a global API key. Do not ask the founder to put secrets into chat. Use local secret configuration or provider dashboards.

## Sources and review log

Official docs checked 7 October 2026:

- OAuth: https://developers.cloudflare.com/fundamentals/oauth/
- Self-managed clients: https://developers.cloudflare.com/changelog/post/2026-06-03-public-oauth-clients/
- OAuth endpoints: https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/
- Wrangler configuration: https://developers.cloudflare.com/workers/wrangler/configuration/
- Framework detection: https://developers.cloudflare.com/workers/framework-guides/automatic-configuration/
- Next.js/vinext: https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/
- OpenNext: https://developers.cloudflare.com/workers/framework-guides/web-apps/opennext/
- Python: https://developers.cloudflare.com/workers/languages/python/
- GitHub CI: https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
- Containers: https://developers.cloudflare.com/containers/concepts/architecture/

Changes:

- 2026-10-07: initial narrow audience assumption replaced after founder clarified full Cloudflare scope.
- 2026-10-07: independent Blueprint review identified scope, WordPress persistence, local API protections, job-level tenant authorization, oversized milestones, and explicit cost/prerequisite gaps. All incorporated above.
- Future changes must record reasons, dependencies, and verification evidence. Never silently replace a live deployment milestone with a simulation.

## Milestone 1 verification evidence

- TypeScript check and production build passed.
- 35 unit/validation/security tests and 3 real-browser journeys passed.
- Nine starter kits (including Astro, SvelteKit, Next.js and Python) independently installed, built with each adapter's build command, and passed Worker dry-run bundling; placeholder D1 IDs blocked deployment.
- Automated axe checks reported no violations on the tested pages at 1440, 768, and 375 pixels. This is not a full accessibility certification.
- npm audit reported zero known vulnerabilities.
- Visual inspection completed; no pre-existing screenshot baseline exists, so regression comparison is inconclusive.
- No cloud resources were provisioned, no repository was imported, and no live deployment was attempted.

See `docs/qa-report.md`, `docs/accessibility-results.json`, and `docs/starter-kit-verification.json`.

## Integration implementation update — 7 October 2026

The founder reaffirmed the Vercel-style, BYO-Cloudflare model and requested a free plan. Implemented Free limits: 3 project plans, 10 new native pipeline setups/calendar month, one active setup. D1 triggers enforce these atomically. They do not cap subsequent Cloudflare builds or spend. No paid subscription flow is exposed.

Native Cloudflare Builds is the first proposed execution adapter: it handles production pushes and keeps deployment credentials in the customer's Cloudflare build system. Cloudcel owns initial orchestration and does not run repository code in its control plane. Current input is a trusted stateless npm repository with root Wrangler JSON/JSONC. Arbitrary projects still need their framework adapter/configuration. No fork PR builds or preview triggers are enabled. This consciously defers a separate isolated artifact-builder design from milestone 7; native build scripts have access to Cloudflare's configured build token, so only trusted repositories are in scope.

Cloudflare documents user-scoped API-token requirements for Builds. Compatibility with the actual third-party OAuth client has not been proven. The native switch remains off until account/Builds access and an initial test deployment pass. This is a release gate, not a claim that the platform is complete. Registering the provider apps and selecting the public product origin are owner-dependent prerequisites.

Authorization, idempotency, partial failures, timeout ambiguity, leases, expiry, and failed health checks are covered by real SQLite/fixture tests. An ambiguous mutation stops for manual reconciliation; transparent retry/reconciliation remains work. Local disconnect erases stored ciphertext and halts queued operations but preserves native triggers and does not yet revoke upstream grants. Native future-build history is available through Manage, with detailed logs in Cloudflare.

Project operations now include binding inventory, runtime secrets, domain attachment/removal, build history/redeploy, and owned-version promotion. They have 18 backend fixture tests and a browser journey covering confirmations and responsive/a11y states. No live operation has been verified. Remaining implementation includes milestones 4/5 resource provisioning and recovery, milestone 8 isolated previews/data recovery, framework/container/WordPress adapters, and the other platform services. These do not become complete merely because provider setup is finished. Current verification is recorded in `docs/qa-report.md`.

## Resource plans and framework imports — 7 October 2026

Draft D1, R2, and KV bindings (binding name only) are now a reviewed part of a native deployment. Inspection lists them with Astro's default session namespace; deployment requires resource consent for the inspected commit; Wrangler creates the resources during the native build; Cloudcel records the observed IDs and withholds the URL when a reviewed binding is missing or an unreviewed resource binding appears. Existing resource IDs and names are still rejected rather than adopted. Starter kits now emit draft bindings so generator, inspection, and deployment agree.

Framework imports use committed configuration rather than build-time automatic setup, because Cloudflare's own dashboard flow also commits configuration (via a pull request) and build-time setup would install unpinned adapters on every push. Astro (`@astrojs/cloudflare` via `wrangler setup`) and SvelteKit (`@sveltejs/adapter-cloudflare`, committed `wrangler.jsonc`) pass fixture builds and exact deploy dry runs. Wrangler 4.148 automatic setup does not support SvelteKit 3. Next.js stayed gated at this point: the installed OpenNext path tries to create an R2 cache during setup and binds `WORKER_SELF_REFERENCE` to the configuration's Worker name rather than Cloudcel's generated name (resolved by the Next.js adapter entry below). Evidence: `docs/framework-verification.json`, `docs/starter-kit-verification.json`, `docs/qa-report.md`.

An exact-command test exposed that the previous deploy command's `--yes` flag is rejected by `wrangler deploy`; it was removed before any live use.

## Initial deployment recovery — 7 October 2026

Interrupted initial deployments can be resumed by a workspace owner with an explicit confirmation (`POST /api/deployments/:id/reconcile`, `worker/recovery.ts`). For an interrupted provider request, Cloudcel reads Cloudflare's state first: it adopts the Worker (only if created after the job started), the single Cloudcel build trigger, or the initial build for the reviewed commit, and otherwise repeats the request; repository connections are upserts and are repeated. Other stopped jobs continue from the same step with a new 45-minute monitoring window (migration 0006), and failed health checks are re-run. Scheduled processing never resumes a job automatically. Recovery of Manage operations and post-operation health tracking remain open.

## Health checks after redeploys and promotions — 7 October 2026

Redeploys and version promotions started from Manage now record a follow-up check (`operation_health`, migration 0007, `worker/health.ts`). A redeploy follows its build: a failed build is reported without probing, a successful one leads to a homepage probe. A promotion first confirms the promoted version is serving (`result.deployments[0]`), then probes. Checks run at most every 20 seconds from the scheduled handler, the Manage view, or "Check health now"; a change is called unhealthy only after three failed probes, tracking stops after 45 minutes or when the Worker, account, or project changes, and nothing is rolled back automatically. The initial deployment shares the same homepage probe. Push-triggered builds are still unchecked.

## Reviewed D1 migrations and the Next.js adapter — 7 October 2026

Manage → Database lists pending D1 migrations for a bound database (repository `migrations_dir` at the production-branch head, ordered and recorded like Wrangler 4.148), shows each file's SQL and SHA-256, and applies them only after review and confirmation. The apply request must match the reviewed commit and file hashes; Cloudcel records a Time Travel restore point (migration 0008) before the first migration, runs files in order, stops at the first failure with D1's error, and journals the result. A confirmed restore returns the database to that point and records Cloudflare's undo bookmark. Nothing is applied automatically; scheduled backups remain open.

Next.js imports use the committed OpenNext configuration from `wrangler setup`. The adapter deploys under the configured Worker name because OpenNext binds `WORKER_SELF_REFERENCE` to it; a generated name would point the binding at a different Worker. Worker names are therefore unique per Cloudflare account (migration 0009) and never adopted. OpenNext cache overrides are refused until Cloudcel can populate caches. vinext was not adopted: it reimplements Next.js and Wrangler 4.148 setup still installs OpenNext.

## Operation recovery, backups, previews, Python, and containers — 8 October 2026

- Interrupted Manage operations can be checked against Cloudflare (read-only, per operation kind) and builds triggered by pushes get the same follow-up health check as redeploys (migrations 0010–0011).
- Backups: Manage → Database exports a database on demand and restores it to a point in time within Time Travel's window, with an undo bookmark. Cloudflare blocks queries during an export, so Cloudcel does not schedule exports itself; starter kits with a database include an optional GitHub Actions export workflow.
- Branch previews: a separate preview Worker and trigger (migration 0012) whose first build creates separate, empty resources and which then uploads a version with an alias URL for every other branch. Disabling deletes only the preview trigger. Refused for Next.js and containers. **Superseded on 8 October 2026** by Cloudflare's Worker Previews on the production Worker (migration 0020; see `docs/runtime-matrix.md`).
- Python Workers: package-free Workers with a compatibility date before 2026-04-21 deploy with Wrangler; packages, or workers-py declared (needed from 2026-04-21, when the `workers` module moved to that package), deploy with pywrangler through `pipx run --spec uv==0.12.23`, with Wrangler pinned by the repository's `package.json`.
- Containers: the Docker / custom runtime imports Container Workers (default scheduling policy, or Cloudflare's beta Durable Object-managed policy). The plan lists each container's images, instance type, and instance limit and requires consent to Workers Paid billing; Dockerfiles must exist at the inspected commit; Durable Objects of other Workers, data transfers between Workers, and SSH/placement/unsafe settings are refused. Deployments keep the configured Worker name because Wrangler names container applications after it, and a first deployment's homepage check waits up to 15 minutes for the container to start (migration 0013). Previews are refused: Cloudflare creates no preview URLs for Workers with Durable Objects.
- Evidence: fixture tests, mutation checks, browser journeys, and dry runs (`docs/qa-report.md`). Nothing in this list has been verified live.

## Free workers.dev addresses — 8 October 2026

Apps are free to reach without buying a domain: every deployment is served at `https://<app name>.<account subdomain>.workers.dev`, Cloudflare's equivalent of a `vercel.app` address. Owners choose the app name (default: the project name; Next.js and containers keep their configured name), and an account without a workers.dev subdomain can claim one from Cloudcel, which never changes an existing subdomain. Workers Builds cannot register a subdomain itself, so deployments wait for one. `github.io` addresses are not possible for Cloudflare-hosted apps: only GitHub Pages can serve them. Fixture-tested; live verification pending.

## Public site and Free plan limits — 8 October 2026

- The Free plan no longer caps below Cloudflare's Workers Free plan: up to 100 projects (Cloudflare allows 100 Workers per account), no monthly cap on new pipelines, one setup at a time (migration 0014; superseding the 3-project and 10-setup limits above).
- A public site at `/` (static HTML from `site/content.ts` and `site/render.ts`): the free-plan offering with Cloudflare's free limits, pricing with worked examples, why Cloudcel, and comparisons with Vercel, Netlify, Supabase, Firebase, Render, Railway and Heroku. Every price links to the provider's official page. The dashboard moved to `/app/`.
- Claims are limited to what the sources support: no blanket "cheaper" multiplier, the R2 and Workers Paid billing caveats, and Cloudflare's terms on collecting card details on Free services are stated.

## Sign-in & realtime for customers' apps — 8 October 2026

- Manage → Sign-in & realtime deploys a second Worker (`services/backend`) into the project's account with its own D1 database and a SQLite Durable Object class (migration 0015 records it). It is a standard OpenID Connect provider (authorization code with PKCE S256, ES256 tokens, rotating refresh tokens) with passkeys, GitHub and Google on a hosted page, plus realtime channels with presence and broadcast on hibernating WebSockets. Keys are generated during setup and stored only as Cloudflare Worker secrets; the app Worker receives its connection secrets automatically. It runs on Cloudflare's free plan; passwords are excluded because safe hashing exceeds the free plan's CPU limit and resets need an email service.
- Owners manage settings, GitHub and Google credentials, users, secret rotation, updates and removal from the dashboard. Setup can be continued after an interruption without duplicates, and nothing Cloudcel did not create is adopted, replaced or removed.
- Cloudcel's provider transport passed `redirect: 'error'`, which the Workers runtime rejects; every provider call would have failed in production. Fixed, with a test that runs the transport in workerd.
- The front page presents Cloudcel as a no-code platform for the customer's own Cloudflare account, from side project to enterprise, and names no other company; comparisons stay on their own pages.
- Evidence: the service runs in workerd (Miniflare) with a software passkey authenticator; control routes use fixtures; nothing here is verified live.
