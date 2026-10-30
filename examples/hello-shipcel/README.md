# hello-shipcel

A small JavaScript app for trying the `shipcel` CLI: an HTML page, a script and a stylesheet served by Workers Static Assets, and an API at `/api/hello` answered by `public/_worker.js`. There is no build step; `public/` is what gets deployed.

```sh
shipcel login                                 # once: GitHub, then Cloudflare
shipcel deploy public --name hello-shipcel   # a preview, in a new project
shipcel deploy public --prod                  # production
shipcel env add GREETING                      # a secret the API reads
shipcel ls                                    # versions and their addresses
shipcel logs --since 30m                      # requests and errors
```

The first deploy asks to create a project (or pass `--yes`) and links this folder to it in `.shipcel/project.json`. See [the CLI guide](../../docs/cli.md) for every command.
