// Password gate for the whole site. Runs on Netlify's edge before anything is
// served: without a valid sign-in cookie, visitors only ever get the sign-in
// page below (no app code, no data). The cookie is signed with APP_PASSWORD,
// so changing the password signs everyone out.
//
//   POST /login   form field "password"  -> sets the cookie, back to the page
//   GET  /logout                         -> clears the cookie

const COOKIE = 'coach_session';
const MAX_AGE = 60 * 60 * 24 * 180; // stay signed in for 180 days
const enc = new TextEncoder();

export const config = { path: '/*' };

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(key, message) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
}

async function sha256(text) {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function makeToken(password) {
  const expires = Math.floor(Date.now() / 1000) + MAX_AGE;
  return expires + '.' + await hmac(password, 'coach-session:' + expires);
}

async function tokenOk(token, password) {
  const [expires, sig] = String(token || '').split('.');
  if (!expires || !sig || !(Number(expires) > Date.now() / 1000)) return false;
  return sameText(sig, await hmac(password, 'coach-session:' + expires));
}

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  const hit = header.split(/;\s*/).find((c) => c.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}

/** Only allow going back to a page on this site. */
function safeNext(value) {
  const v = String(value || '/');
  return v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/login') ? v : '/';
}

const PRIVATE_HEADERS = {
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
};

function signInPage(next, error, status = 401) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in · College Coach Outreach</title>
<style>
  :root { --navy:#00416B; --red:#AB0033; --gold:#B4A269; --bg:#f3f6f9; --ink:#13202c; --muted:#586776; --line:#d5dde6; --card:#fff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0c1520; --ink:#e5ecf3; --muted:#9badbf; --line:#253649; --card:#14202d; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; grid-template-rows:auto 1fr; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { background:var(--navy); color:#fff; border-bottom:3px solid var(--red); padding:14px max(16px,2rem); font:700 20px/1.2 "Arial Narrow",system-ui,sans-serif; letter-spacing:.06em; text-transform:uppercase; }
  main { display:grid; place-items:start center; padding:12vh 16px 40px; }
  form { width:min(400px,100%); background:var(--card); border:1px solid var(--line); border-top:4px solid var(--gold); border-radius:12px; padding:24px; display:grid; gap:14px; }
  h1 { margin:0; font-size:22px; }
  p { margin:0; color:var(--muted); font-size:14px; }
  label { font-weight:600; font-size:14px; }
  input { width:100%; font:inherit; padding:11px 12px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--ink); }
  input:focus { outline:2px solid #2c6fa4; border-color:transparent; }
  button { font:600 15px/1 system-ui,sans-serif; background:var(--navy); color:#fff; border:0; border-radius:8px; padding:12px; cursor:pointer; }
  button:hover { filter:brightness(1.1); }
  .error { color:var(--red); font-weight:600; }
  @media (prefers-color-scheme: dark) { .error { color:#ff7d97; } }
</style></head>
<body>
<header>College Coach Outreach</header>
<main>
  <form method="post" action="/login">
    <h1>Sign in</h1>
    <p>Enter the password to open this site. You'll stay signed in on this browser.</p>
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
    <div style="display:grid;gap:6px">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    </div>
    <input type="hidden" name="next" value="${esc(next)}">
    <button type="submit">Sign in</button>
  </form>
</main>
</body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS } });
}

export default async (request, context) => {
  const password = Netlify.env.get('APP_PASSWORD') || '';
  if (!password) {
    return new Response('This site is not set up yet (APP_PASSWORD is missing).', { status: 500, headers: PRIVATE_HEADERS });
  }
  const url = new URL(request.url);

  if (url.pathname === '/logout') {
    return new Response(null, {
      status: 303,
      headers: { location: '/', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`, ...PRIVATE_HEADERS },
    });
  }

  if (url.pathname === '/login' && request.method === 'POST') {
    const form = await request.formData().catch(() => null);
    const given = String(form?.get('password') || '');
    const next = safeNext(form?.get('next'));
    if (!sameText(await sha256(given), await sha256(password))) {
      await new Promise((r) => setTimeout(r, 600)); // slow down guessing
      return signInPage(next, 'That password didn\'t work. Try again.');
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: next,
        'set-cookie': `${COOKIE}=${encodeURIComponent(await makeToken(password))}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
        ...PRIVATE_HEADERS,
      },
    });
  }

  // Scripts may call the API with the password in a header instead of signing in.
  const headerOk = url.pathname.startsWith('/api/') &&
    sameText(await sha256(request.headers.get('x-app-password') || ''), await sha256(password));

  if (headerOk || await tokenOk(readCookie(request, COOKIE), password)) {
    const response = await context.next();
    // Signed-in pages must never be stored by shared caches.
    response.headers.set('cache-control', 'private, no-cache');
    response.headers.set('x-robots-tag', 'noindex, nofollow');
    return response;
  }

  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Please sign in again.' }), {
      status: 401, headers: { 'content-type': 'application/json', ...PRIVATE_HEADERS },
    });
  }
  return signInPage(url.pathname === '/login' ? '/' : url.pathname + url.search);
};
