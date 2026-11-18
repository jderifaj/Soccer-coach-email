/**
 * Recruiting Email: turns one Gmail "[TEMPLATE]" draft into one personalized
 * draft per checked school in the Coaches tab. Nothing is ever sent.
 *
 * Placeholders usable in the template subject and body:
 *   {{Coach}}      -> "Coach <Last name>"
 *   {{FirstName}}  -> head coach first name
 *   {{LastName}}   -> head coach last name
 *   {{School}}     -> school name
 */

const COACHES_SHEET = 'Coaches';
const SETTINGS_SHEET = 'Settings';
const DEFAULT_PREFIX = '[TEMPLATE]';

// Normalized header name -> field key. Headers are matched ignoring case,
// spaces and punctuation, so "Send?", "send" and "SEND" all work. Several
// spellings are accepted so an existing contact sheet works as-is.
const HEADERS = {
  send: 'send',
  school: 'school', university: 'school', college: 'school',
  coach: 'full', headcoach: 'full', coachname: 'full', headcoachname: 'full',
  headcoachfirst: 'first', firstname: 'first',
  headcoachlast: 'last', lastname: 'last',
  email: 'email', emailaddress: 'email', headcoachemail: 'email', coachemail: 'email',
  assistantemails: 'assistants', assistants: 'assistants', assistantcoachemails: 'assistants', cc: 'assistants',
  status: 'status', draftstatus: 'status',
};
const FIELD_LABELS = {
  send: 'Send?', school: 'University', full: 'Coach', email: 'Email Address',
  assistants: 'Assistant Emails', status: 'Status',
};

// Two placeholder styles are accepted:
//   {{LastName}}  - any {{...}} that isn't recognized is reported as a typo.
//   [Last Name]   - only the recognized names below are replaced; other
//                   bracketed text is left alone.
// Names ignore case and spaces, and College/University mean the same as School.
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z ]*?)\s*\}\}/g;
const BRACKET_RE = /\[\s*((?:first|last)(?:\s|&nbsp;)*name|coach|school|college|university)\s*\]/gi;
const PLACEHOLDER_KEYS = {
  coach: 'coach', firstname: 'firstname', lastname: 'lastname',
  school: 'school', college: 'school', university: 'school',
};
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

// ---------------------------------------------------------------- menu

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Recruiting Email')
    .addItem('Create drafts for checked schools', 'createDrafts')
    .addItem('Preview first checked school', 'previewFirst')
    .addSeparator()
    .addItem('Check placeholders in template', 'checkPlaceholders')
    .addItem('Set up sheet (add missing columns)', 'setupSheet')
    .addToUi();
}

/**
 * Adds whatever the script needs that the coach sheet doesn't have yet:
 * a "Send?" checkbox column, an "Assistant Emails" column, a "Status" column
 * and a Settings tab. Existing data is not changed.
 */
function setupSheet() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  const sheet = getCoachSheet_();
  const added = [];

  const findCol = (field) => {
    const header = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
    const i = header.findIndex((h) => HEADERS[normalize_(h)] === field);
    return i === -1 ? 0 : i + 1;
  };
  const lastDataRow = () => Math.max(sheet.getLastRow(), 2);

  if (!findCol('send')) {
    sheet.insertColumnBefore(1);
    sheet.getRange(1, 1).setValue('Send?').setFontWeight('bold');
    sheet.getRange(2, 1, lastDataRow() - 1, 1).insertCheckboxes();
    added.push('"Send?" checkboxes (column A)');
  } else {
    // Column exists (e.g. from a CSV import) but may hold plain TRUE/FALSE.
    const sendCol = findCol('send');
    const range = sheet.getRange(2, sendCol, lastDataRow() - 1, 1);
    if (!range.getDataValidations().every((r) => r[0] && r[0].getCriteriaType() === SpreadsheetApp.DataValidationCriteria.CHECKBOX)) {
      const vals = range.getValues().map((r) => [r[0] === true || String(r[0]).toUpperCase() === 'TRUE']);
      range.insertCheckboxes().setValues(vals);
      added.push('checkboxes in the "Send?" column');
    }
  }

  if (!findCol('assistants')) {
    const emailCol = findCol('email');
    const at = emailCol || sheet.getLastColumn();
    sheet.insertColumnAfter(at);
    sheet.getRange(1, at + 1).setValue('Assistant Emails').setFontWeight('bold');
    added.push('"Assistant Emails" (next to the coach email)');
  }

  if (!findCol('status')) {
    const at = sheet.getLastColumn() + 1;
    sheet.getRange(1, at).setValue('Status').setFontWeight('bold');
    added.push('"Status" (last column)');
  }

  if (!ss.getSheetByName(SETTINGS_SHEET)) {
    const st = ss.insertSheet(SETTINGS_SHEET);
    st.getRange(1, 1, 2, 2).setValues([['Club Coach Email', ''], ['Template Prefix', DEFAULT_PREFIX]]);
    st.getRange(1, 1, 2, 1).setFontWeight('bold');
    st.autoResizeColumn(1);
    added.push('a "Settings" tab (fill in your club coach\'s email there)');
  }

  ui.alert(
    'Sheet setup',
    added.length ? 'Added:\n\n' + added.map((a) => '• ' + a).join('\n') : 'Everything is already set up.',
    ui.ButtonSet.OK
  );
}

