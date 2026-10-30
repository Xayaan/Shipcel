// Free-only projects never get anything Cloudflare can bill for. Everything else Shipcel
// creates (Workers, static assets, D1, KV, Durable Objects) stops at Cloudflare's free
// limits instead of billing while the account stays on the Workers Free plan.
export function freeOnlyIssues(plan: {
  resources: { type: string; binding: string }[];
  containers: unknown[];
}) {
  const issues: string[] = [];
  const buckets = plan.resources
    .filter((r) => r.type === 'r2')
    .map((r) => r.binding);
  if (buckets.length)
    issues.push(
      `This project is Free-only, and R2 buckets (${buckets.join(', ')}) can bill: Cloudflare charges for R2 beyond its monthly free allowance instead of stopping there. Remove them from the configuration, or have an owner turn off Free-only in the project's Billing panel in the dashboard.`,
    );
  if (plan.containers.length)
    issues.push(
      'This project is Free-only, and containers need Cloudflare’s Workers Paid plan. An owner can turn off Free-only in the project’s Billing panel in the dashboard to deploy them.',
    );
  return issues;
}
