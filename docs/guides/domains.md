# Domains

Every app has a free address on Cloudflare's `workers.dev`, and you can add your own domain with a certificate in a few minutes.

## The free address

An app's free address is `https://<app>.<subdomain>.workers.dev`, where the subdomain belongs to your Cloudflare account. If the account has none yet, the first deploy asks you to claim one on the Deployments tab; Cloudflare registers it for the whole account, so every app's address uses it. Changing it later (in Cloudflare) moves every app's address, so Shipcel never changes an existing one.

You choose the app's name on its first deploy. Next.js and container apps keep the name in their Wrangler configuration.

Cloudflare treats `workers.dev` addresses as free sites for personal and hobby projects; use your own domain for business-critical apps.

## Add your own domain

Your domain must be a zone in the same Cloudflare account, active and using Cloudflare's nameservers. Then:

- **Dashboard:** Manage → Domains → choose the zone, type the hostname (the zone itself, like `example.com`, or a subdomain, like `app.example.com`) and add it.
- **CLI:** `shipcel domains add app.example.com`. Shipcel picks the most specific zone that covers the hostname.

Cloudflare creates the DNS record and issues the certificate; it usually takes a few minutes. Shipcel refuses a hostname that's already attached to a Worker or that already has DNS records, so it never takes over something you set up yourself.

```sh
shipcel domains ls
shipcel domains rm app.example.com
```

Removing a domain detaches it from the app; the zone stays in your account.

## Preview addresses

Preview addresses are on `workers.dev`. To limit who can open them, see [Previews and rollbacks](previews-and-rollbacks.md#who-can-open-previews).

## Turning the free address off

For an app deployed by upload, **Unpublish** (or `shipcel unpublish`) turns its `workers.dev` address off while preview addresses keep working. Custom domains are separate and stay attached.