// ---------------------------------------------------------------- actions

function createDrafts() {
  const ui = SpreadsheetApp.getUi();
  const settings = getSettings_();
  const template = getTemplateDraft_(settings.prefix);
  if (!template) return;

  const sheetData = getRows_();
  const checked = sheetData.rows.filter((r) => r.send);
  if (checked.length === 0) {
    ui.alert('No schools are checked. Tick the "Send?" box for the schools you want, then try again.');
    return;
  }

  // Ask once about rows that already have a draft.
  const already = checked.filter((r) => /^draft created/i.test(r.status));
  let toProcess = checked;
  if (already.length > 0) {
    const answer = ui.alert(
      'Some drafts already exist',
      already.length + ' checked school(s) already have a draft:\n\n' +
        already.map((r) => '• ' + r.school).join('\n') +
        '\n\nCreate another draft for them anyway?\n(Yes = create again, No = skip them)',
      ui.ButtonSet.YES_NO_CANCEL
    );
    if (answer === ui.Button.CANCEL || answer === ui.Button.CLOSE) return;
    if (answer === ui.Button.NO) toProcess = checked.filter((r) => already.indexOf(r) === -1);
  }

  // Build every email first so problems are reported before anything is created.
  const built = [];
  const errors = [];
  toProcess.forEach((row) => {
    try {
      built.push({ row: row, email: buildEmail_(template, row, settings) });
    } catch (e) {
      errors.push(row.school + ' (row ' + row.rowNumber + '): ' + e.message);
    }
  });

  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const stamp = 'Draft created ' + Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');
  const created = [];

  built.forEach((item) => {
    const m = item.email;
    try {
      GmailApp.createDraft(m.to, m.subject, m.plainBody, {
        htmlBody: m.htmlBody,
        cc: m.cc.join(','),
        attachments: template.attachments,
        inlineImages: template.inlineImages,
      });
      sheetData.sheet.getRange(item.row.rowNumber, sheetData.cols.status).setValue(stamp);
      sheetData.sheet.getRange(item.row.rowNumber, sheetData.cols.send).setValue(false);
      created.push(item.row.school);
    } catch (e) {
      errors.push(item.row.school + ' (row ' + item.row.rowNumber + '): ' + e.message);
    }
  });

  let msg = created.length + ' draft(s) created in Gmail → Drafts.';
  if (created.length) msg += '\n\n' + created.map((s) => '✓ ' + s).join('\n');
  const skipped = checked.length - toProcess.length;
  if (skipped) msg += '\n\nSkipped ' + skipped + ' school(s) that already had a draft.';
  if (!settings.clubCoach) msg += '\n\nNote: no "Club Coach Email" in the Settings tab, so your club coach was not CC\'d.';
  if (errors.length) msg += '\n\nProblems (no draft made):\n' + errors.map((s) => '✗ ' + s).join('\n');
  msg += '\n\nNothing has been sent. Open Gmail → Drafts to review and send each one.';
  ui.alert('Done', msg, ui.ButtonSet.OK);
}

function previewFirst() {
  const ui = SpreadsheetApp.getUi();
  const settings = getSettings_();
  const template = getTemplateDraft_(settings.prefix);
  if (!template) return;

  const row = getRows_().rows.find((r) => r.send);
  if (!row) {
    ui.alert('No schools are checked. Tick the "Send?" box for at least one school.');
    return;
  }

  let m;
  try {
    m = buildEmail_(template, row, settings);
  } catch (e) {
    ui.alert('Problem with ' + row.school, e.message, ui.ButtonSet.OK);
    return;
  }

  const html =
    '<div style="font:14px/1.5 Arial,sans-serif">' +
    '<p style="margin:0 0 4px"><b>To:</b> ' + esc_(m.to) + '</p>' +
    '<p style="margin:0 0 4px"><b>CC:</b> ' + (m.cc.length ? esc_(m.cc.join(', ')) : '<i>none</i>') + '</p>' +
    '<p style="margin:0 0 4px"><b>Subject:</b> ' + esc_(m.subject) + '</p>' +
    (template.attachments.length
      ? '<p style="margin:0 0 4px"><b>Attachments:</b> ' +
        esc_(template.attachments.map((a) => a.getName()).join(', ')) + '</p>'
      : '') +
    '<hr>' + m.htmlBody +
    '<hr><p style="color:#666">Preview only. No draft was created.</p></div>';

  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(700).setHeight(550), 'Preview: ' + row.school);
}

