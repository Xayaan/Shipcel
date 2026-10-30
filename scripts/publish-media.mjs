// npm run media:publish: puts the front page's tour (media/) in an R2 bucket of Shipcel's own
// Cloudflare account, served at media.shipcel.com, where the front page and the README link
// to it (site/media.ts). Run it before deploying the site that links there, and again after
// `npm run site:media` records a new tour. Wrangler signs in as for `npm run production:setup`,
// and each step skips what is done:
//   1. The bucket is created, unless it exists.
//   2. Each file is uploaded with its type and a day's caching.
//   3. media.shipcel.com is connected to the bucket, unless it is. Wrangler needs shipcel.com's
//      zone ID: `--zone-id <id>`, or it is asked for here (Cloudflare dashboard → shipcel.com
//      → Overview → API → Zone ID).
//   4. Each file is read back from media.shipcel.com, the video with a range as players ask,
//      until it answers. Each try is printed.
import { spawn } from 'node:child_process';
import { Resolver, resolve4, resolveNs } from 'node:dns/promises';
import { request } from 'node:https';
import { createInterface } from 'node:readline/promises';
import {
  MEDIA_BUCKET,
  MEDIA_CACHE,
  MEDIA_HOST,
  mediaTypes,
  mediaUrl,
} from '../site/media.ts';

// A new custom domain answers within a few minutes: its certificate comes first.
const ATTEMPTS = 20;
const WAIT = 15_000;
const TIMEOUT = 20_000;

const wrangler = (args, capture = false) =>
  new Promise((resolve) => {
    const child = spawn('npx', ['wrangler', ...args], {
      stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    });
    let output = '';
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => resolve({ code, output }));
  });
const must = (result, what) => {
  if (result.code !== 0)
    throw new Error(
      `${what} failed (exit code ${result.code}).${result.output ? `\n${result.output}` : ''}`,
    );
  return result;
};

console.log(`1. The bucket ${MEDIA_BUCKET}`);
const created = await wrangler(['r2', 'bucket', 'create', MEDIA_BUCKET], true);
if (created.code !== 0 && !/already exists/i.test(created.output))
  must(created, `Creating ${MEDIA_BUCKET}`);
console.log(created.code === 0 ? '   Created.' : '   Already there.');

console.log('2. The files');
for (const [name, type] of Object.entries(mediaTypes))
  must(
    await wrangler([
      'r2',
      'object',
      'put',
      `${MEDIA_BUCKET}/${name}`,
      '--file',
      `media/${name}`,
      '--content-type',
      type,
      '--cache-control',
      MEDIA_CACHE,
      '--remote',
    ]),
    `Uploading ${name}`,
  );

console.log(`3. ${MEDIA_HOST}`);
const domains = must(
  await wrangler(['r2', 'bucket', 'domain', 'list', MEDIA_BUCKET], true),
  `Listing ${MEDIA_BUCKET}'s domains`,
);
if (domains.output.includes(MEDIA_HOST)) console.log('   Already connected.');
else {
  const flag = process.argv.indexOf('--zone-id');
  let zone = flag > -1 ? (process.argv[flag + 1] ?? '') : '';
  if (!zone) {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    zone = await prompt.question(
      "   shipcel.com's zone ID (Cloudflare dashboard → shipcel.com → Overview → API): ",
    );
    prompt.close();
  }
  zone = zone.trim();
  if (!/^[a-f0-9]{32}$/.test(zone))
    throw new Error('A zone ID is 32 hexadecimal characters.');
  must(
    await wrangler([
      'r2',
      'bucket',
      'domain',
      'add',
      MEDIA_BUCKET,
      '--domain',
      MEDIA_HOST,
      '--zone-id',
      zone,
      '--min-tls',
      '1.2',
      '--force',
    ]),
    `Connecting ${MEDIA_HOST}`,
  );
}

console.log('4. Reading them back');
// At the addresses shipcel.com's own nameservers give. This computer's resolver can keep the
// "no such host" it got before the domain existed for half an hour, and asking it straight
// after connecting the domain is how it gets one.
const nameservers = new Resolver({ timeout: 5_000, tries: 2 });
const zone = MEDIA_HOST.slice(MEDIA_HOST.indexOf('.') + 1);
nameservers.setServers(
  (await Promise.all((await resolveNs(zone)).map((ns) => resolve4(ns)))).flat(),
);
const lookup = (hostname, options, callback) =>
  nameservers.resolve4(hostname).then(
    (addresses) =>
      options.all
        ? callback(
            null,
            addresses.map((address) => ({ address, family: 4 })),
          )
        : callback(null, addresses[0], 4),
    callback,
  );
// The status and type of the answer, without reading its body.
const read = (url, headers) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      { headers, lookup, timeout: TIMEOUT },
      (response) => {
        response.destroy();
        resolve(`${response.statusCode} ${response.headers['content-type']}`);
      },
    );
    req.on('timeout', () =>
      req.destroy(new Error(`no answer in ${TIMEOUT / 1000} s`)),
    );
    req.on('error', reject);
    req.end();
  });
for (const [name, type] of Object.entries(mediaTypes)) {
  const url = mediaUrl(name);
  const video = type.startsWith('video/');
  const ok = video ? '206' : '200';
  let answer;
  for (let attempt = 1; ; attempt++) {
    answer = await read(url, video ? { Range: 'bytes=0-1' } : {}).catch(
      (error) => error.code ?? error.message,
    );
    if (answer.startsWith(ok) || attempt === ATTEMPTS) break;
    console.log(
      `   ${url}: ${answer}. Trying again in ${WAIT / 1000} s (${attempt} of ${ATTEMPTS}).`,
    );
    await new Promise((r) => setTimeout(r, WAIT));
  }
  console.log(`   ${url}: ${answer}`);
  if (!answer.startsWith(ok)) process.exitCode = 1;
}
if (process.exitCode)
  console.log(
    `\n${MEDIA_HOST} doesn't answer yet. Run this again in a few minutes; if it still doesn't, check the domain under R2 → ${MEDIA_BUCKET} → Settings in Cloudflare's dashboard.`,
  );
