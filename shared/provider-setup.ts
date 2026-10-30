// What Shipcel asks GitHub and Cloudflare for when it sets up its own sign-in: shared by the
// Connections page (worker/provider-apps.ts) and the production setup
// (scripts/setup-production.mjs).

// GitHub: the manifest of a private GitHub App for the Shipcel at `origin`. GitHub sends the
// person back to `redirect` with a code for the app's credentials. After someone chooses or
// changes the app's repositories, GitHub sends them to the setup URL, which takes them back to
// where they were in Shipcel.
export function githubManifest(origin: string, redirect: string, name: string) {
  return {
    name,
    url: origin,
    redirect_url: redirect,
    callback_urls: [`${origin}/api/auth/github/callback`],
    setup_url: `${origin}/api/auth/github/installed`,
    setup_on_update: true,
    description:
      'Signs you in to your Shipcel and adds its deploy workflow to the repositories you choose.',
    public: false,
    // Write access to Contents and Workflows adds the deploy workflow
    // (.github/workflows/shipcel.yml, worker/github-actions.ts); GitHub Actions does the rest.
    default_permissions: {
      contents: 'write',
      metadata: 'read',
      workflows: 'write',
    },
    request_oauth_on_install: false,
  };
}

// Cloudflare: Shipcel creates a private OAuth client with a temporary API token that has the
// OAuth Client Write permission. Scope names come from Cloudflare's own list, matched by name
// (the token permission names) or ID; only Account Read is required to connect. The IDs listed
// are the ones Cloudflare offered a real account (8 Oct 2026), e.g. `workers-r2.write`.
export const wantedScopes: {
  label: string;
  names: string[];
  required?: boolean;
}[] = [
  {
    label: 'Account Read',
    names: ['Account Read', 'Account Settings Read'],
    required: true,
  },
  // Not "Workers Editor" (workers-scripts.edit): it updates existing Workers but can't
  // create one, which every first deploy does.
  {
    label: 'Workers Scripts Write',
    names: ['Workers Scripts Write', 'workers-scripts.write'],
  },
  {
    label: 'Workers Builds',
    names: [
      'Workers CI Write',
      'Workers CI Edit',
      'Workers Builds Configuration Write',
      'Workers Builds Configuration Edit',
    ],
  },
  { label: 'D1 Write', names: ['D1 Write', 'D1 Edit'] },
  {
    label: 'Workers KV Storage Write',
    names: ['Workers KV Storage Write', 'Workers KV Storage Edit'],
  },
  {
    label: 'Workers R2 Storage Write',
    names: [
      'Workers R2 Storage Write',
      'Workers R2 Storage Edit',
      'workers-r2.write',
    ],
  },
  // Postgres and MySQL through Hyperdrive (worker/hyperdrive.ts): its configurations.
  {
    label: 'Hyperdrive Write',
    names: [
      'Hyperdrive Write',
      'Hyperdrive Edit',
      'Workers Hyperdrive Write',
      'Workers Hyperdrive Edit',
      'hyperdrive.write',
    ],
  },
  { label: 'Account Analytics Read', names: ['Account Analytics Read'] },
  // The account's plan, for the budget guard (worker/budgets.ts); without it, the guard
  // estimates as if the account were on Workers Paid.
  { label: 'Billing Read', names: ['Billing Read', 'billing.read'] },
  {
    label: 'Workers Observability Write',
    names: ['Workers Observability Write', 'Workers Observability Edit'],
  },
  { label: 'Zone Read', names: ['Zone Read'] },
  {
    label: 'Workers Routes Write',
    names: ['Workers Routes Write', 'Workers Routes Edit'],
  },
  { label: 'DNS Write', names: ['DNS Write', 'DNS Edit'] },
  // `shipcel cache purge` (worker/dns.ts); optional, like everything below Workers Scripts.
  {
    label: 'Cache Purge',
    names: ['Cache Purge', 'cache-purge.write', 'Zone Cache Purge'],
  },
  // Manage → Security (worker/firewall.ts): a zone's managed rules, custom rules and rate
  // limits; Bot Fight Mode and AI crawler blocking; Under Attack mode (its security level).
  // Firewall Services was Zone WAF's earlier name.
  {
    label: 'Zone WAF Write',
    names: [
      'Zone WAF Write',
      'Zone WAF Edit',
      'Firewall Services Write',
      'Firewall Services Edit',
    ],
  },
  {
    label: 'Bot Management Write',
    names: ['Bot Management Write', 'Bot Management Edit'],
  },
  {
    label: 'Zone Settings Write',
    names: ['Zone Settings Write', 'Zone Settings Edit'],
  },
  {
    label: 'Access: Apps and Policies Write',
    names: [
      'Access: Apps and Policies Write',
      'Access: Apps and Policies Edit',
      'access.write',
    ],
  },
  {
    label: 'Access: Organizations, Identity Providers, and Groups Write',
    names: [
      'Access: Organizations, Identity Providers, and Groups Write',
      'Access: Organizations, Identity Providers, and Groups Edit',
      'access-acct.write',
    ],
  },
];
export const normalize = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]/g, '');

// The scopes to ask Cloudflare for, from the list it offers: for each wanted one, the first of
// its names that Cloudflare lists, whatever the order of Cloudflare's list. `ready` is false
// when a required one is missing.
export function pickScopes(available: { id: string; name: string }[]) {
  const scopes: { id: string; name: string }[] = [],
    missing: string[] = [];
  let ready = true;
  for (const want of wantedScopes) {
    let found: { id: string; name: string } | undefined;
    for (const name of want.names.map(normalize)) {
      found = available.find(
        (s) => normalize(s.name) === name || normalize(s.id) === name,
      );
      if (found) break;
    }
    if (found) scopes.push(found);
    else {
      missing.push(want.label);
      if (want.required) ready = false;
    }
  }
  return { scopes, missing, ready };
}
