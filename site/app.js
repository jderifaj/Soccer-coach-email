/* Coach Outreach: write one email, pick schools, open a filled-in Gmail
 * compose window for each. Nothing is sent from this page; all data stays
 * in this browser (localStorage) unless a backup is downloaded. */

(function () {
  'use strict';

  // ------------------------------------------------------------ pure helpers

  const TOKEN_RE = /\[\s*(coach|first\s*name|last\s*name|school|college|university)\s*\]/gi;
  const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

  function splitName(full) {
    const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
    return { first: parts[0] || '', last: parts.slice(1).join(' ') };
  }

  function tokenValue(token, coach) {
    const key = token.toLowerCase().replace(/\s+/g, '');
    const { first, last } = splitName(coach.coach);
    if (key === 'coach') return last ? 'Coach ' + last : '';
    if (key === 'firstname') return first;
    if (key === 'lastname') return last;
    return coach.school || ''; // school / college / university
  }

  /** Fills placeholders. Returns {text, missing: ['[Last Name]', ...]}. */
  function fill(text, coach) {
    const missing = [];
    const out = String(text || '').replace(TOKEN_RE, (whole, token) => {
      const v = tokenValue(token, coach);
      if (!v) { missing.push(whole); return whole; }
      return v;
    });
    return { text: out, missing };
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Same as fill(), as HTML with the filled-in parts highlighted. */
  function fillHtml(text, coach) {
    return escapeHtml(text || '').replace(TOKEN_RE, (whole, token) => {
      const v = tokenValue(token, coach);
      return v ? '<mark>' + escapeHtml(v) + '</mark>' : '<mark class="missing">' + whole + '</mark>';
    });
  }

  // --- Formatted message (HTML) helpers. The message is stored as HTML so it
  // can carry links, bold text and tables. These work on strings (no DOM) so
  // they can be tested in Node.

  const HTML_SPLIT_RE = /(<[^>]*>)/;

  /** Fills placeholders in the text parts of an HTML message (never inside
   *  tags or link addresses). `highlight` wraps filled values in <mark> for
   *  previews. Returns {html, missing}: anything still looking like a
   *  placeholder after filling (including one split up by formatting). */
  function fillMessage(html, coach, highlight) {
    const out = String(html || '').split(HTML_SPLIT_RE).map((part) => {
      if (part.startsWith('<')) return part;
      return part.replace(TOKEN_RE, (whole, token) => {
        const v = tokenValue(token, coach);
        if (!v) return highlight ? '<mark class="missing">' + whole + '</mark>' : whole;
        return highlight ? '<mark>' + escapeHtml(v) + '</mark>' : escapeHtml(v);
      });
    }).join('');
    const leftover = htmlToText(out).match(/\[[^\]\n]{1,30}\]/g) || [];
    const missing = leftover.filter((t) => new RegExp('^' + TOKEN_RE.source + '$', 'i').test(t));
    return { html: out, missing: Array.from(new Set(missing)) };
  }

  function decodeEntities(s) {
    return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&amp;/g, '&');
  }

  /** Plain-text version of a message: links become "words (address)",
   *  table cells are separated by " · ". */
  function htmlToText(html) {
    let s = String(html || '');
    s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
      const text = inner.replace(/<[^>]*>/g, '');
      const url = decodeEntities(href);
      return decodeEntities(text).trim() === url ? text : text + ' (' + href + ')';
    });
    s = s.replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(td|th)>\s*(?=<(td|th)\b)/gi, ' · ')
      .replace(/<\/(p|div|tr|li|h\d|table)>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '• ')
      .replace(/<[^>]*>/g, '');
    s = decodeEntities(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  /** Turns plain text into message HTML: keeps line breaks, links web addresses. */
  function textToHtml(text) {
    return escapeHtml(String(text || ''))
      .replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => '<a href="' + u + '">' + u + '</a>')
      .replace(/\n/g, '<br>');
  }

  /** Adds light inline spacing to tables so they look right once pasted into Gmail. */
  function emailReadyHtml(html) {
    return String(html || '')
      .replace(/<table\b[^>]*>/gi, '<table style="border-collapse:collapse">')
      .replace(/<(td|th)\b([^>]*)>/gi, '<$1$2 style="padding:2px 12px 2px 0;text-align:left;vertical-align:top">');
  }

  /** Accepts "hudl.com/x" or "https://hudl.com/x"; returns a full address or null. */
  function normalizeUrl(input) {
    let u = String(input || '').trim();
    if (!u) return null;
    if (!/^(https?:|mailto:)/i.test(u)) u = 'https://' + u;
    if (/\s/.test(u)) return null;
    if (/^https?:/i.test(u) && !/^https?:\/\/[^/]+\.[^/]+/i.test(u)) return null;
    return u;
  }

  function splitEmails(s) {
    return String(s || '').split(/[\s,;]+/).filter(Boolean);
  }

  /** CC = assistants + club coach, without repeats or the head coach. */
  function ccList(coach, clubCoach) {
    const seen = new Set([String(coach.email || '').toLowerCase()]);
    const out = [];
    splitEmails(coach.assistants).concat(splitEmails(clubCoach)).forEach((a) => {
      const k = a.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(a); }
    });
    return out;
  }

  function gmailUrl({ to, cc, subject, body, account }) {
    // encodeURIComponent (spaces as %20), not URLSearchParams (spaces as "+"),
    // so no "+" signs can show up in the Gmail message.
    const parts = [['view', 'cm'], ['fs', '1'], ['to', to]];
    if (cc.length) parts.push(['cc', cc.join(',')]);
    parts.push(['su', subject]);
    if (body) parts.push(['body', body]);
    if (account) parts.push(['authuser', account]);
    return 'https://mail.google.com/mail/?' +
      parts.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  }

  /** "3.16.26" or "3.16.2025" -> "2026-03-16" (null if not a date). */
  function parseContactDate(s) {
    const m = String(s || '').trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
    if (!m) return null;
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const mo = Number(m[1]), d = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function parseCsv(text) {
    const rows = []; let row = []; let f = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else if (c !== '\r') f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  /** Reads a coach CSV (University/School, Coach, Email Address, optional
   *  Assistant Emails and "... Contact" date columns). */
  function coachesFromCsv(text) {
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('The file is empty.');
    const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
    const header = rows[0].map(norm);
    const find = (...names) => header.findIndex((h) => names.includes(h));
    const iSchool = find('university', 'school', 'college');
    const iCoach = find('coach', 'headcoach', 'coachname');
    const iEmail = find('emailaddress', 'email', 'headcoachemail', 'coachemail');
    const iAsst = find('assistantemails', 'assistants', 'cc');
    if (iSchool < 0 || iCoach < 0 || iEmail < 0) {
      throw new Error('The first row needs columns named University, Coach and Email Address.');
    }
    // Date columns: anything named "... contact", plus unnamed columns after them.
    const firstContact = header.findIndex((h) => /contact$/.test(h));
    return rows.slice(1).filter((r) => (r[iSchool] || '').trim() || (r[iEmail] || '').trim()).map((r) => {
      const contacts = [];
      if (firstContact >= 0) {
        for (let i = firstContact; i < r.length; i++) {
          if (header[i] && !/contact$/.test(header[i])) continue;
          const d = parseContactDate(r[i]);
          if (d) contacts.push(d);
        }
      }
      return newCoach({
        school: (r[iSchool] || '').trim(),
        coach: (r[iCoach] || '').trim(),
        email: (r[iEmail] || '').trim(),
        assistants: iAsst >= 0 ? (r[iAsst] || '').trim() : '',
        contacts: Array.from(new Set(contacts)).sort(),
      });
    });
  }

  function newCoach(c) {
    return {
      id: 'c' + Math.random().toString(36).slice(2, 10),
      school: c.school || '', coach: c.coach || '', email: c.email || '',
      assistants: c.assistants || '', contacts: c.contacts || [],
      selected: false, opened: null,
    };
  }

  function todayIso() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function prettyDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const sameYear = y === new Date().getFullYear();
    return new Date(y, m - 1, d).toLocaleDateString(undefined,
      sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Exposed for tests in Node; the page itself does not use this.
  if (typeof module !== 'undefined') {
    module.exports = { splitName, fill, fillHtml, fillMessage, htmlToText, textToHtml, emailReadyHtml,
      normalizeUrl, ccList, gmailUrl, parseContactDate, coachesFromCsv, parseCsv };
    return;
  }

  // ------------------------------------------------------------ state

  const STORE_KEY = 'coach-outreach-v1';
  const DEFAULT_SUBJECT = '2029 Outside Back – Showcase Schedule';
  const DEFAULT_BODY = [
    'Hi [Coach],',
    '',
    'Write your email here. Use the buttons above to drop in the coach\'s name or school, and they\'ll be filled in for each school automatically.',
    '',
    'For example: I\'m very interested in [School] and would love for you to see me play this weekend.',
    '',
    'Thank you for your time!',
  ].join('\n');

  function defaultState() {
    return {
      version: 2,
      subject: DEFAULT_SUBJECT,
      bodyHtml: textToHtml(DEFAULT_BODY),
      clubCoach: '',
      gmailAccount: '',
      coaches: (window.COACH_SEED || []).map(newCoach),
    };
  }

  /** Brings saved data or a backup up to date (version 1 kept the message as plain text). */
  function upgrade(s) {
    const out = Object.assign(defaultState(), s);
    if (typeof s.body === 'string' && typeof s.bodyHtml !== 'string') out.bodyHtml = textToHtml(s.body);
    delete out.body;
    out.version = 2;
    return out;
  }

  let state = loadState();
  let storageOk = true;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && Array.isArray(s.coaches)) return upgrade(s);
      }
    } catch (e) { /* fall through to defaults */ }
    return defaultState();
  }

  // --- Cleaning pasted or typed HTML down to what an email needs.
  const KEEP_TAGS = new Set(['A', 'B', 'STRONG', 'I', 'EM', 'U', 'BR', 'P', 'DIV', 'UL', 'OL', 'LI',
    'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH']);
  const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'META', 'TITLE', 'HEAD', 'LINK', 'IFRAME', 'OBJECT', 'EMBED',
    'svg', 'SVG', 'IMG', 'VIDEO', 'AUDIO', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA']);

  function sanitizeHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    const clean = (node) => {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === Node.COMMENT_NODE) { child.remove(); return; }
        if (child.nodeType !== Node.ELEMENT_NODE) return;
        const tag = child.tagName.toUpperCase();
        if (DROP_TAGS.has(tag)) { child.remove(); return; }
        clean(child);
        const style = (child.getAttribute('style') || '').toLowerCase();
        // Google Docs wraps pasted text in <b style="font-weight:normal">.
        const notBold = /font-weight\s*:\s*(normal|[1-5]00)\b/.test(style);
        const isBold = /font-weight\s*:\s*(bold|[6-9]00)\b/.test(style);
        const isItalic = /font-style\s*:\s*italic/.test(style);
        let keep = KEEP_TAGS.has(tag) && !((tag === 'B' || tag === 'STRONG') && notBold);
        let replacement = null;
        if (!keep && tag !== 'A' && (isBold || isItalic)) {
          replacement = document.createElement(isBold ? 'b' : 'i');
        } else if (keep) {
          replacement = document.createElement(tag === 'STRONG' ? 'b' : tag === 'EM' ? 'i' : tag.toLowerCase());
          if (tag === 'A') {
            const href = normalizeUrl(child.getAttribute('href'));
            if (href) replacement.setAttribute('href', href);
            else replacement = null; // a link without a usable address: keep just its words
          }
          if ((tag === 'TD' || tag === 'TH') && replacement) {
            ['colspan', 'rowspan'].forEach((a) => { if (child.getAttribute(a)) replacement.setAttribute(a, child.getAttribute(a)); });
          }
        }
        if (replacement) {
          while (child.firstChild) replacement.append(child.firstChild);
          child.replaceWith(replacement);
        } else {
          child.replaceWith(...Array.from(child.childNodes)); // keep the words, drop the wrapper
        }
      });
    };
    clean(tpl.content);
    const div = document.createElement('div');
    div.append(tpl.content);
    return div.innerHTML;
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
        storageOk = true;
      } catch (e) {
        storageOk = false;
      }
      renderSaveNote();
    }, 300);
  }

  // ------------------------------------------------------------ DOM helpers

  const $ = (sel, root = document) => root.querySelector(sel);
  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach((k) => k != null && n.append(k));
    return n;
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  /** Copies the message with its links and formatting (plus a plain-text
   *  version for apps that can't take formatting). Call from a click. */
  function copyRich(html, text) {
    const viaSelection = () => {
      const box = el('div', { class: 'offscreen copy-box', contenteditable: 'true', html: html });
      document.body.append(box);
      const range = document.createRange();
      range.selectNodeContents(box);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      sel.removeAllRanges();
      box.remove();
      return ok;
    };
    if (navigator.clipboard && window.ClipboardItem) {
      try {
        return navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        })]).then(() => true, () => viaSelection());
      } catch (e) { /* fall back below */ }
    }
    return Promise.resolve(viaSelection());
  }

  const PASTE_KEYS = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘V' : 'Ctrl+V';

  // ------------------------------------------------------------ tabs

  const TABS = ['write', 'schools', 'send'];
  function showTab(name) {
    if (!TABS.includes(name)) name = 'write';
    TABS.forEach((t) => {
      $('#tab-' + t).setAttribute('aria-selected', String(t === name));
      $('#panel-' + t).hidden = t !== name;
    });
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    if (name === 'send') renderSend();
    if (name === 'write') renderPreview();
    window.scrollTo({ top: 0 });
  }

  // ------------------------------------------------------------ write tab

  let lastField = null;   // subject or body: where placeholder buttons insert
  let savedRange = null;  // the last cursor position / selection inside the message

  /** Puts the saved data into the Write tab's fields. */
  function fillWriteFields() {
    $('#subject').value = state.subject;
    $('#body').innerHTML = sanitizeHtml(state.bodyHtml);
    $('#club-coach').value = state.clubCoach;
    $('#gmail-account').value = state.gmailAccount;
    validateSettings();
  }

  function saveBody() {
    state.bodyHtml = $('#body').innerHTML;
    save();
    renderPreview();
  }

  function initWrite() {
    const subject = $('#subject'), body = $('#body');
    const club = $('#club-coach'), acct = $('#gmail-account');
    lastField = body;

    try { document.execCommand('defaultParagraphSeparator', false, 'div'); } catch (e) { /* older browsers */ }

    [subject, body].forEach((f) => f.addEventListener('focus', () => { lastField = f; }));
    subject.addEventListener('input', () => { state.subject = subject.value; save(); renderPreview(); });
    body.addEventListener('input', saveBody);
    body.addEventListener('paste', onPaste);
    body.addEventListener('click', (e) => { if (e.target.closest('a')) openLinkBox(); });
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (sel.rangeCount && body.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        savedRange = sel.getRangeAt(0).cloneRange();
      }
    });
    club.addEventListener('input', () => { state.clubCoach = club.value.trim(); save(); validateSettings(); renderPreview(); });
    acct.addEventListener('input', () => { state.gmailAccount = acct.value.trim(); save(); validateSettings(); });

    // Toolbar buttons must not take focus away from the message.
    document.querySelectorAll('.editor-toolbar button').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));
    document.querySelectorAll('[data-token]').forEach((b) => b.addEventListener('click', () => insertToken(b.dataset.token)));
    $('#fmt-bold').addEventListener('click', () => format('bold'));
    $('#fmt-italic').addEventListener('click', () => format('italic'));
    $('#fmt-link').addEventListener('click', openLinkBox);
    $('#link-box').addEventListener('submit', applyLink);
    $('#link-remove').addEventListener('click', removeLink);
    $('#link-cancel').addEventListener('click', closeLinkBox);
    $('#link-url').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLinkBox(); });

    $('#preview-school').addEventListener('change', renderPreview);
    fillWriteFields();
  }

  function restoreSelection() {
    const body = $('#body');
    body.focus();
    if (savedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
  }

  function format(cmd) {
    restoreSelection();
    document.execCommand(cmd);
    saveBody();
  }

  function insertToken(token) {
    const f = lastField || $('#body');
    if (f.id === 'subject') {
      const start = f.selectionStart ?? f.value.length;
      const end = f.selectionEnd ?? f.value.length;
      f.setRangeText(token, start, end, 'end');
      f.focus();
      f.dispatchEvent(new Event('input'));
      return;
    }
    restoreSelection();
    document.execCommand('insertText', false, token);
    saveBody();
  }

  function onPaste(e) {
    const html = e.clipboardData && e.clipboardData.getData('text/html');
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!html && !text) return;
    e.preventDefault();
    const clean = html ? sanitizeHtml(html) : textToHtml(text);
    document.execCommand('insertHTML', false, clean);
    saveBody();
  }

  // --- Links
  function linkAtSelection() {
    if (!savedRange) return null;
    let n = savedRange.commonAncestorContainer;
    if (n.nodeType !== Node.ELEMENT_NODE) n = n.parentNode;
    const a = n && n.closest ? n.closest('a') : null;
    return a && $('#body').contains(a) ? a : null;
  }

  function openLinkBox() {
    const existing = linkAtSelection();
    if (!existing && (!savedRange || savedRange.collapsed)) {
      toast('First select the words you want to turn into a link');
      $('#body').focus();
      return;
    }
    $('#link-url').value = existing ? existing.getAttribute('href') : '';
    $('#link-words').textContent = existing ? existing.textContent : savedRange.toString();
    $('#link-remove').hidden = !existing;
    $('#link-error').hidden = true;
    $('#link-box').hidden = false;
    $('#link-url').focus();
  }

  function closeLinkBox() {
    $('#link-box').hidden = true;
    restoreSelection();
  }

  function applyLink(e) {
    e.preventDefault();
    const url = normalizeUrl($('#link-url').value);
    if (!url) {
      $('#link-error').hidden = false;
      return;
    }
    const existing = linkAtSelection();
    $('#link-box').hidden = true;
    if (existing) {
      existing.setAttribute('href', url);
    } else {
      restoreSelection();
      document.execCommand('createLink', false, url);
    }
    saveBody();
    toast('Link added');
  }

  function removeLink() {
    const a = linkAtSelection();
    $('#link-box').hidden = true;
    if (a) {
      a.replaceWith(...Array.from(a.childNodes));
      saveBody();
      toast('Link removed');
    }
    $('#body').focus();
  }

  function validateSettings() {
    const bad = (v) => v && !splitEmails(v).every((a) => EMAIL_RE.test(a));
    $('#club-coach-err').hidden = !bad(state.clubCoach);
    $('#gmail-account-err').hidden = !bad(state.gmailAccount);
  }

  function renderPreviewOptions() {
    const sel = $('#preview-school');
    const current = sel.value;
    const list = state.coaches.filter((c) => c.selected).concat(state.coaches.filter((c) => !c.selected));
    sel.replaceChildren(...list.map((c) => el('option', { value: c.id, text: c.school || '(no school name)' })));
    if (list.some((c) => c.id === current)) sel.value = current;
  }

  function renderPreview() {
    renderPreviewOptions();
    const coach = state.coaches.find((c) => c.id === $('#preview-school').value);
    const box = $('#preview');
    if (!coach) { box.replaceChildren(el('p', { class: 'muted', text: 'Add a school on the Schools tab to see a preview.' })); return; }
    const cc = ccList(coach, state.clubCoach);
    box.replaceChildren(
      el('dl', { class: 'envelope' },
        el('dt', { text: 'To' }), el('dd', { text: coach.email || '—' }),
        el('dt', { text: 'CC' }), el('dd', { text: cc.length ? cc.join(', ') : 'nobody' }),
        el('dt', { text: 'Subject' }), el('dd', { html: fillHtml(state.subject, coach) })),
      externalLinks(el('div', { class: 'letter', html: fillMessage(sanitizeHtml(state.bodyHtml), coach, true).html }))
    );
  }

  // ------------------------------------------------------------ schools tab

  function lastContact(c) { return c.contacts.length ? c.contacts[c.contacts.length - 1] : null; }

  function renderSchools() {
    const q = $('#search').value.trim().toLowerCase();
    const list = $('#school-list');
    const shown = state.coaches.filter((c) =>
      !q || [c.school, c.coach, c.email].some((v) => v.toLowerCase().includes(q)));

    if (!state.coaches.length) {
      list.replaceChildren(el('li', { class: 'empty' },
        el('p', { text: 'No schools yet.' }),
        el('p', { class: 'muted', text: 'Add one with "Add school", or bring in a spreadsheet with "Import CSV".' })));
    } else if (!shown.length) {
      list.replaceChildren(el('li', { class: 'empty' }, el('p', { class: 'muted', text: 'No schools match "' + q + '".' })));
    } else {
      list.replaceChildren(...shown.map(schoolRow));
    }
    renderCounts();
  }

  function schoolRow(c) {
    const last = lastContact(c);
    const problems = [];
    if (!EMAIL_RE.test(c.email)) problems.push('Coach email is missing or looks wrong');
    if (c.assistants && !splitEmails(c.assistants).every((a) => EMAIL_RE.test(a))) problems.push('An assistant email looks wrong');

    const box = el('input', { type: 'checkbox', id: 'pick-' + c.id, checked: c.selected });
    box.addEventListener('change', () => { c.selected = box.checked; save(); row.classList.toggle('is-selected', c.selected); renderCounts(); });

    const row = el('li', { class: 'school' + (c.selected ? ' is-selected' : '') },
      box,
      el('label', { for: 'pick-' + c.id, class: 'school-main' },
        el('span', { class: 'school-name', text: c.school || '(no school name)' }),
        el('span', { class: 'school-coach', text: (c.coach || 'No coach name') + ' · ' + (c.email || 'no email') }),
        c.assistants ? el('span', { class: 'school-asst', text: 'CC: ' + splitEmails(c.assistants).join(', ') }) : null,
        problems.length ? el('span', { class: 'school-problem', text: problems.join('. ') }) : null),
      el('span', { class: 'school-meta' },
        last ? el('span', { class: 'chip', title: c.contacts.map(prettyDate).join(', '), text: 'Last ' + prettyDate(last) + ' · ' + c.contacts.length + '×' })
          : el('span', { class: 'chip', text: 'No dates yet' })),
      el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => openEditor(c), 'aria-label': 'Edit ' + c.school, text: 'Edit' })
    );
    return row;
  }

  function renderCounts() {
    const n = state.coaches.filter((c) => c.selected).length;
    $('#selected-count').textContent = n ? n + ' selected' : 'None selected';
    $('#send-badge').textContent = n || '';
    $('#send-badge').hidden = !n;
    $('#to-send').disabled = !n;
  }

  function setAll(selected) {
    const q = $('#search').value.trim().toLowerCase();
    state.coaches.forEach((c) => {
      if (!q || [c.school, c.coach, c.email].some((v) => v.toLowerCase().includes(q))) c.selected = selected;
    });
    save();
    renderSchools();
  }

  // Edit / add dialog
  let editing = null;
  function openEditor(c) {
    editing = c;
    const d = $('#edit-dialog');
    $('#edit-title').textContent = c ? 'Edit school' : 'Add a school';
    $('#f-school').value = c ? c.school : '';
    $('#f-coach').value = c ? c.coach : '';
    $('#f-email').value = c ? c.email : '';
    $('#f-assistants').value = c ? c.assistants : '';
    $('#f-contacts').textContent = c && c.contacts.length
      ? 'Contacted: ' + c.contacts.map(prettyDate).join(', ') : 'No contact dates yet.';
    $('#f-delete').hidden = !c;
    $('#f-delete').textContent = 'Delete school';
    $('#f-delete').dataset.armed = '';
    $('#edit-error').hidden = true;
    d.showModal();
    $('#f-school').focus();
  }

  function saveEditor(e) {
    e.preventDefault();
    const vals = {
      school: $('#f-school').value.trim(), coach: $('#f-coach').value.trim(),
      email: $('#f-email').value.trim(), assistants: splitEmails($('#f-assistants').value).join(', '),
    };
    const err = !vals.school ? 'Enter the school name.'
      : !EMAIL_RE.test(vals.email) ? 'Enter the head coach\'s email address.'
      : vals.assistants && !splitEmails(vals.assistants).every((a) => EMAIL_RE.test(a)) ? 'One of the assistant emails looks wrong.'
      : null;
    if (err) { $('#edit-error').textContent = err; $('#edit-error').hidden = false; return; }
    if (editing) Object.assign(editing, vals);
    else state.coaches.push(newCoach(vals));
    state.coaches.sort((a, b) => a.school.localeCompare(b.school));
    save();
    $('#edit-dialog').close();
    renderSchools();
    toast(editing ? 'Saved ' + vals.school : 'Added ' + vals.school);
  }

  function deleteFromEditor() {
    const b = $('#f-delete');
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Click again to delete'; return; }
    state.coaches = state.coaches.filter((c) => c !== editing);
    save();
    $('#edit-dialog').close();
    renderSchools();
    toast('Deleted ' + editing.school);
  }

  // CSV import: merge by school name (update existing, add new)
  function importCsvFile(file) {
    file.text().then((text) => {
      const incoming = coachesFromCsv(text);
      let added = 0, updated = 0;
      incoming.forEach((n) => {
        const match = state.coaches.find((c) => c.school.toLowerCase() === n.school.toLowerCase());
        if (match) {
          match.coach = n.coach || match.coach;
          match.email = n.email || match.email;
          match.assistants = n.assistants || match.assistants;
          match.contacts = Array.from(new Set(match.contacts.concat(n.contacts))).sort();
          updated++;
        } else { state.coaches.push(n); added++; }
      });
      state.coaches.sort((a, b) => a.school.localeCompare(b.school));
      save();
      renderSchools();
      toast('Imported: ' + added + ' added, ' + updated + ' updated');
    }).catch((e) => toast('Couldn\'t import: ' + e.message));
  }

  // ------------------------------------------------------------ send tab

  function renderSend() {
    const picked = state.coaches.filter((c) => c.selected);
    const wrap = $('#send-list');
    const notes = $('#send-notes');
    notes.replaceChildren();

    if (!picked.length) {
      wrap.replaceChildren(el('div', { class: 'empty' },
        el('p', { text: 'No schools picked yet.' }),
        el('p', { class: 'muted', text: 'Tick the schools you want on the Schools tab, then come back here.' }),
        el('button', { type: 'button', class: 'btn', onclick: () => showTab('schools'), text: 'Choose schools' })));
      $('#send-summary').textContent = '';
      return;
    }

    if (!state.clubCoach) {
      notes.append(el('p', { class: 'note warn' }, 'Your club coach isn\'t CC\'d yet. Add their email on the ',
        el('a', { href: '#write', text: 'Write tab' }), '.'));
    }
    if (!state.subject.trim()) notes.append(el('p', { class: 'note warn', text: 'The subject is empty.' }));

    const sent = picked.filter((c) => c.contacts.includes(todayIso()) && c.opened === todayIso()).length;
    $('#send-summary').textContent = picked.length + (picked.length === 1 ? ' email' : ' emails') +
      (sent ? ' · ' + sent + ' marked sent today' : '');
    wrap.replaceChildren(...picked.map(sendCard));
  }

  function sendCard(c) {
    const subj = fill(state.subject, c);
    const body = fillMessage(sanitizeHtml(state.bodyHtml), c, false);
    const bodyHtml = emailReadyHtml(body.html);
    const bodyText = htmlToText(body.html);
    const cc = ccList(c, state.clubCoach);
    const missing = Array.from(new Set(subj.missing.concat(body.missing)));
    const emailOk = EMAIL_RE.test(c.email);
    // The message itself can't travel in the link with its formatting, so it
    // goes on the clipboard and she pastes it into Gmail.
    const url = gmailUrl({ to: c.email, cc, subject: subj.text, body: '', account: state.gmailAccount });
    const sentToday = c.contacts.includes(todayIso()) && c.opened === todayIso();

    const problems = [];
    if (!emailOk) problems.push('The coach email is missing or looks wrong. Fix it on the Schools tab.');
    if (missing.length) problems.push('Nothing to fill in for ' + missing.join(', ') + '. Add the coach\'s full name on the Schools tab, or retype the placeholder if part of it is bold or linked.');

    const copyThen = (onDone) => copyRich(bodyHtml, bodyText).then((ok) => onDone(ok));

    const status = el('div', { class: 'card-status' });
    const card = el('article', { class: 'card' + (sentToday ? ' is-sent' : '') },
      el('header', { class: 'card-head' },
        el('div', {},
          el('h3', { text: c.school }),
          el('p', { class: 'muted', text: c.coach || 'No coach name' })),
        el('button', { type: 'button', class: 'btn btn-quiet', text: 'Remove',
          'aria-label': 'Remove ' + c.school + ' from this list',
          onclick: () => { c.selected = false; save(); renderSend(); renderSchools(); } })),
      el('dl', { class: 'envelope' },
        el('dt', { text: 'To' }), el('dd', { text: c.email || '—' }),
        el('dt', { text: 'CC' }), el('dd', { text: cc.length ? cc.join(', ') : 'nobody' }),
        el('dt', { text: 'Subject' }), el('dd', { html: fillHtml(state.subject, c) })),
      el('details', { class: 'letter-wrap' },
        el('summary', { text: 'Read the message' }),
        externalLinks(el('div', { class: 'letter', html: fillMessage(sanitizeHtml(state.bodyHtml), c, true).html }))),
      problems.length ? el('ul', { class: 'problems' }, problems.map((p) => el('li', { text: p }))) : null,
      el('div', { class: 'card-actions' },
        emailOk && !missing.length
          ? el('a', { class: 'btn btn-primary', href: url, target: '_blank', rel: 'noopener',
              onclick: () => {
                // Copy first (still inside the click), then the link opens Gmail.
                copyThen((ok) => {
                  c.opened = c.opened === todayIso() ? c.opened : 'opened:' + todayIso();
                  save();
                  showSentPrompt(c, status, ok);
                });
              },
              text: 'Open in Gmail' })
          : el('span', { class: 'btn btn-primary is-disabled', 'aria-disabled': 'true', text: 'Open in Gmail' }),
        el('button', { type: 'button', class: 'btn', text: 'Copy message',
          onclick: () => copyThen((ok) => toast(ok ? 'Message copied with its links' : 'Couldn\'t copy. Open "Read the message", select it and copy.')) })),
      el('p', { class: 'hint', text: 'Gmail opens with To, CC and Subject filled in, and the message is copied for you. Click in the message area and press ' + PASTE_KEYS + '.' }),
      status
    );
    if (sentToday) showSentDone(c, status);
    else if (String(c.opened || '').startsWith('opened:')) showSentPrompt(c, status);
    return card;
  }

  function externalLinks(node) {
    node.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
    return node;
  }

  function showSentPrompt(c, status, copied) {
    status.replaceChildren(
      el('span', { text: copied === false
        ? 'Gmail opened, but the message couldn\'t be copied. Click "Copy message", then paste it into Gmail. Sent it?'
        : copied
          ? 'Message copied. Paste it into Gmail with ' + PASTE_KEYS + '. Sent it?'
          : 'Opened in Gmail. Did you send it?' }),
      el('button', { type: 'button', class: 'btn btn-small', text: 'Yes, mark as sent', onclick: () => {
        const t = todayIso();
        if (!c.contacts.includes(t)) c.contacts = c.contacts.concat(t).sort();
        c.opened = t;
        save();
        renderSend();
        toast('Marked ' + c.school + ' as contacted today');
      } }));
  }

  function showSentDone(c, status) {
    status.closest('.card').classList.add('is-sent');
    status.replaceChildren(
      el('span', { class: 'sent-mark', text: '✓ Sent ' + prettyDate(todayIso()) }),
      el('button', { type: 'button', class: 'btn btn-quiet btn-small', text: 'Undo', onclick: () => {
        c.contacts = c.contacts.filter((d) => d !== todayIso());
        c.opened = null;
        save();
        renderSend();
      } }));
  }

  function clearSent() {
    const t = todayIso();
    let n = 0;
    state.coaches.forEach((c) => { if (c.selected && c.opened === t) { c.selected = false; n++; } });
    save();
    renderSend();
    renderSchools();
    toast(n ? 'Cleared ' + n + ' sent ' + (n === 1 ? 'school' : 'schools') : 'Nothing is marked as sent yet');
  }

  // ------------------------------------------------------------ backup

  function downloadBackup() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'coach-outreach-backup-' + todayIso() + '.json' });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function restoreBackup(file) {
    file.text().then((text) => {
      const s = JSON.parse(text);
      if (!s || !Array.isArray(s.coaches)) throw new Error('That file isn\'t a Coach Outreach backup.');
      state = upgrade(s);
      state.coaches = state.coaches.map((c) => Object.assign(newCoach(c), c));
      save();
      fillWriteFields();
      renderSchools();
      renderPreview();
      toast('Backup restored');
    }).catch((e) => toast('Couldn\'t restore: ' + e.message));
  }

  function renderSaveNote() {
    $('#save-note').textContent = storageOk
      ? 'Saved in this browser.'
      : 'This browser isn\'t saving your work (private window?). Download a backup before closing.';
    $('#save-note').classList.toggle('warn', !storageOk);
  }

  // ------------------------------------------------------------ boot

  function boot() {
    TABS.forEach((t) => $('#tab-' + t).addEventListener('click', () => showTab(t)));
    window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
    $('#to-schools').addEventListener('click', () => showTab('schools'));
    $('#to-send').addEventListener('click', () => showTab('send'));

    $('#search').addEventListener('input', renderSchools);
    $('#select-all').addEventListener('click', () => setAll(true));
    $('#select-none').addEventListener('click', () => setAll(false));
    $('#add-school').addEventListener('click', () => openEditor(null));
    $('#edit-form').addEventListener('submit', saveEditor);
    $('#f-cancel').addEventListener('click', () => $('#edit-dialog').close());
    $('#f-delete').addEventListener('click', deleteFromEditor);
    $('#import-csv').addEventListener('change', (e) => { if (e.target.files[0]) importCsvFile(e.target.files[0]); e.target.value = ''; });
    $('#clear-sent').addEventListener('click', clearSent);
    $('#backup').addEventListener('click', downloadBackup);
    $('#restore').addEventListener('change', (e) => { if (e.target.files[0]) restoreBackup(e.target.files[0]); e.target.value = ''; });

    initWrite();
    renderSchools();
    renderSaveNote();
    try { localStorage.setItem(STORE_KEY + '-probe', '1'); localStorage.removeItem(STORE_KEY + '-probe'); }
    catch (e) { storageOk = false; renderSaveNote(); }
    showTab(location.hash.slice(1) || 'write');
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
