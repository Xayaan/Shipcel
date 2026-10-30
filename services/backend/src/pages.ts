// The hosted sign-in page. Scripts and styles are served from this origin so the page
// can use a strict Content Security Policy.
import type { Settings } from './store';
import { escapeHtml } from './util';

export const pageHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function page(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${assetPaths.css}">
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`,
    { status, headers: pageHeaders },
  );
}

export function signInPage(
  settings: Settings,
  requestId: string,
  cancelled: boolean,
) {
  const app = escapeHtml(settings.appName);
  const id = escapeHtml(requestId);
  const providers = [
    settings.githubClientId
      ? `<a class="button" href="/oauth/github/start?request=${id}">Continue with GitHub</a>`
      : '',
    settings.googleClientId
      ? `<a class="button" href="/oauth/google/start?request=${id}">Continue with Google</a>`
      : '',
  ].join('');
  return page(
    `Sign in to ${settings.appName}`,
    `<div id="signin" data-request="${id}">
<h1>Sign in to ${app}</h1>
<p class="error" role="alert" id="error"${cancelled ? '' : ' hidden'}>${cancelled ? 'Sign-in was cancelled.' : ''}</p>
<section id="choose">
<button id="passkey" class="primary" type="button">Sign in with a passkey</button>
${providers}
${
  settings.emailFrom
    ? `<form id="email-form" class="email-form" method="post" action="/email/start">
<input type="hidden" name="request" value="${id}">
<label for="email-address">Email</label>
<input id="email-address" name="email" type="email" autocomplete="username" required maxlength="254">
${
  settings.password
    ? `<label for="password">Password <span class="small">(leave it empty to get a sign-in link by email)</span></label>
<input id="password" name="password" type="password" autocomplete="current-password" maxlength="200">`
    : ''
}
<button class="button" type="submit">${settings.password ? 'Continue with email' : 'Email me a sign-in link'}</button>
</form>`
    : ''
}
<p>New here? <button id="show-register" class="link" type="button">Create an account with a passkey</button></p>
</section>
<form id="register" hidden>
<h2>Create an account</h2>
<label for="name">Name</label>
<input id="name" name="name" autocomplete="name" required maxlength="80">
<label for="email">Email (optional)</label>
<input id="email" name="email" type="email" autocomplete="email" maxlength="254">
<button class="primary" type="submit">Create a passkey</button>
<button id="back" class="link" type="button">Back</button>
</form>
<p class="small">A passkey uses your device's fingerprint, face or screen lock, so there is no password to remember or leak.</p>
</div>
<script src="${assetPaths.js}"></script>`,
  );
}

// After a sign-in link was sent (services/backend/src/email.ts).
export const checkEmailPage = (settings: Settings, email: string) =>
  page(
    'Check your email',
    `<h1>Check your email</h1>
<p>We sent a sign-in link for ${escapeHtml(settings.appName)} to <strong>${escapeHtml(email)}</strong>. Open it in this browser within 15 minutes.</p>
<p class="small">Nothing there? Look in spam, or go back to the app and ask for another link.</p>`,
  );

// Sets or changes the signed-in account's password; apps link here from their settings.
export const passwordPage = (settings: Settings, email: string | null) =>
  page(
    'Set a password',
    `<div id="password-set">
<h1>Set a password for ${escapeHtml(settings.appName)}</h1>
<p>${email ? `For <strong>${escapeHtml(email)}</strong>. ` : ''}Next time you can sign in with it, or still ask for a link by email.</p>
<p class="error" role="alert" id="error" hidden></p>
<form id="password-form">
<label for="new-password">New password (10 characters or more)</label>
<input id="new-password" name="password" type="password" autocomplete="new-password" required minlength="10" maxlength="200">
<button class="primary" type="submit">Save password</button>
</form>
<p id="saved" hidden>Saved. You can close this page.</p>
</div>
<script src="${assetPaths.passwordJs}"></script>`,
  );

export const errorPage = (message: string, status: number) =>
  page(
    'Sign-in problem',
    `<h1>Sign-in problem</h1><p class="error" role="alert">${escapeHtml(message)}</p>`,
    status,
  );

// Asks before signing out when the request didn't come from the app with an ID token.
export const logoutPage = (params: {
  target: string | null;
  state: string | null;
}) =>
  page(
    'Sign out',
    `<h1>Sign out?</h1>
<p>You are about to sign out of this app's sign-in service on this device.</p>
<form method="post" action="/logout">
${params.target ? `<input type="hidden" name="post_logout_redirect_uri" value="${escapeHtml(params.target)}">` : ''}
${params.state ? `<input type="hidden" name="state" value="${escapeHtml(params.state.slice(0, 512))}">` : ''}
<button class="primary" type="submit">Sign out</button>
</form>`,
  );

export const signedOutPage = (setCookie: string) => {
  const response = page(
    'Signed out',
    '<h1>You are signed out</h1><p>You can close this page.</p>',
  );
  response.headers.set('Set-Cookie', setCookie);
  return response;
};

export const signInCss = `*{box-sizing:border-box}body{margin:0;background:#f8f9fb;color:#1f2b26;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:420px;margin:48px auto;padding:28px 24px;background:#fff;border:1px solid #e1e7e3;border-radius:14px}h1{font-size:1.5rem;margin:0 0 16px}h2{font-size:1.15rem;margin:8px 0 12px}label{display:block;font-weight:600;margin:12px 0 4px}input{width:100%;padding:10px 12px;border:1px solid #c9d3cd;border-radius:8px;font:inherit}.button,button{display:block;width:100%;margin:10px 0;padding:11px 14px;border-radius:8px;border:1px solid #c9d3cd;background:#fff;color:#143a2e;font:inherit;font-weight:600;text-align:center;text-decoration:none;cursor:pointer}.primary{background:#1d5140;border-color:#1d5140;color:#fff}.link{display:inline;width:auto;margin:0;padding:0;border:0;background:none;color:#1d5140;text-decoration:underline}.error{background:#fff4f2;border:1px solid #f1c7bf;border-radius:8px;padding:10px 12px;color:#8a2a17}.small{color:#56625a;font-size:.875rem}:focus-visible{outline:3px solid #4c8f6f;outline-offset:2px}`;

export const signInJs = `(() => {
  const root = document.getElementById('signin');
  const request = root.dataset.request;
  const error = document.getElementById('error');
  const show = (message) => { error.textContent = message; error.hidden = false; };
  const enc = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  const dec = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)), (c) => c.charCodeAt(0));
  async function post(path, body) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error_description || 'Something went wrong. Try again.');
    return data;
  }
  const failed = (e) => show(e && e.name === 'NotAllowedError' ? 'The passkey request was cancelled or timed out.' : (e && e.message) || 'Something went wrong. Try again.');
  if (!window.PublicKeyCredential) show('This browser does not support passkeys. Use another sign-in option or another browser.');
  document.getElementById('passkey').addEventListener('click', async () => {
    try {
      const options = await post('/passkeys/login/options', { request });
      const credential = await navigator.credentials.get({ publicKey: { ...options.publicKey, challenge: dec(options.publicKey.challenge) } });
      const r = credential.response;
      const result = await post('/passkeys/login/verify', { request, challengeId: options.challengeId, credential: { rawId: enc(credential.rawId), type: credential.type, response: { clientDataJSON: enc(r.clientDataJSON), authenticatorData: enc(r.authenticatorData), signature: enc(r.signature), userHandle: r.userHandle ? enc(r.userHandle) : null } } });
      location.assign(result.redirect);
    } catch (e) { failed(e); }
  });
  const form = document.getElementById('register');
  const choose = document.getElementById('choose');
  document.getElementById('show-register').addEventListener('click', () => { choose.hidden = true; form.hidden = false; document.getElementById('name').focus(); });
  document.getElementById('back').addEventListener('click', () => { form.hidden = true; choose.hidden = false; });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const options = await post('/passkeys/register/options', { request, name: form.name.value, email: form.email.value || undefined });
      const pk = options.publicKey;
      const credential = await navigator.credentials.create({ publicKey: { ...pk, challenge: dec(pk.challenge), user: { ...pk.user, id: dec(pk.user.id) } } });
      const r = credential.response;
      const result = await post('/passkeys/register/verify', { request, challengeId: options.challengeId, credential: { rawId: enc(credential.rawId), type: credential.type, response: { clientDataJSON: enc(r.clientDataJSON), attestationObject: enc(r.attestationObject) } } });
      location.assign(result.redirect);
    } catch (e) { failed(e); }
  });
  // With a password typed, the email form signs in at once instead of sending a link.
  const emailForm = document.getElementById('email-form');
  if (emailForm && emailForm.password) emailForm.addEventListener('submit', async (event) => {
    if (!emailForm.password.value) return;
    event.preventDefault();
    try {
      const result = await post('/password/login', { request, email: emailForm.email.value, password: emailForm.password.value });
      location.assign(result.redirect);
    } catch (e) { failed(e); }
  });
})();
`;

export const passwordJs = `(() => {
  const form = document.getElementById('password-form');
  const error = document.getElementById('error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    const response = await fetch('/password/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: form.password.value }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { error.textContent = data.error_description || 'Something went wrong. Try again.'; error.hidden = false; return; }
    form.hidden = true;
    document.getElementById('saved').hidden = false;
  });
})();
`;

// A short content hash in each address: a changed file gets a new address, so browsers can
// keep every version for good and returning visitors don't spend requests on them.
function fingerprint(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(36);
}
export const assetPaths = {
  css: `/assets/sign-in.${fingerprint(signInCss)}.css`,
  js: `/assets/sign-in.${fingerprint(signInJs)}.js`,
  passwordJs: `/assets/password.${fingerprint(passwordJs)}.js`,
};
export const assetHeaders = {
  'Cache-Control': 'public, max-age=31536000, immutable',
};
