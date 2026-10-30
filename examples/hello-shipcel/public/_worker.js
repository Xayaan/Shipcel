// Requests that match no file in this folder come here; everything else is served as a
// static file without running any code. GREETING is an optional secret:
//   shipcel env add GREETING
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/hello')
      return Response.json(
        {
          message: `${env.GREETING ?? 'Hello'} from Cloudflare's network!`,
          // The Cloudflare data center that answered.
          location: request.cf?.colo ?? 'unknown',
          time: new Date().toISOString(),
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    return env.ASSETS.fetch(request);
  },
};
