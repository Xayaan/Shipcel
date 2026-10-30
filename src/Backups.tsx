import { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api } from './api';
import type { Confirmation } from './Operations';

type Schedule = {
  binding: string;
  cadence: 'daily' | 'weekly';
  hour: number;
  keep: number;
  bucket: string;
  nextAt: number;
  lastError: string | null;
};
type Copy = {
  id: string;
  binding: string;
  status: 'exporting' | 'storing' | 'done' | 'failed';
  bytes: number | null;
  error: string | null;
  createdAt: number;
};
type Listing = { schedule: Schedule | null; backups: Copy[] };
type Shared = {
  busy: boolean;
  confirm: (value: Confirmation) => void;
  notice: (text: string) => void;
};

// Shipcel moves an export on once a minute; while one runs, the list is fetched this often.
const REFRESH_MS = 20000;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
const when = (seconds: number) => new Date(seconds * 1000).toLocaleString();
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// Manage → Database → Backups → Scheduled copies: the D1 database copied into an R2 bucket of
// the customer's account every day or week (worker/backups.ts), the newest few kept and each
// one downloadable.
export function ScheduledBackups({
  root,
  bindings,
  busy,
  confirm,
  notice,
}: Shared & { root: string; bindings: string[] }) {
  const [schedule, setSchedule] = useState<Schedule | null>(null),
    [copies, setCopies] = useState<Copy[] | null>(null),
    [failed, setFailed] = useState(''),
    [binding, setBinding] = useState(''),
    [cadence, setCadence] = useState<Schedule['cadence']>('daily'),
    [hour, setHour] = useState(3),
    [keep, setKeep] = useState(7);
  const load = useCallback(
    () =>
      api<Listing>(`${root}/backups`).then((data) => {
        setSchedule(data.schedule);
        setCopies(data.backups);
        setFailed('');
        return data;
      }),
    [root],
  );
  useEffect(() => {
    setCopies(null);
    load()
      .then(({ schedule: saved }) => {
        if (!saved) return;
        setBinding(saved.binding);
        setCadence(saved.cadence);
        setHour(saved.hour);
        setKeep(saved.keep);
      })
      .catch((error: Error) => setFailed(error.message));
  }, [load]);
  // A copy under way finishes on a later minute: look again until it has.
  const running =
    copies?.some((c) => c.status === 'exporting' || c.status === 'storing') ??
    false;
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(
      () => void load().catch((error: Error) => setFailed(error.message)),
      REFRESH_MS,
    );
    return () => clearTimeout(timer);
  }, [running, copies, load]);

  const save = () => {
    const name = binding || bindings[0] || 'DB';
    confirm({
      title: schedule
        ? 'Change the backup schedule?'
        : `Back up ${name} to R2?`,
      text: `${schedule ? `Copies go on into ${schedule.bucket}` : 'Shipcel makes a bucket for the copies in your Cloudflare account'}: ${name}, every ${cadence === 'daily' ? 'day' : 'week'} at ${clock(hour)} UTC, the newest ${keep} kept. The database can’t serve queries while Cloudflare exports it, usually for seconds, so pick a quiet hour.`,
      action: async () => {
        const saved = await api<Schedule>(`${root}/backups`, {
          method: 'PUT',
          body: JSON.stringify({
            binding: name,
            cadence,
            hour,
            keep,
            confirm: true,
          }),
        });
        setSchedule(saved);
        notice(`Backups scheduled. The next copy is at ${when(saved.nextAt)}.`);
      },
    });
  };
  const runNow = (s: Schedule) =>
    confirm({
      title: `Back up ${s.binding} now?`,
      text: `Cloudflare exports the database into a new copy in ${s.bucket}; it can’t serve queries while it does, usually for seconds. Copies beyond the newest ${s.keep} are removed.`,
      action: async () => {
        await api(`${root}/backups/run`, {
          method: 'POST',
          body: JSON.stringify({ confirm: true }),
        });
        const [copy] = (await load()).backups;
        if (copy?.status === 'failed')
          throw new Error(copy.error ?? 'The copy failed.');
        notice(
          copy?.status === 'done'
            ? `Backed up ${s.binding}.`
            : 'Cloudflare is exporting the database; the copy is listed once it’s done.',
        );
      },
    });
  const stop = (s: Schedule) =>
    confirm({
      title: 'Stop backups?',
      text: `No more copies are made. Those in ${s.bucket} stay there until you delete them in Cloudflare.`,
      action: async () => {
        await api(`${root}/backups`, { method: 'DELETE' });
        setSchedule(null);
        notice('Backups stopped.');
      },
    });

  return (
    <div className="operation-list">
      <h3>Scheduled copies</h3>
      <p>
        Copies of the database in an R2 bucket of your Cloudflare account, every
        day or week, kept for as long as you choose: outside the database, and
        past Time Travel’s window. R2 stores 10 GB free, then bills $0.015 per
        GB-month, so Free-only projects can’t have them.
      </p>
      {failed && (
        <p className="field-hint">Backups couldn’t be loaded: {failed}</p>
      )}
      {schedule && (
        <p className="field-hint">
          {schedule.binding}, every{' '}
          {schedule.cadence === 'daily' ? 'day' : 'week'} at{' '}
          {clock(schedule.hour)} UTC, the newest {schedule.keep} kept in{' '}
          <code>{schedule.bucket}</code>. Next copy: {when(schedule.nextAt)}.
        </p>
      )}
      {schedule?.lastError && (
        <p className="field-hint">
          The last copy didn’t start: {schedule.lastError} Shipcel tries again
          an hour later.
        </p>
      )}
      <div className="operation-form">
        {bindings.length > 1 && (
          <label className="field-label">
            D1 binding
            <select
              className="text-input"
              value={binding || bindings[0]}
              disabled={busy}
              onChange={(e) => setBinding(e.target.value)}
            >
              {bindings.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field-label">
          How often
          <select
            className="text-input"
            value={cadence}
            disabled={busy}
            onChange={(e) => setCadence(e.target.value as Schedule['cadence'])}
          >
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
          </select>
        </label>
        <label className="field-label">
          Time (UTC)
          <select
            className="text-input"
            value={hour}
            disabled={busy}
            onChange={(e) => setHour(Number(e.target.value))}
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {clock(h)}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Copies kept
          <input
            className="text-input"
            type="number"
            min={1}
            max={90}
            value={keep}
            disabled={busy}
            onChange={(e) => setKeep(Number(e.target.value))}
          />
        </label>
        <button
          className="button secondary"
          disabled={busy || !(keep >= 1 && keep <= 90)}
          onClick={save}
        >
          {schedule ? 'Save schedule' : 'Start backups'}
        </button>
      </div>
      {schedule && (
        <div className="integration-actions">
          <button
            className="button secondary"
            disabled={busy || running}
            onClick={() => runNow(schedule)}
          >
            Back up now
          </button>
          <button
            type="button"
            className="text-link"
            disabled={busy}
            onClick={() => stop(schedule)}
          >
            Stop backups
          </button>
        </div>
      )}
      {copies?.map((copy) => (
        <div className="operation-row" key={copy.id}>
          <div>
            <strong>{when(copy.createdAt)}</strong>
            <p>
              {copy.status === 'done'
                ? `${copy.binding}, ${size(copy.bytes ?? 0)}`
                : copy.status === 'exporting'
                  ? 'Cloudflare is exporting the database.'
                  : copy.status === 'storing'
                    ? 'Storing the copy in R2.'
                    : copy.error}
            </p>
          </div>
          {copy.status === 'done' ? (
            <a
              className="button secondary"
              href={`/api${root}/backups/${copy.id}/download`}
              aria-label={`Download the copy of ${when(copy.createdAt)}`}
              download
            >
              <Download size={14} />
              Download
            </a>
          ) : (
            <span
              className={`badge ${copy.status === 'failed' ? 'danger' : 'warning'}`}
            >
              {copy.status === 'failed'
                ? 'Failed'
                : copy.status === 'storing'
                  ? 'Storing'
                  : 'Exporting'}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
