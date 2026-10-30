// The Git remotes of a folder, read from its .git/config, and the GitHub repository a remote
// names. Nothing here runs git, so the CLI works on computers without it.

export type Remote = { name: string; url: string };

export function parseRemotes(config: string): Remote[] {
  const remotes: Remote[] = [];
  let current: string | null = null;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[(.*)\]\s*$/.exec(line);
    if (section) {
      current = /^remote\s+"([^"]+)"$/.exec(section[1].trim())?.[1] ?? null;
      continue;
    }
    const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line)?.[1];
    if (current && url && !remotes.some((r) => r.name === current))
      remotes.push({ name: current, url });
  }
  return remotes;
}

// The host and repository path of a remote on any Git host (GitLab, Bitbucket, Gitea or
// Forgejo), in the forms git writes. A remote can carry credentials; only these are returned.
export function remoteRepository(
  remote: string,
): { host: string; path: string } | null {
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(remote.trim());
  let host: string, path: string;
  if (scp) [, host, path] = scp;
  else {
    try {
      const url = new URL(remote.trim());
      host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
      // ssh:// on a port of its own is the SSH server, not the web address.
      if (url.protocol === 'ssh:') host = url.hostname;
      path = url.pathname;
    } catch {
      return null;
    }
  }
  path = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  // GitLab serves SSH from altssh hosts too.
  host = host.toLowerCase().replace(/^altssh\./, '');
  const parts = path.split('/');
  return parts.length >= 2 &&
    parts.length <= 5 &&
    parts.every((p) => /^(?!\.{1,2}$)[\w.-]{1,100}$/.test(p))
    ? { host, path }
    : null;
}

// "owner/name" for a GitHub remote in any of the forms git writes: https, ssh://, git@host:,
// git://. Null for other hosts. A remote can carry credentials; only the path is returned.
export function githubRepository(remote: string): string | null {
  const found = remoteRepository(remote);
  if (
    !found ||
    !['github.com', 'www.github.com', 'ssh.github.com'].includes(found.host)
  )
    return null;
  return /^[\w-]+\/[\w.-]+$/.test(found.path) ? found.path : null;
}
