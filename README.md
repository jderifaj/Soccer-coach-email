# College Coach Outreach

A small website for writing one recruiting email and sending a personalized copy to each college coach through Gmail.

1. **Write**: type the email once. Buttons insert `[Coach]`, `[Last Name]`, `[First Name]` or `[School]`, which are filled in for each school. To link words, select them and click **Link**. Bold and italic work too, and pasting from Gmail or Google Docs keeps links and tables. A live preview shows exactly what one school will get.
2. **Schools**: tick the schools that should get it. **Edit** a school to fix names, add notes, add or remove assistant coaches (name + email; all of them are CC'd), or delete the school. **Add school** adds a new one.
3. **Send**: each school gets a card with To, CC, subject and message. **Open in Gmail** opens a new Gmail email with To, CC and Subject filled in, and copies the formatted message. She clicks in the message area and presses ⌘V (Ctrl+V on Windows), reads it over, and clicks Send in Gmail. Then **Mark as sent** records the date. (The message goes through the clipboard because Gmail's "new email" link can only carry plain text, which would lose the links.)

Nothing is ever sent from the website itself. Her club coach (set on the Write tab) is CC'd on every email.

## Where things are saved
- **The coach list** (everything from the contact sheet: schools, coaches, emails, assistant coaches, notes and contact dates) is one JSON document, `coaches.json`, stored privately in Netlify Blobs. Every add, edit, delete and "Mark as sent" saves there, so the list is the same on every computer. On the Schools tab, **Download coaches.json** saves a copy and **Upload coaches.json** replaces the whole list (it asks first).
- The list is protected by a password (the `APP_PASSWORD` environment variable in Netlify). It's asked for once per browser; **Lock** forgets it.
- **The email and settings** (subject, message, club coach, Gmail address) stay in her browser. **Download backup** / **Restore backup** at the bottom of the page move them between computers.
- A local copy of the contact sheet as JSON is in `coachList/coaches.json`, which is never committed because the repo is public.

### The API (Netlify Function `netlify/functions/coaches.mjs`)
All requests need the header `x-app-password`.

| Request | Does |
|---|---|
| `GET /api/coaches` | Returns the whole list |
| `PUT /api/coaches` with `{ "coaches": [...] }` | Replaces the whole list |
| `POST /api/coaches` with one school | Adds a school |
| `PUT /api/coaches/<id>` with any fields | Changes one school |
| `DELETE /api/coaches/<id>` | Deletes one school |

A school looks like: `{ "id", "school", "coach", "email", "assistants": [{ "name", "email" }], "questionnaire", "contacts": ["2026-07-06", ...] }`.

## Import a spreadsheet
On the Schools tab, **Import CSV** reads a sheet with columns like University, Coach, Email Address, Assistant Emails, Questionnaire and "… Contact" dates. Schools with the same name are updated; new ones are added.

## Netlify
Live at <https://soccer-coach-email.netlify.app>. The site is connected to this repo: every push to `main` deploys automatically (`netlify.toml` publishes `site/` and the function in `netlify/functions/`). The page is marked `noindex`, so search engines won't list it.

## Try it locally
```
npm install
APP_PASSWORD=local-test-pass npx netlify-cli dev --offline --port 8888
```
Then open <http://localhost:8888> and use `local-test-pass` to unlock. The local copy of the storage is separate from the live one.

## Files
- `site/index.html`, `site/styles.css`, `site/app.js`: the website
- `netlify/functions/coaches.mjs`: the coach list API
- `coachList/`: the original spreadsheet export
- `apps-script/`: the earlier Google Sheets version (no longer needed)
