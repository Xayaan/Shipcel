// A bar chart drawn with plain elements, for Manage → Analytics & logs and the Billing
// panel. Each bar's height is its share of the tallest bar (or of the line, when the line
// is higher). The bars are for the eye; the table under them holds the same numbers for
// screen readers and for copying.

export type Bar = {
  key: string;
  label: string;
  value: number;
  // A second series drawn over the first from the bottom, such as errors over requests.
  overlay?: number;
};

export function BarChart({
  bars,
  format,
  caption,
  valueLabel,
  overlayLabel,
  overlayTone = 'error',
  line,
}: {
  bars: Bar[];
  format: (value: number) => string;
  // Names the table, as its summary and its region.
  caption: string;
  valueLabel: string;
  overlayLabel?: string;
  // Red for errors over requests; a deeper green for a part of the same thing, such as a
  // median inside a 99th percentile.
  overlayTone?: 'error' | 'part';
  // A dashed line across the chart, such as a budget or a daily limit.
  line?: { value: number; label: string };
}) {
  const top = Math.max(
    Number.MIN_VALUE,
    line?.value ?? 0,
    ...bars.map((b) => b.value),
  );
  const share = (value: number) => `${Math.min(100, (value / top) * 100)}%`;
  return (
    <div className="bar-chart">
      <div className="bar-plot" aria-hidden="true">
        {line && line.value > 0 && (
          <div className="bar-line" style={{ bottom: share(line.value) }}>
            <span>{line.label}</span>
          </div>
        )}
        {bars.map((b) => (
          <div
            key={b.key}
            className="bar"
            title={`${b.label}: ${format(b.value)}${
              overlayLabel && b.overlay
                ? `, ${format(b.overlay)} ${overlayLabel.toLowerCase()}`
                : ''
            }`}
          >
            <span className="bar-value" style={{ height: share(b.value) }} />
            {b.overlay ? (
              <span
                className={`bar-overlay ${overlayTone}`}
                style={{ height: share(b.overlay) }}
              />
            ) : null}
          </div>
        ))}
      </div>
      {bars.length > 1 && (
        <div className="bar-axis" aria-hidden="true">
          <span>{bars[0].label}</span>
          <span>{bars[bars.length - 1].label}</span>
        </div>
      )}
      <details className="bar-table">
        <summary>{caption}</summary>
        <div
          className="result-table"
          role="region"
          aria-label={caption}
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">{valueLabel}</th>
                {overlayLabel && <th scope="col">{overlayLabel}</th>}
              </tr>
            </thead>
            <tbody>
              {bars.map((b) => (
                <tr key={b.key}>
                  <td>{b.label}</td>
                  <td>{format(b.value)}</td>
                  {overlayLabel && <td>{format(b.overlay ?? 0)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
