import { useEffect, useState } from 'react';
import { Bell, Send, Trash2 } from 'lucide-react';
import { api } from './api';
import { CopyButton } from './Developers';
import type { Confirmation } from './Operations';

type Status = {
  lastStatus: string | null;
  lastError: string | null;
  lastSentAt: number | null;
};
type Webhook = Status & { host: string; events: string[] };
type Channel = Status & { label: string; events: string[]; confirmed: boolean };
type Settings = {
  webhook: Webhook | null;
  telegram?: Channel | null;
  email?: Channel | null;
  emailReady?: boolean;
};
type Shared = {
  root: string;
  busy: boolean;
  action: (work: () => Promise<void>) => Promise<void>;
  confirm: (value: Confirmation) => void;
  notice: (text: string) => void;
  reload: () => Promise<void>;
};
const events = [
  { id: 'deployment.ready', label: 'A deployment is live' },
  { id: 'deployment.failed', label: 'A deployment or build failed' },
  { id: 'upload.deployed', label: 'A direct upload was deployed' },
  { id: 'health.unhealthy', label: 'A health check failed after a change' },
  { id: 'health.healthy', label: 'A health check passed after a change' },
];
const usualEvents = events
  .filter((e) => e.id !== 'health.healthy')
  .map((e) => e.id);
const described = (chosen: string[]) =>
  events
    .filter((e) => chosen.includes(e.id))
    .map((e) => e.label)
    .join(', ');
const lastMessage = (s: Status) =>
  s.lastStatus === 'sent'
    ? 'The last message was delivered.'
    : s.lastStatus === 'failed'
      ? `The last message failed (${s.lastError ?? 'no response'}). Shipcel retries twice.`
      : 'Nothing sent yet.';

function EventChoices({
  chosen,
  onChange,
}: {
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="event-choices">
      <legend>Send a message when</legend>
      {events.map((ev) => (
        <label className="deploy-consent" key={ev.id}>
          <input
            type="checkbox"
            checked={chosen.includes(ev.id)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...chosen, ev.id]
                  : chosen.filter((id) => id !== ev.id),
              )
            }
          />
          <span>{ev.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

// Send a test, Change and Remove, under a channel that is set up.
function ChannelActions({
  root,
  busy,
  action,
  confirm,
  notice,
  reload,
  channel,
  testable,
  onChange,
  removal,
}: Shared & {
  channel: 'webhook' | 'telegram' | 'email';
  testable: boolean;
  onChange: () => void;
  removal: Omit<Confirmation, 'action'> & { path: string; done: string };
}) {
  return (
    <div className="integration-actions">
      {testable && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const result = await api<{ status: string; detail: string }>(
                `${root}/notifications/test`,
                {
                  method: 'POST',
                  ...(channel === 'webhook'
                    ? {}
                    : { body: JSON.stringify({ channel }) }),
                },
              );
              notice(
                result.status === 'sent'
                  ? `Test message delivered (${result.detail}).`
                  : `The test message failed (${result.detail}).`,
              );
              await reload();
            })
          }
        >
          <Send size={14} />
          Send a test
        </button>
      )}
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={onChange}
      >
        Change
      </button>
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={() =>
          confirm({
            title: removal.title,
            text: removal.text,
            action: async () => {
              await api(`${root}${removal.path}`, { method: 'DELETE' });
              notice(removal.done);
              await reload();
            },
          })
        }
      >
        <Trash2 size={14} />
        Remove
      </button>
    </div>
  );
}

