import { useEffect, useState } from 'react';
import { api } from './api';
import type { SessionStatus } from '../shared/integrations';

type Request = {
  client: { name: string; redirectHost: string };
  status: 'pending' | 'approved' | 'denied' | 'used' | 'expired';
  expiresAt: number;
};

// The page an AI agent's OAuth sign-in opens (worker/oauth-server.ts): who is asking, and
// Allow or Deny. Signed out, it sends the person through GitHub and back here.
export function OAuthApprove({
  id,
  session,
}: {
  id: string;
  session: SessionStatus;
}) {
  const user = session.user && !session.user.local ? session.user : null;
  const workspace = user?.workspaces.find((w) => w.id === user.workspaceId);
  const [request, setRequest] = useState<Request | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [decided, setDecided] = useState<'approved' | 'denied' | null>(null);
  useEffect(() => {
    if (!user) return;
    api<Request>(`/oauth/${encodeURIComponent(id)}`)
      .then(setRequest)
      .catch((e) => setError((e as Error).message));
  }, [id, user]);
  async function decide(choice: 'approve' | 'deny') {
    setBusy(true);
    setError('');
    try {
      const { redirect } = await api<{ redirect: string }>(
        `/oauth/${encodeURIComponent(id)}/${choice}`,
        { method: 'POST', body: '{}' },
      );
      setDecided(choice === 'approve' ? 'approved' : 'denied');
      location.assign(redirect);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="signin-page">
      <section className="panel operation-body">
        <h1>Let an AI agent use Shipcel as you?</h1>
        {!user ? (
          <>
            <p>Sign in with GitHub first; you come back here.</p>
            <a
              className="button primary"
              href={`/api/auth/github/start?return=${encodeURIComponent(`oauth:${id}`)}`}
            >
              Sign in with GitHub
            </a>
          </>
        ) : error ? (
          <div className="inline-error" role="alert">
            {error}
          </div>
        ) : !request ? (
          <p>Loading…</p>
        ) : request.status !== 'pending' ? (
          <p>
            This request{' '}
            {request.status === 'expired' ? 'expired' : `was ${request.status}`}
            . Start again from the app.
          </p>
        ) : (
          <>
            <p>
              <strong>{request.client.name}</strong> (
              {request.client.redirectHost}) wants to use Shipcel’s MCP server
              as you, in <strong>{workspace?.name ?? 'this workspace'}</strong>:
              create projects, deploy, publish and roll back. It gets a token of
              its own for 90 days, which can’t create tokens, connect accounts
              or turn Free-only off; revoke it under API &amp; CLI at any time.
            </p>
            <div className="actions">
              <button
                type="button"
                className="button primary"
                disabled={busy || !!decided}
                onClick={() => void decide('approve')}
              >
                Allow
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy || !!decided}
                onClick={() => void decide('deny')}
              >
                Deny
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
