// Shared helpers for the site's API functions (coaches, templates).
// Lives outside netlify/functions so it isn't deployed as a function itself.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const STORE_NAME = 'coach-outreach';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function reply(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });
}

const sameBytes = (x, y) => {
  const a = createHash('sha256').update(String(x)).digest();
  const b = createHash('sha256').update(String(y)).digest();
  return timingSafeEqual(a, b);
};

/** The sign-in cookie set by the site's gate (netlify/edge-functions/gate.js). */
function sessionOk(req, password) {
  const cookie = (req.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith('coach_session='));
  if (!cookie) return false;
  const [expires, sig] = decodeURIComponent(cookie.slice('coach_session='.length)).split('.');
  if (!expires || !sig || !(Number(expires) > Date.now() / 1000)) return false;
  const good = createHmac('sha256', password).update('coach-session:' + expires).digest('base64url');
  return sameBytes(sig, good);
}

/** Signed in through the site, or the x-app-password header matches APP_PASSWORD. */
export function passwordOk(req) {
  const expected = process.env.APP_PASSWORD || '';
  if (!expected) throw new HttpError(500, 'The site password (APP_PASSWORD) is not set up in Netlify yet.');
  if (sessionOk(req, expected)) return true;
  return sameBytes(req.headers.get('x-app-password') || '', expected);
}

export const str = (v, max) => String(v ?? '').trim().slice(0, max);

export async function readBody(req, maxBytes = 1_000_000) {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'That is too big to save.');
  try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'That isn\'t valid JSON.'); }
}

/**
 * Read a JSON document, change it, and write it back, retrying if someone
 * else saved in between (so two people saving at once can't undo each other).
 *   isValid(data)  -> whether stored data has the expected shape
 *   change(doc)    -> edits doc in place (may throw HttpError)
 *   finish(doc)    -> optional tidy-up before writing (sorting etc.)
 */
export async function mutateDoc(store, key, { empty, isValid, change, finish }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await store.getWithMetadata(key, { type: 'json' });
    const doc = current?.data && isValid(current.data) ? current.data : empty();
    const result = change(doc);
    doc.version = 1;
    doc.updatedAt = new Date().toISOString();
    if (finish) finish(doc);
    const write = await store.setJSON(key, doc, current ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
    if (write.modified) return { doc, result };
  }
  throw new HttpError(409, 'Someone else saved at the same moment. Please try again.');
}

/** Wraps a handler: checks the password and turns errors into JSON replies. */
export function withAuth(handler) {
  return async (req, context) => {
    try {
      if (!passwordOk(req)) return reply(401, { error: 'Wrong password.' });
      return await handler(req, context);
    } catch (err) {
      if (err instanceof HttpError) return reply(err.status, { error: err.message });
      console.error(err);
      return reply(500, { error: 'Something went wrong on the server. Please try again.' });
    }
  };
}
