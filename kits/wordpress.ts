// WordPress from the official image, with its uploads in an R2 bucket and its email sent
// by the Worker (src/worker.js), and the database in MySQL elsewhere.
import {
  containerConfig,
  CONTAINERS_VERSION,
  containerScripts,
  unset,
} from './common.ts';
import type { Kit, KitMeta } from './types.ts';

// What the App catalog shows.
export const meta = {
  id: 'wordpress',
  name: 'WordPress',
  subtitle: 'Websites, publishing & commerce',
  runtime: 'Containers + external MySQL',
  family: 'Containers',
  symbol: 'W',
  color: 'blue',
  description:
    'Experimental: WordPress 7.1 from its official image in a container, with its database in MySQL you host elsewhere, uploads in R2 and email through Cloudflare’s Email Service. Not yet run end to end on Cloudflare: a static export or headless WordPress are the proven routes. Needs the Workers Paid plan.',
  docs: 'https://developers.cloudflare.com/containers/concepts/architecture/',
  containers: true,
} as const satisfies KitMeta;

// What an exported project contains, beyond what every kit gets.
export const kit: Kit = {
  config: () => ({
    ...containerConfig('WordPress', 'WORDPRESS', './Dockerfile', 'basic', 1),
    r2_buckets: [{ binding: 'UPLOADS' }],
    send_email: [{ name: 'EMAIL' }],
  }),
  scripts: containerScripts,
  dependencies: { '@cloudflare/containers': CONTAINERS_VERSION },
  ignore: '',
  files: (project) => {
    const files: Record<string, string> = {};
    files['src/worker.js'] =
      `import { Container, getContainer } from '@cloudflare/containers';

const UPLOADS = '/wp-content/uploads/';

// DATABASE_URL (mysql://user:password@host:port/database) as the WordPress image's settings.
function database(value) {
  const url = new URL(value);
  return {
    WORDPRESS_DB_HOST: \`\${url.hostname}:\${url.port || '3306'}\`,
    WORDPRESS_DB_USER: decodeURIComponent(url.username),
    WORDPRESS_DB_PASSWORD: decodeURIComponent(url.password),
    WORDPRESS_DB_NAME: decodeURIComponent(url.pathname.slice(1)),
  };
}

// WordPress's eight keys and salts, from one secret, so they stay the same each time the
// container starts and nobody is signed out.
async function keys(secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const names = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'];
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => {
        const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(name));
        return [\`WORDPRESS_\${name}\`, [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')];
      }),
    ),
  );
}

// The rest of wp-config.php: the site's own address, HTTPS from the Worker, TLS to MySQL,
// and no installs or updates from the dashboard (the disk is temporary: themes, plugins and
// WordPress itself come with the image).
const settings = (origin) => \`define('WP_HOME', '\${origin}');
define('WP_SITEURL', '\${origin}');
if (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') { $_SERVER['HTTPS'] = 'on'; }
define('MYSQL_CLIENT_FLAGS', MYSQLI_CLIENT_SSL);
define('DISALLOW_FILE_MODS', true);
define('AUTOMATIC_UPDATER_DISABLED', true);\`;

// The container's uploads, kept in R2: PUT stores a file, DELETE removes it, GET reads it
// back (an original WordPress opens again after the container restarts).
async function uploads(request, env) {
  const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
  if (!key || key.split('/').some((part) => part === '' || part === '.' || part === '..'))
    return new Response('Bad key', { status: 400 });
  if (request.method === 'PUT') {
    await env.UPLOADS.put(key, request.body, {
      httpMetadata: { contentType: request.headers.get('Content-Type') ?? undefined },
    });
    return new Response(null, { status: 204 });
  }
  if (request.method === 'DELETE') {
    await env.UPLOADS.delete(key);
    return new Response(null, { status: 204 });
  }
  if (request.method === 'GET') {
    const object = await env.UPLOADS.get(key);
    return object ? new Response(object.body) : new Response('Not found', { status: 404 });
  }
  return new Response('Method not allowed', { status: 405 });
}

// wp_mail from the container, sent from WP_MAIL_FROM through Cloudflare's Email Service.
async function mail(request, env) {
  if (request.method !== 'POST' || !env.EMAIL || !env.WP_MAIL_FROM)
    return new Response('Email isn’t set up: see README.md.', { status: 503 });
  const message = await request.json();
  await env.EMAIL.send({
    from: env.WP_MAIL_FROM,
    to: message.to,
    subject: message.subject,
    ...(message.text ? { text: message.text } : {}),
    ...(message.html ? { html: message.html } : {}),
  });
  return new Response(null, { status: 204 });
}

// WordPress in one container. The container's calls to these hosts come to the Worker, which
// has the bindings: its uploads go to R2 and its email to Cloudflare's Email Service.
export class WordPress extends Container {
  defaultPort = 80;
  sleepAfter = '30m';
  static outboundByHost = {
    'uploads.shipcel.internal': uploads,
    'mail.shipcel.internal': mail,
  };
  async fetch(request) {
    const url = new URL(request.url);
    this.envVars = {
      ...database(this.env.DATABASE_URL),
      ...(await keys(this.env.WP_SECRET)),
      WORDPRESS_CONFIG_EXTRA: settings(url.origin),
    };
    const forwarded = new Request(request);
    forwarded.headers.set('X-Forwarded-Proto', url.protocol.slice(0, -1));
    forwarded.headers.set('X-Forwarded-Host', url.host);
    return super.fetch(forwarded);
  }
}

${unset(['DATABASE_URL', 'WP_SECRET'])}

export default {
  async fetch(request, env) {
    const missing = unset(env);
    if (missing.length) return setFirst(missing);
    const url = new URL(request.url);
    // Uploads come from R2, without waking the container.
    if (url.pathname.startsWith(UPLOADS) && ['GET', 'HEAD'].includes(request.method)) {
      const object = await env.UPLOADS.get(decodeURIComponent(url.pathname.slice(UPLOADS.length)));
      if (!object) return new Response('Not found', { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('ETag', object.httpEtag);
      headers.set('Cache-Control', 'public, max-age=31536000');
      return new Response(request.method === 'HEAD' ? null : object.body, { headers });
    }
    return getContainer(env.WORDPRESS).fetch(request);
  },
};
`;
    files['Dockerfile'] =
      `# WordPress 7.1.4 on PHP 8.4 and Apache: the official image. Its disk is temporary, so
# themes and plugins are part of the image: put them under wp-content/ and deploy again.
FROM wordpress:7.1.4-php8.4-apache
COPY wp-content/mu-plugins/ /usr/src/wordpress/wp-content/mu-plugins/
COPY wp-content/themes/ /usr/src/wordpress/wp-content/themes/
COPY wp-content/plugins/ /usr/src/wordpress/wp-content/plugins/
`;
    files['wp-content/mu-plugins/shipcel.php'] =
      "<?php\n/**\n * Plugin Name: Shipcel on Cloudflare\n * Description: Keeps uploads in R2 and sends email through Cloudflare's Email Service, by way of the Worker in front of this container, whose disk is temporary.\n */\n\nif ( ! defined( 'ABSPATH' ) ) {\n\texit;\n}\n\n/** Where the Worker takes a file under uploads. */\nfunction shipcel_upload_url( $key ) {\n\treturn 'http://uploads.shipcel.internal/' . implode( '/', array_map( 'rawurlencode', explode( '/', $key ) ) );\n}\n\n/** A file's key under the uploads folder, or null for a file outside it. */\nfunction shipcel_upload_key( $path ) {\n\t$base = trailingslashit( wp_get_upload_dir()['basedir'] );\n\tif ( ! is_string( $path ) || 0 !== strpos( $path, $base ) ) {\n\t\treturn null;\n\t}\n\treturn substr( $path, strlen( $base ) );\n}\n\n/** Copies a file WordPress wrote under uploads to R2. */\nfunction shipcel_store( $path ) {\n\t$key = shipcel_upload_key( $path );\n\tif ( null === $key || ! is_readable( $path ) ) {\n\t\treturn;\n\t}\n\t$type = wp_check_filetype( $path )['type'];\n\twp_remote_request(\n\t\tshipcel_upload_url( $key ),\n\t\tarray(\n\t\t\t'method'  => 'PUT',\n\t\t\t'body'    => file_get_contents( $path ),\n\t\t\t'headers' => array( 'Content-Type' => $type ? $type : 'application/octet-stream' ),\n\t\t\t'timeout' => 30,\n\t\t)\n\t);\n}\n\n// An upload, as soon as WordPress has it.\nadd_filter(\n\t'wp_handle_upload',\n\tfunction ( $upload ) {\n\t\tif ( isset( $upload['file'] ) ) {\n\t\t\tshipcel_store( $upload['file'] );\n\t\t}\n\t\treturn $upload;\n\t}\n);\n\n// Every size WordPress makes of an image, and the original it keeps of a scaled one.\nadd_filter(\n\t'wp_generate_attachment_metadata',\n\tfunction ( $metadata, $attachment_id ) {\n\t\t$file = get_attached_file( $attachment_id, true );\n\t\tif ( $file ) {\n\t\t\tshipcel_store( $file );\n\t\t\t$dir = trailingslashit( dirname( $file ) );\n\t\t\tforeach ( isset( $metadata['sizes'] ) ? $metadata['sizes'] : array() as $size ) {\n\t\t\t\tif ( ! empty( $size['file'] ) ) {\n\t\t\t\t\tshipcel_store( $dir . $size['file'] );\n\t\t\t\t}\n\t\t\t}\n\t\t\tif ( ! empty( $metadata['original_image'] ) ) {\n\t\t\t\tshipcel_store( $dir . $metadata['original_image'] );\n\t\t\t}\n\t\t}\n\t\treturn $metadata;\n\t},\n\t10,\n\t2\n);\n\n// A file WordPress deletes from uploads goes from R2 too.\nadd_filter(\n\t'wp_delete_file',\n\tfunction ( $file ) {\n\t\t$key = shipcel_upload_key( $file );\n\t\tif ( null !== $key ) {\n\t\t\twp_remote_request( shipcel_upload_url( $key ), array( 'method' => 'DELETE', 'timeout' => 15 ) );\n\t\t}\n\t\treturn $file;\n\t}\n);\n\n// After a restart the disk is empty again: an attachment WordPress opens, to edit or resize\n// it, comes back from R2 first.\nadd_filter(\n\t'get_attached_file',\n\tfunction ( $file ) {\n\t\t$key = shipcel_upload_key( $file );\n\t\tif ( null === $key || file_exists( $file ) ) {\n\t\t\treturn $file;\n\t\t}\n\t\t$response = wp_remote_get( shipcel_upload_url( $key ), array( 'timeout' => 30 ) );\n\t\tif ( 200 === wp_remote_retrieve_response_code( $response ) ) {\n\t\t\twp_mkdir_p( dirname( $file ) );\n\t\t\tfile_put_contents( $file, wp_remote_retrieve_body( $response ) );\n\t\t}\n\t\treturn $file;\n\t}\n);\n\n// wp_mail, through Cloudflare's Email Service. Attachments aren't sent.\nadd_filter(\n\t'pre_wp_mail',\n\tfunction ( $result, $atts ) {\n\t\t$to       = is_array( $atts['to'] ) ? $atts['to'] : explode( ',', $atts['to'] );\n\t\t$headers  = is_array( $atts['headers'] ) ? implode( \"\\n\", $atts['headers'] ) : (string) $atts['headers'];\n\t\t$format   = false !== stripos( $headers, 'text/html' ) ? 'html' : 'text';\n\t\t$response = wp_remote_post(\n\t\t\t'http://mail.shipcel.internal/send',\n\t\t\tarray(\n\t\t\t\t'headers' => array( 'Content-Type' => 'application/json' ),\n\t\t\t\t'body'    => wp_json_encode(\n\t\t\t\t\tarray(\n\t\t\t\t\t\t'to'      => array_values( array_filter( array_map( 'trim', $to ) ) ),\n\t\t\t\t\t\t'subject' => $atts['subject'],\n\t\t\t\t\t\t$format   => $atts['message'],\n\t\t\t\t\t)\n\t\t\t\t),\n\t\t\t\t'timeout' => 15,\n\t\t\t)\n\t\t);\n\t\t$sent = in_array( wp_remote_retrieve_response_code( $response ), array( 200, 202, 204 ), true );\n\t\tif ( ! $sent ) {\n\t\t\tdo_action( 'wp_mail_failed', new WP_Error( 'wp_mail_failed', 'Cloudflare’s Email Service did not send the message.' ) );\n\t\t}\n\t\treturn $sent;\n\t},\n\t10,\n\t2\n);\n";
    files['wp-content/themes/README.md'] =
      'Put themes here, one folder each (from wordpress.org or your own). They are built into the image on the next deploy; WordPress can’t install them itself, because its disk is temporary.\n';
    files['wp-content/plugins/README.md'] =
      'Put plugins here, one folder each. They are built into the image on the next deploy; WordPress can’t install or update them itself, because its disk is temporary. A plugin that writes its own files outside uploads loses them when the container restarts.\n';
    return files;
  },
  readme: {
    runLocally:
      'Wrangler builds the image and runs it with Docker on your computer. Put `DATABASE_URL` (a MySQL on your computer works) and `WP_SECRET` in a `.dev.vars` file first (it is in `.gitignore`).\n',
    notes: `**Experimental: this kit has not run end to end on Cloudflare yet.** For a site in production today, export WordPress to static files or run it headless (the starter kits guide has both). What the kit does: WordPress 7.1.4 from its official image in one \`basic\` container (1 GiB), its database in a MySQL you host elsewhere, its uploads in an R2 bucket (\`UPLOADS\`), and its email through Cloudflare's Email Service, by way of the Worker, so there are no storage or mail credentials to create.

1. **A MySQL database.** MySQL 8 or MariaDB 10.6 or later, reachable from the internet over TLS (managed MySQL from Aiven, PlanetScale, DigitalOcean or your own server). Copy its connection string: \`mysql://user:password@host:port/database\`.
2. **Deploy it.** Push this folder to GitHub, then run \`shipcel git connect\` in it: Cloudflare's builds make the image and create the bucket. The project can't be Free-only: containers and R2 need Cloudflare's Workers Paid plan ($5 a month).
3. **Its secrets.** In Shipcel (**Manage → Secrets & variables**) or with \`npx wrangler secret put\`: \`DATABASE_URL\`, and \`WP_SECRET\` (a long random string, \`openssl rand -hex 32\`; WordPress's keys and salts come from it, so changing it signs everyone out). For email, onboard your domain for Email Sending in Cloudflare's dashboard and set \`WP_MAIL_FROM\` (for example \`blog@yourdomain.com\`). Until the first two are set, the site answers 503 and starts no container.
4. **Install it.** Open the site's address and finish WordPress's installation at once: until you do, whoever opens it first can.

Themes and plugins go under \`wp-content/themes\` and \`wp-content/plugins\` and are built into the image; installing and updating from the dashboard are off, and updating WordPress means changing the image's tag in the Dockerfile. Uploads go to R2 through WordPress's media functions; a plugin that writes other files loses them when the container restarts. WP-Cron runs when someone visits. Email attachments aren't sent. Awake all month, the container costs about $6.50 beyond what Workers Paid includes, plus CPU and R2 storage; it sleeps after 30 minutes without visitors, and the next visit wakes it in a few seconds. Shipcel's budget guard counts the container and R2 operations, not emails.`,
  },
};
