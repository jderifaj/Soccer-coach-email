// Coach list API, stored as one JSON document ("coaches.json") in Netlify Blobs.
//
//   GET    /api/coaches        -> the whole list
//   PUT    /api/coaches        -> replace the whole list   body: { coaches: [...] }
//   POST   /api/coaches        -> add one school           body: { school, coach, ... }
//   PUT    /api/coaches/:id    -> change one school        body: any coach fields
//   DELETE /api/coaches/:id    -> delete one school
//
// Every request needs the header `x-app-password` matching the APP_PASSWORD
// environment variable set in Netlify. Every change returns the full list.

import { getStore } from '@netlify/blobs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

const KEY = 'coaches.json';
const MAX_BODY = 1_000_000;
const MAX_COACHES = 2000;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const config = { path: ['/api/coaches', '/api/coaches/:id'] };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function reply(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });
}

function passwordOk(req) {
  const expected = process.env.APP_PASSWORD || '';
  if (!expected) throw new HttpError(500, 'The site password (APP_PASSWORD) is not set up in Netlify yet.');
  const given = req.headers.get('x-app-password') || '';
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);

function splitEmails(s) {
  return String(s || '').split(/[\s,;]+/).filter(Boolean);
}

/** Assistant coaches as [{ name, email }]. Also accepts the older format,
 *  a comma-separated string of emails. */
export function cleanAssistants(value, school) {
  const list = Array.isArray(value)
    ? value.map((a) => (typeof a === 'string' ? { name: '', email: a } : a || {}))
    : splitEmails(value).map((email) => ({ name: '', email }));
  const seen = new Set();
  const out = [];
  for (const a of list.slice(0, 20)) {
    const name = str(a.name, 200);
    const email = str(a.email, 254);
    if (!name && !email) continue;
    if (!EMAIL_RE.test(email)) {
      throw new HttpError(400, `The email for assistant coach ${name || email || ''} at ${school} doesn't look right.`.replace('  ', ' '));
    }
    if (seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push({ name, email });
  }
  return out;
}

/** Checks and tidies one school. `existing` is the stored version when editing. */
export function cleanCoach(input, existing) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Expected a school.');
  const base = existing || { id: randomUUID(), school: '', coach: '', email: '', assistants: [], questionnaire: '', contacts: [] };
  const pick = (k, max) => (k in input ? str(input[k], max) : base[k]);
  const out = {
    id: base.id,
    school: pick('school', 200),
    coach: pick('coach', 200),
    email: pick('email', 254),
    assistants: base.assistants,
    questionnaire: pick('questionnaire', 500),
    contacts: base.contacts,
  };
  if ('contacts' in input) {
    if (!Array.isArray(input.contacts)) throw new HttpError(400, 'Contact dates must be a list.');
    out.contacts = Array.from(new Set(input.contacts.map(String).filter((d) => DATE_RE.test(d)))).sort().slice(-500);
  }
  if (!out.school) throw new HttpError(400, 'Every school needs a name.');
  if (out.email && !EMAIL_RE.test(out.email)) throw new HttpError(400, `The email for ${out.school} doesn't look right.`);
  out.assistants = cleanAssistants('assistants' in input ? input.assistants : base.assistants, out.school);
  return out;
}

function cleanList(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'Expected { "coaches": [ ... ] }.');
  if (list.length > MAX_COACHES) throw new HttpError(400, `That's more than ${MAX_COACHES} schools.`);
  const seen = new Set();
  return list.map((c) => {
    const keepId = c && typeof c.id === 'string' && /^[\w-]{1,64}$/.test(c.id) && !seen.has(c.id);
    const clean = cleanCoach(c, keepId ? { id: c.id, school: '', coach: '', email: '', assistants: [], questionnaire: '', contacts: [] } : undefined);
    seen.add(clean.id);
    return clean;
  });
}

const emptyDoc = () => ({ version: 1, updatedAt: null, coaches: [] });
const sortCoaches = (list) => list.sort((a, b) => a.school.localeCompare(b.school));

/** Read, change and write back, retrying if someone else saved in between. */
async function mutate(store, change) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await store.getWithMetadata(KEY, { type: 'json' });
    const doc = current?.data && Array.isArray(current.data.coaches) ? current.data : emptyDoc();
    const result = change(doc);
    doc.version = 1;
    doc.updatedAt = new Date().toISOString();
    sortCoaches(doc.coaches);
    const write = await store.setJSON(KEY, doc, current ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
    if (write.modified) return { doc, result };
  }
  throw new HttpError(409, 'Someone else saved at the same moment. Please try again.');
}

async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'That file is too big.');
  try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'That isn\'t valid JSON.'); }
}

export default async (req, context) => {
  try {
    if (!passwordOk(req)) return reply(401, { error: 'Wrong password.' });
    const store = getStore({ name: 'coach-outreach', consistency: 'strong' });
    const id = context.params?.id;

    if (!id && req.method === 'GET') {
      const current = await store.get(KEY, { type: 'json' });
      return reply(200, current && Array.isArray(current.coaches) ? current : emptyDoc());
    }
    if (!id && req.method === 'PUT') {
      const body = await readBody(req);
      const coaches = cleanList(body.coaches);
      const { doc } = await mutate(store, (d) => { d.coaches = coaches; });
      return reply(200, doc);
    }
    if (!id && req.method === 'POST') {
      const coach = cleanCoach(await readBody(req));
      const { doc } = await mutate(store, (d) => {
        if (d.coaches.length >= MAX_COACHES) throw new HttpError(400, 'The list is full.');
        d.coaches.push(coach);
      });
      return reply(201, { ...doc, changed: coach.id });
    }
    if (id && (req.method === 'PUT' || req.method === 'PATCH')) {
      const body = await readBody(req);
      const { doc } = await mutate(store, (d) => {
        const i = d.coaches.findIndex((c) => c.id === id);
        if (i < 0) throw new HttpError(410, 'That school isn\'t in the list anymore.');
        d.coaches[i] = cleanCoach(body, d.coaches[i]);
      });
      return reply(200, { ...doc, changed: id });
    }
    if (id && req.method === 'DELETE') {
      const { doc } = await mutate(store, (d) => {
        const before = d.coaches.length;
        d.coaches = d.coaches.filter((c) => c.id !== id);
        if (d.coaches.length === before) throw new HttpError(410, 'That school isn\'t in the list anymore.');
      });
      return reply(200, doc);
    }
    return reply(405, { error: 'Not supported.' }, { allow: 'GET, PUT, POST, DELETE' });
  } catch (err) {
    if (err instanceof HttpError) return reply(err.status, { error: err.message });
    console.error(err);
    return reply(500, { error: 'Something went wrong on the server. Please try again.' });
  }
};
