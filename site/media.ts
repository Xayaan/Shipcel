// The front page's tour: recorded by `npm run site:media` into media/, and kept in R2 by
// `npm run media:publish`, in a bucket of Shipcel's own Cloudflare account served at
// media.shipcel.com, which the front page and the README link to. A day's caching: a new
// recording shows within a day, or at once after purging media.shipcel.com's cache.
export const MEDIA_HOST = 'media.shipcel.com';
export const MEDIA_BUCKET = 'shipcel-media';
export const MEDIA_CACHE = 'public, max-age=86400';
export const mediaTypes = {
  'tour.webm': 'video/webm',
  'tour.webp': 'image/webp',
} as const;
export const mediaUrl = (name: keyof typeof mediaTypes) =>
  `https://${MEDIA_HOST}/${name}`;
