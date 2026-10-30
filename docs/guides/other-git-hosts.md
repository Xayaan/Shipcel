# Deploy from GitLab, Bitbucket or Gitea

A repository on GitLab, Bitbucket, Gitea or Forgejo deploys the way a GitHub repository does: every push builds in that host's own CI, which runs `shipcel deploy`. The production branch goes to production, and other branches get a preview. Shipcel never reads the repository; your CI builds it and uploads the result.

## Connect a repository

In the repository's folder:

```sh
shipcel git connect
```

The CLI reads the folder's Git remote, links the repository to a project (creating one named after the folder if it's new), and writes the CI file for that host:

| Host                           | File                           | Sign-in                                         |
| ------------------------------ | ------------------------------ | ----------------------------------------------- |
| GitLab.com                     | `.gitlab-ci.yml`               | GitLab's own ID token: no secret                |
| GitLab on a server of your own | `.gitlab-ci.yml`               | A deploy token, as the variable `SHIPCEL_TOKEN` |
| Bitbucket                      | `bitbucket-pipelines.yml`      | A deploy token, as the variable `SHIPCEL_TOKEN` |
| Gitea, Forgejo, Codeberg       | `.gitea/workflows/shipcel.yml` | A deploy token, as the secret `SHIPCEL_TOKEN`   |

Commit the file and push. A CI file the repository already has is left alone, and the CLI shows the job to add to it instead. The production branch is the remote's default branch as your last fetch recorded it; `--branch <name>` names another. For a host the CLI can't tell from its name, `--provider gitlab` or `--provider gitea` says which it is. From outside the folder, `--repo gitlab.com/group/project` names the repository.

The project's **Deployments** tab shows the linked repository, and **Disconnect repository** stops its jobs from deploying. Delete the CI file in the repository too.

## GitLab.com: no secret

The job asks GitLab for an ID token made for Shipcel's address (`id_tokens` in `.gitlab-ci.yml`), and Shipcel exchanges it for a token that deploys the linked project for an hour. The first job pins the GitLab project behind the path: if the path later names another project (renamed, transferred, or taken), its jobs deploy nothing until you link it again. The job also names its Shipcel project (`--project` in the file), so a link someone else makes to the same path gets nothing from your pipelines.

The production branch deploys to production only while it is **protected** in GitLab (Settings → Repository → Protected branches); otherwise anyone who can push to it could replace production, so its jobs deploy previews. GitLab protects the default branch of a new project.

## Deploy tokens

Bitbucket Pipelines, Gitea and Forgejo Actions, and GitLab on a server of your own sign in with a deploy token: a token that deploys one project and does nothing else in your workspace.

```sh
shipcel tokens add "Bitbucket: ada/shop" --project shop
```

It opens the same approval page as `shipcel login`; after you approve, the terminal shows the token once. Keep it as a secured repository variable on Bitbucket, a masked and protected CI/CD variable on GitLab, or a repository secret on Gitea and Forgejo, named `SHIPCEL_TOKEN`. It lasts 90 days unless you say otherwise (`--expires 365`), and `shipcel tokens rm` revokes it.

Anyone who can run your pipeline with that secret can deploy the project, so keep it to branches you trust: GitLab's protected variables, and Bitbucket's deployment variables, do that.

## What doesn't deploy this way

Containers: their images are made by Cloudflare's builds, which Shipcel connects from GitHub only for now. Branch previews of Next.js apps aren't offered from any host yet.
