import { useEffect, useState } from 'react';
import { Hammer, Trash2 } from 'lucide-react';
import { api } from './api';
import type { Confirmation } from './Operations';

type Variable = { name: string; secret: boolean; value: string | null };
const namePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// Manage → Secrets & variables → Build variables: Workers Builds environment variables for
// production builds, or for branch preview builds. They apply from the next build.
export function BuildVariables({
  root,
  busy,
  action,
  mutate,
  confirm,
}: {
  root: string;
  busy: boolean;
  action: (work: () => Promise<void>) => Promise<void>;
  mutate: (
    path: string,
    method: string,
    body: Record<string, unknown>,
    success: string,
  ) => Promise<void>;
  confirm: (value: Confirmation) => void;
}) {
  const [environment, setEnvironment] = useState<'production' | 'preview'>(
      'production',
    ),
    [previews, setPreviews] = useState(false),
    [variables, setVariables] = useState<Variable[] | null>(null),
    [name, setName] = useState(''),
    [value, setValue] = useState(''),
    [secret, setSecret] = useState(false);
  const where = environment === 'preview' ? 'branch preview' : 'production';
  async function load(next = environment) {
    setVariables(
      (
        await api<{ variables: Variable[] }>(
          `${root}/build-variables?environment=${next}`,
        )
      ).variables,
    );
  }
  useEffect(() => {
    void action(async () => {
      await load('production');
      const status = await api<{ status: string }>(
        `${root}/previews?details=0`,
      ).catch(() => null);
      setPreviews(status?.status === 'active');
    });
  }, [root]);

  return (
    <section className="panel operation-body">
      <div className="operation-title">
        <h2>
          <Hammer size={18} aria-hidden="true" /> Build variables
        </h2>
        {previews && (
          <label className="field-label">
            Builds
            <select
              className="text-input"
              value={environment}
              disabled={busy}
              onChange={(e) => {
                const next = e.target.value as 'production' | 'preview';
                setEnvironment(next);
                setVariables(null);
                void action(() => load(next));
              }}
            >
              <option value="production">Production</option>
              <option value="preview">Branch previews</option>
            </select>
          </label>
        )}
      </div>
      <p>
        Variables your build command reads, such as <code>VITE_API_URL</code>.
        Cloudflare passes them to each {where} build; changes apply from the
        next build. Secret values go only to Cloudflare and are never shown
        again. Variables your app reads while running belong in Runtime secrets
        above.
      </p>
      {variables && (
        <div className="operation-list">
          {variables.length ? (
            variables.map((v) => (
              <div className="operation-row" key={v.name}>
                <div>
                  <strong>{v.name}</strong>
                  <p>{v.secret ? 'Secret value' : v.value}</p>
                </div>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  aria-label={`Remove build variable ${v.name}`}
                  onClick={() =>
                    confirm({
                      title: `Remove ${v.name} from ${where} builds?`,
                      text: 'The next build runs without it.',
                      action: async () => {
                        await mutate(
                          `/build-variables/${encodeURIComponent(v.name)}`,
                          'DELETE',
                          { environment },
                          `${v.name} removed. It applies from the next build.`,
                        );
                        await load();
                      },
                    })
                  }
                >
                  <Trash2 size={14} />
                  Remove
                </button>
              </div>
            ))
          ) : (
            <p className="operation-empty">No build variables.</p>
          )}
        </div>
      )}
      <form
        className="operation-form"
        onSubmit={(e) => {
          e.preventDefault();
          const entry = { name: name.trim(), value, secret };
          // The value leaves the form as soon as it is submitted for review.
          setValue('');
          confirm({
            title: `Set ${entry.name} for ${where} builds?`,
            text: `${entry.secret ? 'The value is stored only in Cloudflare and never shown again. ' : ''}It applies from the next build; redeploy to use it now.`,
            action: async () => {
              await mutate(
                '/build-variables',
                'PUT',
                { environment, ...entry },
                `${entry.name} saved. It applies from the next build.`,
              );
              setName('');
              setSecret(false);
              await load();
            },
          });
        }}
      >
        <label className="field-label">
          Name
          <input
            className="text-input"
            value={name}
            maxLength={128}
            spellCheck={false}
            aria-invalid={Boolean(name) && !namePattern.test(name.trim())}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field-label">
          Value
          <input
            className="text-input"
            type={secret ? 'password' : 'text'}
            value={value}
            maxLength={5000}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <label className="deploy-consent">
          <input
            type="checkbox"
            checked={secret}
            onChange={(e) => setSecret(e.target.checked)}
          />
          <span>Secret</span>
        </label>
        <button
          className="button primary"
          disabled={busy || !namePattern.test(name.trim()) || !value}
        >
          Save variable
        </button>
      </form>
    </section>
  );
}
