// Personal defaults that must not live in the public repo, read from Netlify
// environment variables and only served to signed-in visitors.
//
//   GET /api/config -> { defaultSubject }

import { reply, withAuth } from '../lib/common.mjs';

export const config = { path: '/api/config' };

export default withAuth(async () => reply(200, {
  defaultSubject: process.env.DEFAULT_SUBJECT || '',
}));
