// Dashboard events for Shipcel's own analytics. /analytics.js (worker/analytics.ts) gives the
// dashboard a small sender of Shipcel's own when shipcel.com is set up for it: no third-party
// script runs on pages that show tokens. On a Shipcel that isn't set up (one on your computer,
// or in tests), these do nothing. Nobody is identified: an event says what happened, never who
// did it, and its properties never hold names or values.
type Properties = Record<string, boolean | number | string | undefined>;
type Analytics = { send(event: string, properties?: Properties): void };

export function capture(event: string, properties?: Properties) {
  const analytics = (globalThis as { __shipcelAnalytics?: Analytics })
    .__shipcelAnalytics;
  if (!analytics) return;
  try {
    analytics.send(event, properties);
  } catch {
    // Analytics never gets in the way of the dashboard.
  }
}