function WebhookChannel({
  webhook,
  ...shared
}: Shared & { webhook: Webhook | null }) {
  const { root, busy, action, reload } = shared;
  const [open, setOpen] = useState(false),
    [url, setUrl] = useState(''),
    [chosen, setChosen] = useState(usualEvents),
    [secret, setSecret] = useState<string | null>(null);
  const form = (
    <form
      className="operation-form stacked"
      onSubmit={(e) => {
        e.preventDefault();
        void action(async () => {
          const saved = await api<{ signingSecret: string }>(
            `${root}/notifications`,
            {
              method: 'PUT',
              body: JSON.stringify({ url: url.trim(), events: chosen }),
            },
          );
          setUrl('');
          setOpen(false);
          setSecret(saved.signingSecret);
          await reload();
        });
      }}
    >
      <label className="field-label">
        Webhook address
        <input
          className="text-input"
          type="url"
          required
          placeholder="https://hooks.slack.com/services/…"
          value={url}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <EventChoices chosen={chosen} onChange={setChosen} />
      <div className="integration-actions">
        <button
          className="button primary"
          disabled={
            busy || !url.trim().startsWith('https://') || !chosen.length
          }
        >
          Save webhook
        </button>
        <button
          type="button"
          className="text-link"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
  return (
    <div className="operation-list">
      <h3>Webhook</h3>
      <p>
        Shipcel posts a JSON message to your webhook when something happens to
        this app. Slack and Discord incoming webhooks show it as is; other
        endpoints can check the <code>X-Shipcel-Signature</code> header, an
        HMAC-SHA256 of <code>timestamp.body</code> with your signing secret. The
        address is stored encrypted.
      </p>
      {secret && (
        <div className="token-once" role="status">
          <p>
            <strong>Copy your signing secret now.</strong> It won&apos;t be
            shown again.
          </p>
          <div className="token-value">
            <code>{secret}</code>
            <CopyButton text={secret} label="Copy the signing secret" />
          </div>
          <button
            type="button"
            className="text-link"
            onClick={() => setSecret(null)}
          >
            I&apos;ve saved it
          </button>
        </div>
      )}
      {!webhook && !open && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => setOpen(true)}
        >
          Add a webhook
        </button>
      )}
      {webhook && (
        <>
          <div className="operation-row">
            <div>
              <strong>{webhook.host}</strong>
              <p>{described(webhook.events)}</p>
              <p className="field-hint">{lastMessage(webhook)}</p>
            </div>
          </div>
          <ChannelActions
            {...shared}
            channel="webhook"
            testable
            onChange={() => setOpen(true)}
            removal={{
              title: 'Remove this webhook?',
              text: 'Shipcel stops sending messages, and drops messages not sent yet.',
              path: '/notifications',
              done: 'Webhook removed.',
            }}
          />
        </>
      )}
      {open && form}
    </div>
  );
}