function checkPlaceholders() {
  const ui = SpreadsheetApp.getUi();
  const settings = getSettings_();
  const template = getTemplateDraft_(settings.prefix);
  if (!template) return;

  const inPlain = findPlaceholders_(template.subject + '\n' + template.plainBody);
  const inHtml = findPlaceholders_(template.subject + '\n' + template.htmlBody);

  const lines = [];
  if (inPlain.length === 0) {
    lines.push('No placeholders found. Every school will get exactly the same text.');
  }
  inPlain.forEach((p) => {
    lines.push((p.key ? '✓ ' : '✗ ') + p.text + (p.key ? '' : '  ← not recognized (typo?)'));
  });

  // Formatting changes in the middle of a placeholder (e.g. half of it bold)
  // break it in the HTML version even though it looks fine.
  const htmlTexts = inHtml.map((p) => p.norm);
  const broken = inPlain.filter((p) => htmlTexts.indexOf(p.norm) === -1);
  if (broken.length) {
    lines.push('');
    lines.push('⚠ These look split up by formatting. Delete and retype them in the template:');
    broken.forEach((p) => lines.push('   ' + p.text));
  }

  lines.push('');
  lines.push('Recognized: [Last Name], [First Name], [Coach], [School]');
  lines.push('(or the same names in {{double braces}}; [College] and [University] also work)');
  ui.alert('Placeholders in "' + template.subject + '"', lines.join('\n'), ui.ButtonSet.OK);
}

// ---------------------------------------------------------------- helpers

function getSettings_() {
  const settings = { clubCoach: '', prefix: DEFAULT_PREFIX };
  const sheet = SpreadsheetApp.getActive().getSheetByName(SETTINGS_SHEET);
  if (!sheet) return settings;

  sheet.getDataRange().getValues().forEach((r) => {
    const key = normalize_(r[0]);
    const val = String(r[1] == null ? '' : r[1]).trim();
    if (key === 'clubcoachemail') settings.clubCoach = val;
    if (key === 'templateprefix' && val) settings.prefix = val;
  });

  if (settings.clubCoach && !EMAIL_RE.test(settings.clubCoach)) {
    throw new Error('Settings tab: "Club Coach Email" doesn\'t look like an email address: ' + settings.clubCoach);
  }
  return settings;
}

/** Finds the Gmail draft to use as the template, asking if there are several. */
function getTemplateDraft_(prefix) {
  const ui = SpreadsheetApp.getUi();
  const prefixLower = prefix.toLowerCase();
  const drafts = GmailApp.getDrafts().filter((d) =>
    d.getMessage().getSubject().trim().toLowerCase().indexOf(prefixLower) === 0
  );

  if (drafts.length === 0) {
    ui.alert(
      'No template found',
      'Write an email in Gmail and save it as a draft with a subject starting with "' + prefix + '".\n\n' +
        'Example subject: ' + prefix + ' Class of 2028 Midfielder, interested in {{School}}',
      ui.ButtonSet.OK
    );
    return null;
  }

  let draft = drafts[0];
  if (drafts.length > 1) {
    const list = drafts.map((d, i) => (i + 1) + '. ' + d.getMessage().getSubject()).join('\n');
    const resp = ui.prompt('Which template?', list + '\n\nType the number:', ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return null;
    const n = parseInt(resp.getResponseText(), 10);
    if (!(n >= 1 && n <= drafts.length)) {
      ui.alert('"' + resp.getResponseText() + '" isn\'t one of the numbers listed.');
      return null;
    }
    draft = drafts[n - 1];
  }

  const msg = draft.getMessage();
  const rawSubject = msg.getSubject().trim();
  const htmlBody = msg.getBody();

  // Map inline images (pasted pictures, logos in a signature) back to their cid
  // so they survive in the copies. Same approach as Google's mail-merge sample.
  const inlineByName = {};
  msg.getAttachments({ includeInlineImages: true, includeAttachments: false })
    .forEach((a) => { inlineByName[a.getName()] = a; });
  const inlineImages = {};
  const imgRe = /<img[^>]*?src="cid:([^"]*)"[^>]*?alt="([^"]*)"[^>]*>/g;
  let match;
  while ((match = imgRe.exec(htmlBody)) !== null) {
    if (inlineByName[match[2]]) inlineImages[match[1]] = inlineByName[match[2]];
  }

  return {
    subject: rawSubject.slice(prefix.length).trim(),
    htmlBody: htmlBody,
    plainBody: msg.getPlainBody(),
    attachments: msg.getAttachments({ includeInlineImages: false }),
    inlineImages: inlineImages,
  };
}

/** Reads the Coaches tab, mapping columns by header name. */
/** The tab named "Coaches", or else the first tab in the spreadsheet. */
function getCoachSheet_() {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(COACHES_SHEET) || ss.getSheets()[0];
}

function getRows_() {
  const sheet = getCoachSheet_();

  const values = sheet.getDataRange().getValues();
  const header = values[0] || [];
  const cols = {}; // field -> 1-based column number
  header.forEach((h, i) => {
    const field = HEADERS[normalize_(h)];
    if (field && !cols[field]) cols[field] = i + 1;
  });

  const missing = ['send', 'school', 'email', 'status'].filter((f) => !cols[f]);
  if (!cols.full && !(cols.first && cols.last)) missing.push('full');
  if (missing.length) {
    throw new Error(
      'The "' + sheet.getName() + '" tab is missing these column headers in row 1: ' +
        missing.map((f) => '"' + FIELD_LABELS[f] + '"').join(', ') +
        '. Use Recruiting Email → Set up sheet to add them.'
    );
  }

  const get = (r, f) => (cols[f] ? String(r[cols[f] - 1] == null ? '' : r[cols[f] - 1]).trim() : '');
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (!get(r, 'school') && !get(r, 'email')) continue; // blank row
    // A single "Coach" column is split: first word = first name, rest = last
    // name ("Tony da Luz" -> "Tony" / "da Luz").
    let first = get(r, 'first');
    let last = get(r, 'last');
    if (cols.full && !(first && last)) {
      const parts = get(r, 'full').split(/\s+/).filter(Boolean);
      first = first || parts[0] || '';
      last = last || parts.slice(1).join(' ');
    }
    rows.push({
      rowNumber: i + 1,
      send: r[cols.send - 1] === true,
      school: get(r, 'school'),
      first: first,
      last: last,
      email: get(r, 'email'),
      assistants: get(r, 'assistants'),
      status: get(r, 'status'),
    });
  }
  return { sheet: sheet, cols: cols, rows: rows };
}

