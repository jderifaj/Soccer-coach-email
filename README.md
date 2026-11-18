# Coach Outreach

A small website for writing one recruiting email and sending a personalized copy to each college coach through Gmail.

1. **Write**: type the email once. Buttons insert `[Coach]`, `[Last Name]`, `[First Name]` or `[School]`, which are filled in for each school. To link words, select them and click **Link**. Bold and italic work too, and pasting from Gmail or Google Docs keeps links and tables. A live preview shows exactly what one school will get.
2. **Schools**: tick the schools that should get it. Edit a school to fix a name or add assistant coaches (they're CC'd).
3. **Send**: each school gets a card with To, CC, subject and message. **Open in Gmail** opens a new Gmail email with To, CC and Subject filled in, and copies the formatted message. She clicks in the message area and presses ⌘V (Ctrl+V on Windows), reads it over, and clicks Send in Gmail. Then **Mark as sent** records the date. (The message goes through the clipboard because Gmail's "new email" link can only carry plain text, which would lose the links.)

Nothing is ever sent from the website itself. Her club coach (set on the Write tab) is CC'd on every email.

## Where things are saved
Everything she types (the email, edits to the list, sent dates) is saved **in her browser** on that computer. Use **Download backup** at the bottom of the page now and then. **Restore backup** brings it back on another computer or after clearing the browser.

The website itself contains only the coach directory (`site/coaches.js`). Her email text and contact history are not in it.

## Bring in her contact history (optional, once)
On the Schools tab, click **Import CSV** and choose `coachList/College Contacts Sheet - Sheet1.csv`. Each school's past contact dates appear ("Last Jul 6 · 8×"). Importing updates schools with the same name and adds any new ones.

## Put it on Netlify
The site is the `site/` folder. There's no build step.

- **Quickest:** go to <https://app.netlify.com/drop> and drag the `site` folder onto the page.
- **Or with the command line:** `npx netlify-cli deploy --dir site --prod` (it asks you to log in the first time).

`netlify.toml` already points Netlify at `site/`. The page is marked `noindex`, so search engines won't list it.

## Try it locally
```
cd site && python3 -m http.server 8787
```
Then open <http://127.0.0.1:8787>.

## Files
- `site/index.html`, `site/styles.css`, `site/app.js`: the website
- `site/coaches.js`: the starting coach list, loaded the first time the page opens
- `coachList/`: the original spreadsheet export
- `apps-script/`: the earlier Google Sheets version (no longer needed)
