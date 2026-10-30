# Sign-in and realtime

Shipcel can run a sign-in and realtime service for your app, in your own Cloudflare account: a Worker, a D1 database for its users and a Durable Object class for channels. Your app talks to it with standard OpenID Connect, so any library works, and nothing about your users passes through Shipcel.

## Turning it on

Open the project's **Manage → Sign-in & realtime** tab and turn it on. Shipcel shows what it will create first, creates it after you consent, and gives you the service's address and your app's client ID. The two secrets it needs (a signing key and a realtime secret) go straight to the Worker; Shipcel never stores them. Turning it off removes the Worker and its database.

## How people sign in

The hosted sign-in page offers whatever you have set up:

- **Passkeys**, always: a fingerprint, face or screen lock, with no password to remember or leak.
- **GitHub and Google**, once you add each provider's client ID and secret on the tab. The secret becomes a Worker secret.
- **Email**, once you set a sender address. The person types their address and gets a one-time link that works for 15 minutes, in the browser that asked for it. An address reached this way counts as verified, so it joins the account GitHub or Google verified with the same address.
- **Passwords**, if you allow them. Once signed in, a person sets one at the service's `/password/set` page (link to it from your app's settings), then signs in with it or still asks for a link by email. Passwords are hashed with PBKDF2 at 600,000 rounds.

## Email sign-in needs Cloudflare's Email Service

Links are sent through Cloudflare's Email Service from your own address, with no third-party provider:

1. In the Cloudflare dashboard, go to **Compute → Email Service → Email Sending → Onboard Domain** and choose the domain. Cloudflare adds the DNS records (SPF, DKIM, DMARC and bounce handling); the domain must use Cloudflare DNS.
2. On the Sign-in & realtime tab, set the sender address, such as `sign-in@your-domain.com`, and save.

Email Sending is a Workers Paid feature: 3,000 emails a month are included, then Cloudflare charges $0.35 per 1,000. Without an onboarded domain, the service answers "Sign-in by email isn't set up for this app" and the other methods keep working.

## Your app's side

Use any OpenID Connect library with the service's address as the issuer, the client ID from the tab, PKCE, and a return address you listed under **Return addresses after sign-in**. The ID token carries the person's `sub`, `email` and `email_verified`; the access token works at `/userinfo`. Sign-out goes through `/logout`.

## Realtime

Channels live in a Durable Object class in your account: signed-in people join a channel, see who is present and broadcast messages to it. Turn realtime off on the tab when your app doesn't use it.

## Data API and row-level security

The service can read and change rows of your app's own D1 database for your pages, so a page can list a signed-in person's notes without an endpoint of yours. Under **Data API** on the tab, pick the database (one your app's Worker binds) and open the tables you want reachable, each with who may read it and who may change it:

- **Everyone**, **Signed-in users**, or **No one**;
- **Each user, their own rows:** only rows whose owner column (say `user_id`) holds the person's id, the `sub` in their tokens. That's row-level security: one person never reads or changes another's rows.

No more people may change a table than read it, since a change answers with the rows it reached; a table no one reads only takes new rows. A table not opened, and Cloudflare's and SQLite's own tables, can't be reached. Saving deploys the service again with the database bound, and changing the tables after that only changes a setting. Your pages call `<issuer>/data/<table>` from a return address's origin, with the person's access token:

```js
const headers = { Authorization: `Bearer ${accessToken}` };
// Read: filters as column=operator.value (eq, neq, gt, gte, lt, lte, like, is.null).
await fetch(`${issuer}/data/notes?done=eq.0&order=id.desc&limit=20`, {
  headers,
});
// Add rows (an object or up to 100); the owner column is filled in with the person's id.
await fetch(`${issuer}/data/notes`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ body: 'Buy milk' }),
});
// Change or delete the rows a filter names, among those the person may change.
await fetch(`${issuer}/data/notes?id=eq.5`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({ done: true }),
});
await fetch(`${issuer}/data/notes?id=eq.5`, { method: 'DELETE', headers });
```

Each answer is `{ "rows": [...] }`, with the rows read, added, changed or deleted; `select=a,b` picks columns, and `offset` pages on from `limit` (at most 200). A change that breaks a rule of the table, such as a duplicate key, is refused with D1's reason.

Every change goes out on realtime as a `data:insert`, `data:update` or `data:delete` message with `{ table, rows }`, to those who may read the rows: `public:data:<table>` for a table everyone reads, `signed-in:data:<table>` for one signed-in users read (join it with an access token), and the owner's own `user:<id>` channel for rows only their owner reads. A change of more than 32 KB sends the count instead of the rows, for pages to read again.

## People

The tab lists everyone who signed in, with their methods, and lets you disable or delete an account; both end that person's sessions at once.
