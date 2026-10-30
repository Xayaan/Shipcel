// How high smoldot's Wasm memory went, kept in the Durable Object's SQLite. Cloudflare resets an
// object that goes over 128 MB and loses the logs of the requests it cuts short, so each start
// records its memory as it goes, and the next start reads how far the previous one got.

const KEPT = 6; // the previous start's last samples, reported with its peak

export class MemoryTrace {
  #sql;

  constructor(sql) {
    this.#sql = sql;
    sql.exec('DROP TABLE IF EXISTS memory_trace').toArray(); // an earlier version's
    sql
      .exec(
        'CREATE TABLE IF NOT EXISTS memory_samples (run INTEGER NOT NULL, ms INTEGER NOT NULL, bytes INTEGER NOT NULL, received INTEGER NOT NULL, connections INTEGER NOT NULL, source TEXT NOT NULL, note TEXT NOT NULL)',
      )
      .toArray();
  }

  // Starts a new run, keeping only the one before it. Returns what that one reached, or null: its
  // highest Wasm memory and when ({ bytes, atMs }), when its last sample was (lastMs), and its last
  // samples, oldest first.
  begin(run) {
    const all = (query, ...args) => this.#sql.exec(query, ...args).toArray();
    const previous = all('SELECT MAX(run) AS run FROM memory_samples')[0]?.run;
    this.#sql
      .exec('DELETE FROM memory_samples WHERE run < ?', previous ?? run)
      .toArray();
    // Every start leaves a row, so the next one hears about it even if it lasted under a sample.
    this.record(run, {
      ms: 0,
      bytes: 0,
      received: 0,
      connections: 0,
      source: 'start',
      note: '',
    });
    if (previous == null) return null;
    const [high] = all(
      'SELECT bytes, ms FROM memory_samples WHERE run = ? ORDER BY bytes DESC, ms LIMIT 1',
      previous,
    );
    const last = all(
      'SELECT ms, bytes, received, connections, source, note FROM memory_samples WHERE run = ? ORDER BY ms DESC, rowid DESC LIMIT ?',
      previous,
      KEPT,
    ).reverse();
    return {
      bytes: high.bytes,
      atMs: high.ms,
      lastMs: last.at(-1).ms,
      samples: last,
    };
  }

  record(run, { ms, bytes, received, connections, source, note }) {
    this.#sql
      .exec(
        'INSERT INTO memory_samples (run, ms, bytes, received, connections, source, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
        run,
        ms,
        bytes,
        received,
        connections,
        source,
        note,
      )
      .toArray();
  }
}
