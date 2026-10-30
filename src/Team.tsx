import { useEffect, useState } from 'react';
import { Link2, Trash2, UserPlus, UsersRound } from 'lucide-react';
import { api } from './api';
import { CopyButton } from './Developers';
import { ConfirmOperation, type Confirmation } from './Operations';
import './team.css';

type Role = 'owner' | 'developer' | 'viewer';
type Member = { userId: string; login: string; role: Role; you: boolean };
type Pending = {
  id: string;
  login: string;
  role: Role;
  createdAt: number;
  expiresAt: number;
};
export type Workspace = {
  id: string;
  name: string;
  role: Role;
  kind: 'personal' | 'team';
};
export const roleNames: Record<Role, string> = {
  owner: 'Owner',
  developer: 'Developer',
  viewer: 'Viewer',
};
const roleHelp: Record<Role, string> = {
  owner:
    'Everything, including the team, connected accounts and billing switches.',
  developer:
    'Creates, deploys and manages projects, and has their own API tokens.',
  viewer: 'Sees projects and deployments; changes nothing.',
};

// Team: the people in this workspace, invitations, and creating a team.
export function TeamPanel({
  workspace,
  login,
  onChanged,
}: {
  workspace: Workspace;
  login: string;
  onChanged: () => Promise<void>;
}) {
  const owner = workspace.role === 'owner';
  const [members, setMembers] = useState<Member[] | null>(null),
    [pending, setPending] = useState<Pending[]>([]),
    [invitee, setInvitee] = useState(''),
    [inviteRole, setInviteRole] = useState<Role>('developer'),
    [link, setLink] = useState<{ login: string; url: string } | null>(null),
    [teamName, setTeamName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  async function load() {
    setMembers(await api<Member[]>('/workspace/members'));
    setPending(owner ? await api<Pending[]>('/workspace/invitations') : []);
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    setLink(null);
    void run(load);
  }, [workspace.id, workspace.role]);

  return (
    <div className="team">
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="connection-notice" role="status">
          {notice}
        </div>
      )}
      <section className="panel operation-body">
        <div className="operation-title">
          <h2>
            <UsersRound size={18} aria-hidden="true" /> People in{' '}
            {workspace.name}
          </h2>
        </div>
        <ul className="role-list">
          {(Object.keys(roleNames) as Role[]).map((r) => (
            <li key={r}>
              <strong>{roleNames[r]}:</strong> {roleHelp[r]}
            </li>
          ))}
        </ul>
        <div className="operation-list">
          {members?.map((m) => (
            <div className="operation-row" key={m.userId}>
              <div>
                <strong>
                  @{m.login}
                  {m.you ? ' (you)' : ''}
                </strong>
                <p>{roleNames[m.role]}</p>
              </div>
              <div className="operation-badges">
                {owner && (
                  <label className="field-label compact">
                    <span className="sr-only">Role of @{m.login}</span>
                    <select
                      className="text-input"
                      value={m.role}
                      disabled={busy}
                      onChange={(e) => {
                        const role = e.target.value as Role;
                        void run(async () => {
                          await api(`/workspace/members/${m.userId}`, {
                            method: 'PUT',
                            body: JSON.stringify({ role }),
                          });
                          setNotice(
                            `@${m.login} is now ${roleNames[role].toLowerCase()}.`,
                          );
                          await load();
                          if (m.you) await onChanged();
                        });
                      }}
                    >
                      {(Object.keys(roleNames) as Role[]).map((r) => (
                        <option key={r} value={r}>
                          {roleNames[r]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {(m.you ? workspace.kind === 'team' : owner) && (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    aria-label={
                      m.you ? 'Leave this team' : `Remove @${m.login}`
                    }
                    onClick={() =>
                      setConfirmation({
                        title: m.you
                          ? `Leave ${workspace.name}?`
                          : `Remove @${m.login} from ${workspace.name}?`,
                        text: m.you
                          ? 'You lose access at once, and your API tokens for this team stop working. An owner can invite you again.'
                          : 'They lose access at once, and their API tokens for this workspace stop working. Their projects and deployments stay.',
                        action: async () => {
                          await api(`/workspace/members/${m.userId}`, {
                            method: 'DELETE',
                          });
                          if (m.you) await onChanged();
                          else {
                            setNotice(`@${m.login} was removed.`);
                            await load();
                          }
                        },
                      })
                    }
                  >
                    <Trash2 size={14} />
                    {m.you ? 'Leave' : 'Remove'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {owner && (
        <section className="panel operation-body">
          <div className="operation-title">
            <h2>
              <UserPlus size={18} aria-hidden="true" /> Invite someone
            </h2>
          </div>
          <p>
            Shipcel makes an invitation link for one GitHub account. Send it to
            them yourself; it works only when they are signed in as that
            account, once, within 7 days.
          </p>
          <form
            className="operation-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const created = await api<{ login: string; link: string }>(
                  '/workspace/invitations',
                  {
                    method: 'POST',
                    body: JSON.stringify({
                      login: invitee.trim().replace(/^@/, ''),
                      role: inviteRole,
                    }),
                  },
                );
                setLink({ login: created.login, url: created.link });
                setInvitee('');
                await load();
              });
            }}
          >
            <label className="field-label">
              GitHub username
              <input
                className="text-input"
                required
                maxLength={40}
                value={invitee}
                placeholder="octocat"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setInvitee(e.target.value)}
              />
            </label>
            <label className="field-label">
              Role
              <select
                className="text-input"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as Role)}
              >
                {(Object.keys(roleNames) as Role[]).map((r) => (
                  <option key={r} value={r}>
                    {roleNames[r]}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button primary"
              disabled={busy || !invitee.trim()}
            >
              Create invitation link
            </button>
          </form>
          {link && (
            <div className="token-once" role="status">
              <p>
                <strong>Send this link to @{link.login}.</strong> It is shown
                only now.
              </p>
              <div className="token-value">
                <code>{link.url}</code>
                <CopyButton text={link.url} label="Copy the invitation link" />
              </div>
              <button
                type="button"
                className="text-link"
                onClick={() => setLink(null)}
              >
                I&apos;ve sent it
              </button>
            </div>
          )}
          {pending.length > 0 && (
            <>
              <h3 className="team-subheading">Waiting to join</h3>
              <div className="operation-list">
                {pending.map((p) => (
                  <div className="operation-row" key={p.id}>
                    <div>
                      <strong>@{p.login}</strong>
                      <p>
                        {roleNames[p.role]}, link expires{' '}
                        {new Date(p.expiresAt * 1000).toLocaleDateString()}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      aria-label={`Cancel the invitation for @${p.login}`}
                      onClick={() =>
                        void run(async () => {
                          await api(`/workspace/invitations/${p.id}`, {
                            method: 'DELETE',
                          });
                          setNotice(
                            `The invitation for @${p.login} no longer works.`,
                          );
                          await load();
                        })
                      }
                    >
                      Cancel invitation
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      <section className="panel operation-body">
        <div className="operation-title">
          <h2>
            <Link2 size={18} aria-hidden="true" /> Create a team
          </h2>
        </div>
        <p>
          A team is a workspace you share: its own projects, connected accounts
          and people. You are its owner and can switch between workspaces from
          the menu at the top left. Signed in as @{login}.
        </p>
        <form
          className="operation-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api('/workspaces', {
                method: 'POST',
                body: JSON.stringify({ name: teamName.trim() }),
              });
              setTeamName('');
              await onChanged();
            });
          }}
        >
          <label className="field-label">
            Team name
            <input
              className="text-input"
              required
              minLength={2}
              maxLength={60}
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
            />
          </label>
          <button
            className="button primary"
            disabled={busy || teamName.trim().length < 2}
          >
            Create team
          </button>
        </form>
      </section>
      {confirmation && (
        <ConfirmOperation
          value={confirmation}
          busy={busy}
          onConfirm={() =>
            void run(async () => {
              try {
                await confirmation.action();
              } finally {
                setConfirmation(null);
              }
            })
          }
          onCancel={() => setConfirmation(null)}
        />
      )}
    </div>
  );
}

// Opened from an invitation link: join the workspace as the GitHub account it was made for.
export function InvitationPage({
  code,
  onJoined,
}: {
  code: string;
  onJoined: () => Promise<void>;
}) {
  const [info, setInfo] = useState<{
      workspaceName: string;
      role: Role;
      invitedBy: string | null;
      login: string;
      accepted: boolean;
      expired: boolean;
    } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api<NonNullable<typeof info>>(`/invitations/${encodeURIComponent(code)}`)
      .then(setInfo)
      .catch((e: Error) => setError(e.message));
  }, [code]);
  return (
    <section className="panel operation-body cli-approval">
      <h2>Join a workspace</h2>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {info &&
        (info.accepted || info.expired ? (
          <p>
            This invitation was already used or has expired. Ask the person who
            sent it for a new link.
          </p>
        ) : (
          <>
            <p>
              {info.invitedBy ? `@${info.invitedBy}` : 'An owner'} invited you
              to join <strong>{info.workspaceName}</strong> as{' '}
              {roleNames[info.role].toLowerCase()}: {roleHelp[info.role]}
            </p>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError('');
                api(`/invitations/${encodeURIComponent(code)}/accept`, {
                  method: 'POST',
                  body: JSON.stringify({}),
                })
                  .then(onJoined)
                  .catch((e: Error) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              Join {info.workspaceName}
            </button>
          </>
        ))}
      {!info && !error && <p>Checking the invitation…</p>}
    </section>
  );
}
