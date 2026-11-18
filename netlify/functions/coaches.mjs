// Coach list API, stored as one JSON document ("coaches.json") in Netlify Blobs.
//
//   GET    /api/coaches        -> the whole list
//   PUT    /api/coaches        -> replace the whole list   body: { coaches: [...], top?: [ids] }
//                                  or reorder                body: { order: [ids], top: [ids] }
//   POST   /api/coaches        -> add one school           body: { school, coach, ... }
//   PUT    /api/coaches/:id    -> change one school        body: any coach fields
//   DELETE /api/coaches/:id    -> delete one school
//
// Every request needs the header `x-app-password` matching the APP_PASSWORD
// environment variable set in Netlify. Every change returns the full list.

import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';
import { HttpError, STORE_NAME, mutateDoc, readBody, reply, str, withAuth } from '../lib/common.mjs';

const KEY = 'coaches.json';
const MAX_COACHES = 2000;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const config = { path: ['/api/coaches', '/api/coaches/:id'] };


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

const emptyDoc = () => ({ version: 1, updatedAt: null, coaches: [], top: [] });
const MAX_TOP = 3;

// The list keeps whatever order it is dragged into. "top" holds up to three
// school ids, in order, shown above the rest as the Top 3.
const STARTING_TOP = [/north carolina state|\bnc state\b/i, /davidson/i, /\belon\b/i];

/** Makes sure doc.top is a clean list of ids that exist (seeded the first time). */
function tidyTop(d) {
  if (!Array.isArray(d.top)) {
    d.top = STARTING_TOP.map((re) => d.coaches.find((c) => re.test(c.school))).filter(Boolean).map((c) => c.id);
  }
  const ids = new Set(d.coaches.map((c) => c.id));
  d.top = Array.from(new Set(d.top.filter((id) => typeof id === 'string' && ids.has(id)))).slice(0, MAX_TOP);
  return d;
}

/** New schools go into their alphabetical spot. */
function insertAlphabetically(list, coach) {
  const i = list.findIndex((c) => c.school.localeCompare(coach.school, undefined, { sensitivity: 'base' }) > 0);
  if (i < 0) list.push(coach); else list.splice(i, 0, coach);
}

/** Puts the list in the given id order (ids not mentioned keep their place at the end). */
function reorder(d, order) {
  if (!Array.isArray(order)) throw new HttpError(400, 'Expected { "order": [ ids ] }.');
  const byId = new Map(d.coaches.map((c) => [c.id, c]));
  const out = [];
  for (const id of order) {
    const c = byId.get(id);
    if (c) { out.push(c); byId.delete(id); }
  }
  d.coaches = out.concat(Array.from(byId.values()));
}

const mutate = (store, change) => mutateDoc(store, KEY, {
  empty: emptyDoc,
  isValid: (d) => Array.isArray(d.coaches),
  change,
  finish: tidyTop,
});

export default withAuth(async (req, context) => {
    const store = getStore({ name: STORE_NAME, consistency: 'strong' });
    const id = context.params?.id;

    if (!id && req.method === 'GET') {
      const current = await store.get(KEY, { type: 'json' });
      return reply(200, tidyTop(current && Array.isArray(current.coaches) ? current : emptyDoc()));
    }
    if (!id && req.method === 'PUT') {
      const body = await readBody(req);
      if ('order' in body) {
        const { doc } = await mutate(store, (d) => {
          tidyTop(d);
          reorder(d, body.order);
          if ('top' in body) {
            if (!Array.isArray(body.top)) throw new HttpError(400, 'Expected "top" to be a list.');
            d.top = body.top;
          }
        });
        return reply(200, doc);
      }
      const coaches = cleanList(body.coaches);
      const { doc } = await mutate(store, (d) => {
        tidyTop(d);
        d.coaches = coaches;
        if (Array.isArray(body.top)) d.top = body.top;
      });
      return reply(200, doc);
    }
    if (!id && req.method === 'POST') {
      const coach = cleanCoach(await readBody(req));
      const { doc } = await mutate(store, (d) => {
        if (d.coaches.length >= MAX_COACHES) throw new HttpError(400, 'The list is full.');
        insertAlphabetically(d.coaches, coach);
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
});
