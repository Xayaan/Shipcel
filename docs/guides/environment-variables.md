# Environment variables

Your app gets configuration two ways: **secrets**, which the running app reads, and **build variables**, which a GitHub project's build reads. Values go straight to Cloudflare; Shipcel never stores them.

## Secrets (the running app)

Secrets are your Worker's secrets. Your code reads them from `env`:

```js
export default {
  async fetch(request, env) {
    return new Response(`Key starts with ${env.API_KEY.slice(0, 4)}`);
  },
};
```

Set them in **Manage → Secrets & variables**, or from the CLI:

```sh
shipcel env add API_KEY                          # asks without showing what you type
printf %s "$API_KEY" | shipcel env add API_KEY   # in scripts
shipcel env ls
shipcel env rm API_KEY
```

- Setting or removing a secret deploys it with the current code straight away, like `wrangler secret put`.
- Cloudflare never returns a secret's value, so you can replace one but not read it back. There's no `env pull`: keep values for local development in `.dev.vars`, which Wrangler reads and which shouldn't be committed.
- Secrets stay when you deploy new code, from GitHub or by upload.
- Names use letters, digits and underscores, and don't start with a digit.

## Build variables (GitHub projects)

Build variables are environment variables for Cloudflare's build of a GitHub project, such as a public API address your framework inlines at build time. They apply from the next build.

- **Manage → Secrets & variables → Build variables**: choose production builds, or branch previews' builds when previews are on.
- Mark a value **secret** to hide it: Cloudflare stores it but never shows it again.
- CLI: `shipcel env add NAME --build`, with `--preview` for previews' builds and `--plain` for a value that may be shown.

Apps deployed by upload have no build on Cloudflare's side, so they have no build variables.

## Shared variables (several projects)

A secret that several projects use, such as an API key, can be set on all of them at once: **Shared variables** in the dashboard's menu. Give the name, the value and the projects, and confirm; each project's Worker gets the value as a runtime secret, in place of a secret of that name if it had one, and each change is in that project's history.

- Shipcel keeps the name and which projects have it, never the value, so changing the projects or the value asks for the value again. A project you leave out loses the secret.
- A project that couldn't take a new value (not deployed yet, paused by the budget guard, or Cloudflare refused) keeps its old one and is shown as out of date until you set the value again.
- One change reaches up to 20 projects. **Remove** takes the secret off every project that has it.
- In a project's **Secrets & variables**, a shared secret says so: changing it there lasts until the next shared change.

## Plain variables in your configuration

Values that aren't secret can live in the repository's Wrangler configuration under `vars`; they deploy with the code and appear in the dashboard's view of the Worker:

```json
{
  "vars": { "MODE": "production" }
}
```

## Local development

Wrangler reads `.dev.vars` (and `.env`) in the project folder for `wrangler dev`. Keep both out of Git: the starter kits' `.gitignore` already does.