/** Builds To/CC/subject/bodies for one school, or throws with a readable reason. */
function buildEmail_(template, row, settings) {
  if (!EMAIL_RE.test(row.email)) {
    throw new Error('head coach email is missing or invalid: "' + row.email + '"');
  }

  const values = {
    coach: row.last ? 'Coach ' + row.last : '',
    firstname: row.first,
    lastname: row.last,
    school: row.school,
  };

  const subject = fill_(template.subject, values, false);
  const plainBody = fill_(template.plainBody, values, false);
  const htmlBody = fill_(template.htmlBody, values, true);

  // CC: assistants + club coach, without duplicates or the head coach.
  const cc = [];
  const seen = { [row.email.toLowerCase()]: true };
  const assistants = row.assistants ? row.assistants.split(/[\s,;]+/).filter(Boolean) : [];
  assistants.concat(settings.clubCoach ? [settings.clubCoach] : []).forEach((addr) => {
    if (!EMAIL_RE.test(addr)) throw new Error('assistant email doesn\'t look valid: "' + addr + '"');
    const key = addr.toLowerCase();
    if (!seen[key]) { seen[key] = true; cc.push(addr); }
  });

  return { to: row.email, cc: cc, subject: subject, plainBody: plainBody, htmlBody: htmlBody };
}

/** Replaces placeholders; throws on unknown placeholders or missing values. */
function placeholderKey_(name) {
  return PLACEHOLDER_KEYS[name.toLowerCase().replace(/&nbsp;/g, '').replace(/[^a-z]/g, '')] || null;
}

function fill_(text, values, isHtml) {
  const sub = (whole, name) => {
    const key = placeholderKey_(name);
    if (!key) throw new Error('template uses unknown placeholder ' + whole + ' (typo?)');
    const val = values[key];
    if (!val) throw new Error('template uses ' + whole + ' but that cell is empty for this school');
    return isHtml ? esc_(val) : val;
  };
  return text.replace(BRACKET_RE, sub).replace(PLACEHOLDER_RE, sub);
}

/** Lists placeholders in order of appearance: {text, norm, key}. */
function findPlaceholders_(text) {
  const found = [];
  const seen = {};
  [BRACKET_RE, PLACEHOLDER_RE].forEach((src) => {
    const re = new RegExp(src.source, src.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const shown = m[0].replace(/&nbsp;/g, ' ');
      const norm = shown.toLowerCase().replace(/\s+/g, '');
      if (!seen[norm]) { seen[norm] = true; found.push({ text: shown, norm: norm, key: placeholderKey_(m[1]) }); }
    }
  });
  return found;
}

function normalize_(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function esc_(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