function TelegramChannel({
  telegram,
  ...shared
}: Shared & { telegram: Channel | null }) {
  const { root, busy, action, notice, reload } = shared;
  const [open, setOpen] = useState(false),
    [token, setToken] = useState(''),
    [chat, setChat] = useState(''),
    [chosen, setChosen] = useState(usualEvents);
  return (
    <div className="operation-list">
      <h3>Telegram</h3>
      <p>
        Messages from your own bot. Create one with @BotFather and paste its
        token here, then send the bot a message or add it to your group or
        channel: Shipcel finds the chat. The token is stored encrypted.
      </p>
      {telegram && (
        <>
          <div className="operation-row">
            <div>
              <strong>{telegram.label}</strong>
              <p>{described(telegram.events)}</p>
              <p className="field-hint">{lastMessage(telegram)}</p>
            </div>
          </div>
          <ChannelActions
            {...shared}
            channel="telegram"
            testable
            onChange={() => setOpen(true)}
            removal={{
              title: 'Remove this Telegram chat?',
              text: 'Shipcel stops posting to it, and drops messages not sent yet. The bot stays yours.',
              path: '/notifications/telegram',
              done: 'Telegram chat removed.',
            }}
          />
        </>
      )}
      {!telegram && !open && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => setOpen(true)}
        >
          Add a Telegram chat
        </button>
      )}
      {open && (
        <form
          className="operation-form stacked"
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const saved = await api<{ label: string }>(
                `${root}/notifications/telegram`,
                {
                  method: 'PUT',
                  body: JSON.stringify({
                    botToken: token.trim(),
                    ...(chat.trim() ? { chatId: chat.trim() } : {}),
                    events: chosen,
                  }),
                },
              );
              setToken('');
              setChat('');
              setOpen(false);
              notice(`Telegram set up: ${saved.label}.`);
              await reload();
            });
          }}
        >
          <label className="field-label">
            Bot token
            <input
              className="text-input"
              type="password"
              required
              placeholder="123456789:AA…"
              value={token}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <label className="field-label">
            Chat id (optional)
            <input
              className="text-input"
              placeholder="Found from the bot’s latest message"
              value={chat}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setChat(e.target.value)}
            />
          </label>
          <EventChoices chosen={chosen} onChange={setChosen} />
          <div className="integration-actions">
            <button
              className="button primary"
              disabled={busy || !token.trim() || !chosen.length}
            >
              Save Telegram chat
            </button>
            <button
              type="button"
              className="text-link"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function EmailChannel({
  email,
  ready,
  ...shared
}: Shared & { email: Channel | null; ready: boolean }) {
  const { root, busy, action, notice, reload } = shared;
  const [open, setOpen] = useState(false),
    [address, setAddress] = useState(''),
    [chosen, setChosen] = useState(usualEvents);
  return (
    <div className="operation-list">
      <h3>Email</h3>
      <p>
        Emails from Shipcel to any address, once someone with that inbox
        confirms it. Each email has a link that stops them.
      </p>
      {!ready && !email && (
        <p className="field-hint">
          This Shipcel has no email sender set up yet (SETUP.md).
        </p>
      )}
      {email && (
        <>
          <div className="operation-row">
            <div>
              <strong>{email.label}</strong>
              <p>{described(email.events)}</p>
              <p className="field-hint">
                {email.confirmed
                  ? lastMessage(email)
                  : 'Waiting for confirmation: the link went to this address.'}
              </p>
            </div>
          </div>
          <ChannelActions
            {...shared}
            channel="email"
            testable={email.confirmed}
            onChange={() => setOpen(true)}
            removal={{
              title: `Stop emailing ${email.label}?`,
              text: 'Shipcel sends it nothing more, and drops emails not sent yet.',
              path: '/notifications/email',
              done: 'Email address removed.',
            }}
          />
        </>
      )}
      {ready && !email && !open && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => setOpen(true)}
        >
          Add an email address
        </button>
      )}
      {open && (
        <form
          className="operation-form stacked"
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const saved = await api<{ label: string; confirmed: boolean }>(
                `${root}/notifications/email`,
                {
                  method: 'PUT',
                  body: JSON.stringify({
                    address: address.trim(),
                    events: chosen,
                  }),
                },
              );
              setAddress('');
              setOpen(false);
              notice(
                saved.confirmed
                  ? 'Email notifications changed.'
                  : `A confirmation link went to ${saved.label}. Emails start once it’s confirmed.`,
              );
              await reload();
            });
          }}
        >
          <label className="field-label">
            Email address
            <input
              className="text-input"
              type="email"
              required
              value={address}
              autoComplete="email"
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
          <EventChoices chosen={chosen} onChange={setChosen} />
          <div className="integration-actions">
            <button
              className="button primary"
              disabled={busy || !address.trim() || !chosen.length}
            >
              Save email address
            </button>
            <button
              type="button"
              className="text-link"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// Manage → Notifications: a webhook for Slack, Discord or any HTTPS endpoint, a Telegram
// chat, and an email address (worker/notifications.ts).
export function NotificationsPanel(props: Omit<Shared, 'reload'>) {
  const [settings, setSettings] = useState<Settings | undefined>(undefined);
  const reload = async () =>
    setSettings(await api<Settings>(`${props.root}/notifications`));
  useEffect(() => {
    void props.action(reload);
  }, [props.root]);
  const shared = { ...props, reload };
  return (
    <section className="panel operation-body">
      <div className="operation-title">
        <h2>
          <Bell size={18} aria-hidden="true" /> Notifications
        </h2>
      </div>
      {settings && (
        <>
          <WebhookChannel {...shared} webhook={settings.webhook} />
          <TelegramChannel {...shared} telegram={settings.telegram ?? null} />
          <EmailChannel
            {...shared}
            email={settings.email ?? null}
            ready={settings.emailReady ?? false}
          />
        </>
      )}
    </section>
  );
}
