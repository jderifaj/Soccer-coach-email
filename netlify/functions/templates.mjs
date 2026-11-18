// Saved email templates, stored as one JSON document ("templates.json") in
// Netlify Blobs, newest-used first.
//
//   GET    /api/templates        -> all templates
//   POST   /api/templates        -> save an email as a template; if the same
//                                   subject + message is already saved, just
//                                   marks it as used now.  body: { subject, bodyHtml, name? }
//   PUT    /api/templates/:id    -> rename / edit / mark used  body: { name?, subject?, bodyHtml?, used?: true }
//   DELETE /api/templates/:id    -> delete one
//
// Needs the same x-app-password header as the coach list.

import { getStore } from '@netlify/blobs';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError, STORE_NAME, mutateDoc, readBody, reply, str, withAuth } from '../lib/common.mjs';

const KEY = 'templates.json';
const MAX_TEMPLATES = 30;
const MAX_HTML = 200_000;

export const config = { path: ['/api/templates', '/api/templates/:id'] };

const emptyDoc = () => ({ version: 1, updatedAt: null, templates: [] });

/** Same subject + message = same template (ignores spacing differences). */
const fingerprint = (subject, html) => createHash('sha256')
  .update(String(subject).replace(/\s+/g, ' ').trim() + '\n' + String(html).replace(/\s+/g, ' ').trim())
  .digest('hex');

function cleanFields(input, base) {
  const out = { ...base };
  if ('name' in input) out.name = str(input.name, 80);
  if ('subject' in input) out.subject = str(input.subject, 300);
  if ('bodyHtml' in input) {
    const html = String(input.bodyHtml ?? '');
    if (html.length > MAX_HTML) throw new HttpError(413, 'That message is too long to save as a template.');
    out.bodyHtml = html;
  }
  if (!out.subject && !String(out.bodyHtml || '').replace(/<[^>]*>/g, '').trim()) {
    throw new HttpError(400, 'An empty email can\'t be saved as a template.');
  }
  out.fingerprint = fingerprint(out.subject, out.bodyHtml);
  return out;
}

const mutate = (store, change) => mutateDoc(store, KEY, {
  empty: emptyDoc,
  isValid: (d) => Array.isArray(d.templates),
  change,
  finish: (d) => {
    d.templates.sort((a, b) => String(b.lastUsed).localeCompare(String(a.lastUsed)));
    d.templates = d.templates.slice(0, MAX_TEMPLATES); // drop the least recently used
  },
});

export default withAuth(async (req, context) => {
  const store = getStore({ name: STORE_NAME, consistency: 'strong' });
  const id = context.params?.id;
  const now = new Date().toISOString();

  if (!id && req.method === 'GET') {
    const current = await store.get(KEY, { type: 'json' });
    return reply(200, current && Array.isArray(current.templates) ? current : emptyDoc());
  }

  if (!id && req.method === 'POST') {
    const body = await readBody(req, MAX_HTML + 10_000);
    const fresh = cleanFields(body, { id: randomUUID(), name: '', subject: '', bodyHtml: '', createdAt: now });
    const { doc, result } = await mutate(store, (d) => {
      const same = d.templates.find((t) => t.fingerprint === fresh.fingerprint);
      if (same) {
        same.lastUsed = now;
        if (fresh.name) same.name = fresh.name;
        return same.id;
      }
      d.templates.push({ ...fresh, lastUsed: now });
      return fresh.id;
    });
    return reply(200, { ...doc, changed: result });
  }

  if (id && (req.method === 'PUT' || req.method === 'PATCH')) {
    const body = await readBody(req, MAX_HTML + 10_000);
    const { doc } = await mutate(store, (d) => {
      const i = d.templates.findIndex((t) => t.id === id);
      if (i < 0) throw new HttpError(410, 'That template isn\'t saved anymore.');
      d.templates[i] = cleanFields(body, d.templates[i]);
      if (body.used) d.templates[i].lastUsed = now;
    });
    return reply(200, { ...doc, changed: id });
  }

  if (id && req.method === 'DELETE') {
    const { doc } = await mutate(store, (d) => {
      const before = d.templates.length;
      d.templates = d.templates.filter((t) => t.id !== id);
      if (d.templates.length === before) throw new HttpError(410, 'That template isn\'t saved anymore.');
    });
    return reply(200, doc);
  }

  return reply(405, { error: 'Not supported.' }, { allow: 'GET, POST, PUT, DELETE' });
});
