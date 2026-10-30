import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Terminal, Trash2 } from 'lucide-react';
import { api } from './api';
import { ConfirmOperation, type Confirmation } from './Operations';
import './developers.css';

type Token = {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
};
type Created = Token & { token: string };

const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString();

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="button secondary"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
      }
      aria-label={label}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

// API & CLI: tokens for the shipcel CLI, AI agents and scripts.
export function DevelopersPanel() {
  const [tokens, setTokens] = useState<Token[] | null>(null),
    [name, setName] = useState(''),
    [days, setDays] = useState('90'),
    [created, setCreated] = useState<Created | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  async function load() {
    setTokens(await api<Token[]>('/tokens'));
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(load);
  }, []);
  const origin = location.origin;
  const install = `npm install -g ${origin}/cli/shipcel.tgz
shipcel login --url ${origin}   # sign in with GitHub, connect Cloudflare
cd my-site
shipcel                         # builds it here and deploys it
shipcel --prod                  # production`;
  const ci = `npx --yes --package=${origin}/cli/shipcel.tgz shipcel deploy ./dist --prod --project my-site`;

  return (
    <div className="developers">
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <section className="panel operation-body">
        <div className="operation-title">
          <h2>
            <Terminal size={18} aria-hidden="true" /> Deploy from your terminal
          </h2>
        </div>
        <p>
          The shipcel command builds your site on your computer and deploys it
          into your own Cloudflare account, so nothing has to be set up in
          Cloudflare first. It recognises Vite, Create React App, Vue CLI, Astro
          and Gatsby; a folder of built files (<code>shipcel deploy dist</code>
          ), with an optional <code>_worker.js</code>, deploys as it is. Install
          it from this Shipcel (it needs Node.js 20 or later). The first time,
          it opens a page where you sign in with GitHub, approve it and connect
          Cloudflare; after that it uses its own token.
        </p>
        <pre className="snippet">{install}</pre>
        <CopyButton text={install} label="Copy the install commands" />
        <p>
          In CI, set <code>SHIPCEL_URL</code> to <code>{origin}</code> and{' '}
          <code>SHIPCEL_TOKEN</code> to a token from below instead of signing
          in, then run:
        </p>
        <pre className="snippet">{ci}</pre>
        <p>
          The commands follow Vercel&apos;s CLI; the{' '}
          <a href="/docs/cli/#coming-from-vercel">CLI guide</a> lists them side
          by side. Apps that render on a server, or have databases or other
          bindings, deploy from GitHub: <code>shipcel git connect</code>.
        </p>
      </section>

      <section className="panel operation-body">
        <div className="operation-title">
          <h2>
            <KeyRound size={18} aria-hidden="true" /> API tokens
          </h2>
        </div>
        <p>
          A token acts as you in this workspace for the CLI, an AI agent or a
          script. It can deploy and manage projects, and list or revoke your
          tokens, but it can&apos;t create tokens, connect accounts or turn
          Free-only off. Shipcel stores only a fingerprint of each token, so you
          see it once.
        </p>
        <form
          className="operation-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const result = await api<Created>('/tokens', {
                method: 'POST',
                body: JSON.stringify({
                  name: name.trim(),
                  ...(days === 'never' ? {} : { expiresInDays: Number(days) }),
                }),
              });
              setCreated(result);
              setName('');
              await load();
            });
          }}
        >
          <label className="field-label">
            Token name
            <input
              className="text-input"
              required
              maxLength={60}
              value={name}
              placeholder="Laptop, CI, Claude Code"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field-label">
            Expires
            <select
              className="text-input"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            >
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
              <option value="never">Never</option>
            </select>
          </label>
          <button className="button primary" disabled={busy || !name.trim()}>
            Create token
          </button>
        </form>
        {created && (
          <div className="token-once" role="status">
            <p>
              <strong>Copy your new token now.</strong> It won&apos;t be shown
              again.
            </p>
            <div className="token-value">
              <code>{created.token}</code>
              <CopyButton text={created.token} label="Copy the new token" />
            </div>
            <button
              type="button"
              className="text-link"
              onClick={() => setCreated(null)}
            >
              I&apos;ve saved it
            </button>
          </div>
        )}
        <div className="operation-list">
          {tokens === null ? (
            <p className="operation-empty">Loading tokens…</p>
          ) : tokens.length ? (
            tokens.map((t) => (
              <div className="operation-row" key={t.id}>
                <div>
                  <strong>{t.name}</strong>
                  <p>
                    <code>{t.prefix}…</code>, created {day(t.createdAt)},{' '}
                    {t.lastUsedAt
                      ? `last used ${day(t.lastUsedAt)}`
                      : 'never used'}{' '}
                    ,{' '}
                    {t.expiresAt
                      ? `expires ${day(t.expiresAt)}`
                      : 'does not expire'}
                  </p>
                </div>
                <button
                  className="button secondary"
                  disabled={busy}
                  aria-label={`Revoke ${t.name}`}
                  onClick={() =>
                    setConfirmation({
                      title: `Revoke ${t.name}?`,
                      text: 'Anything using this token, such as the CLI, an agent or a CI job, stops working at once.',
                      action: async () => {
                        await api(`/tokens/${t.id}`, { method: 'DELETE' });
                        await load();
                      },
                    })
                  }
                >
                  <Trash2 size={14} />
                  Revoke
                </button>
              </div>
            ))
          ) : (
            <p className="operation-empty">No API tokens yet.</p>
          )}
        </div>
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
