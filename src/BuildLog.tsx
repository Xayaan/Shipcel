import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { api } from './api';

// One build's log, from Cloudflare's Workers Builds (Builds & versions → Logs). While the
// build runs, new lines are fetched every few seconds from where the last ones stopped.

type Line = { at: number; text: string };
type Page = {
  lines: Line[];
  cursor: string | null;
  done: boolean;
  outcome: string | null;
};
const POLL_MS = 3000;
// Cloudflare's timestamps may be seconds or milliseconds since 1970.
const time = (at: number) =>
  new Date(at < 1e12 ? at * 1000 : at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export function BuildLog({ root, build }: { root: string; build: string }) {
  const [lines, setLines] = useState<Line[]>([]),
    [state, setState] = useState<{ done: boolean; outcome: string | null }>({
      done: false,
      outcome: null,
    }),
    [error, setError] = useState('');
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let stopped = false,
      cursor: string | null = null,
      timer: ReturnType<typeof setTimeout> | undefined;
    // A page may repeat lines already shown when the cursor doesn't move on.
    const seen = new Set<string>();
    async function read() {
      try {
        const page: Page = await api<Page>(
          `${root}/builds/${build}/logs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        if (stopped) return;
        const fresh = page.lines.filter((line) => {
          const key = `${line.at} ${line.text}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (fresh.length) setLines((old) => [...old, ...fresh]);
        cursor = page.cursor ?? cursor;
        setState({ done: page.done, outcome: page.outcome });
        if (!page.done) timer = setTimeout(() => void read(), POLL_MS);
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
    }
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [root, build]);
  // Follow the newest line, as a terminal does.
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);
  return (
    <div className="build-log">
      <p className="build-log-state" role="status">
        {state.done ? (
          `Build ${state.outcome ?? 'finished'}.`
        ) : (
          <>
            <LoaderCircle size={14} className="spin" aria-hidden="true" />{' '}
            Building: new lines every few seconds.
          </>
        )}
      </p>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <pre
        ref={box}
        className="build-log-lines"
        tabIndex={0}
        aria-label="Build log"
      >
        {lines.length
          ? lines.map((l) => `${time(l.at)}  ${l.text}`).join('\n')
          : 'No lines yet.'}
      </pre>
    </div>
  );
}
