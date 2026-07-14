/**
 * Job AutoFill — content script.
 *
 * Scans the page for form fields (inputs, textareas, selects, radio groups,
 * checkboxes, file inputs and ARIA comboboxes), figures out what each field
 * is asking for from its label / attributes, and fills it from the saved
 * profile. Runs in every frame so embedded ATS forms (Greenhouse, Lever,
 * Workday, ...) are covered.
 *
 * It never clicks Submit and never checks legal/consent checkboxes unless
 * the user explicitly configured a matching custom answer.
 */
(() => {
  'use strict';

  if (window.__jobAutofillLoaded) return;
  window.__jobAutofillLoaded = true;

  /** Elements already handled by an automatic pass (don't re-touch what the user may have edited). */
  const autoProcessed = new WeakSet();

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Normalize text for matching: lowercase, collapse everything but a-z 0-9 + into spaces. */
  function norm(s) {
    return (s || '')
      .toString()
      .toLowerCase()
      .replace(/[^a-z0-9+]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** Usable = we are allowed to fill it. File inputs are often visually hidden behind styled buttons, so they get a pass on visibility. */
  function isUsable(el) {
    if (el.disabled || el.readOnly) return false;
    if (el.type === 'hidden') return false;
    if (el.type === 'file') return true;
    return isElementVisible(el);
  }

  // ---------------------------------------------------------------------
  // Label / context extraction
  // ---------------------------------------------------------------------

  /**
   * Text of a node excluding any form controls inside it. A <label> that wraps
   * a <select> must not leak every <option>'s text into the label, or the
   * option texts derail rule matching (e.g. a "High School" option making a
   * degree dropdown look like a school field).
   */
  function cleanText(node) {
    if (!node) return '';
    if (!node.querySelector || !node.querySelector('select, input, textarea, button')) {
      return node.innerText || node.textContent || '';
    }
    const clone = node.cloneNode(true);
    clone.querySelectorAll('select, input, textarea, button').forEach((n) => n.remove());
    return clone.textContent || '';
  }

  function textOfIds(idList, root) {
    const scope = root && root.getElementById ? root : document;
    const parts = [];
    (idList || '').split(/\s+/).forEach((id) => {
      if (!id) return;
      const n = scope.getElementById(id);
      if (n) parts.push(cleanText(n));
    });
    return parts.join(' ');
  }

  /**
   * Nearby text fallback: walk up a few ancestors looking at previous
   * siblings for short label-like text. Checks bare TEXT NODES too — forms
   * like "Name<input>" put the label in a text node, and skipping it would
   * make us walk up and absorb unrelated text from surrounding sections.
   */
  function findNearbyText(el) {
    let node = el;
    for (let depth = 0; depth < 4 && node && node !== document.body; depth++) {
      let sib = node.previousSibling;
      let hops = 0;
      while (sib && hops < 4) {
        let t = '';
        if (sib.nodeType === Node.TEXT_NODE) t = (sib.textContent || '').trim();
        else if (sib.nodeType === Node.ELEMENT_NODE) t = cleanText(sib).trim();
        if (t && t.length <= 160) return t;
        sib = sib.previousSibling;
        hops++;
      }
      node = node.parentElement;
    }
    return '';
  }

  /**
   * Heading text above a control. Some forms (JazzHR EEO sections, ...) put
   * the real question in a heading a section or two above the options, while
   * the group's own label is a generic "Please check one of the boxes below".
   */
  function headingContext(el) {
    const texts = [];
    let node = el;
    for (let depth = 0; depth < 5 && node && node !== document.body && texts.length < 2; depth++) {
      let sib = node.previousElementSibling;
      let hops = 0;
      while (sib && hops < 6 && texts.length < 2) {
        let h = null;
        if (/^(H[1-6]|LEGEND|STRONG|B|TH|LABEL)$/.test(sib.tagName)) h = sib;
        else if (sib.querySelector) h = sib.querySelector('h1,h2,h3,h4,h5,h6,legend,strong,b,[role="heading"]');
        const t = h ? cleanText(h).trim() : '';
        if (t && t.length <= 200 && !texts.includes(t)) texts.push(t);
        sib = sib.previousElementSibling;
        hops++;
      }
      node = node.parentElement;
    }
    return texts.join(' ');
  }

  /** Human-visible label text for a single control. */
  function getLabelText(el) {
    const root = el.getRootNode(); // document, or the ShadowRoot the control lives in
    const parts = [];
    const aria = el.getAttribute('aria-label');
    if (aria) parts.push(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) parts.push(textOfIds(labelledBy, root));
    if (el.id) {
      try {
        const lab = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) parts.push(cleanText(lab));
      } catch (e) { /* bad id */ }
    }
    const wrap = el.closest('label');
    if (wrap) parts.push(cleanText(wrap));
    if (el.placeholder) parts.push(el.placeholder);
    const joined = parts.join(' ').trim();
    if (joined) return joined;
    return findNearbyText(el);
  }

  /** Machine hints: name / id / autocomplete / data-* attribute values. */
  function getAttrText(el) {
    const parts = [el.name || '', el.id || '', el.getAttribute('autocomplete') || ''];
    for (const a of ['data-qa', 'data-testid', 'data-field', 'data-automation-id']) {
      const v = el.getAttribute(a);
      if (v) parts.push(v);
    }
    return parts.join(' ');
  }

  /** The full haystack we match rules against. */
  function getHaystack(el) {
    return norm(getLabelText(el) + ' ' + getAttrText(el));
  }

  /** Label for one radio/checkbox option (not the group question). */
  function getOptionLabel(input) {
    if (input.id) {
      try {
        const l = input.getRootNode().querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (l) return cleanText(l);
      } catch (e) { /* ignore */ }
    }
    const wrap = input.closest('label');
    if (wrap) return cleanText(wrap);
    const aria = input.getAttribute('aria-label');
    if (aria) return aria;
    let sib = input.nextSibling;
    while (sib && !(sib.textContent || '').trim()) sib = sib.nextSibling;
    if (sib) return (sib.textContent || '').trim();
    return input.value || '';
  }

  /** Question text for a radio/checkbox group. */
  function getGroupLabel(inputs) {
    const first = inputs[0];
    const fs = first.closest('fieldset');
    if (fs) {
      const lg = fs.querySelector('legend');
      if (lg && cleanText(lg).trim()) return cleanText(lg);
    }
    const rg = first.closest('[role="radiogroup"], [role="group"]');
    if (rg) {
      const aria = rg.getAttribute('aria-label');
      if (aria) return aria;
      const lb = rg.getAttribute('aria-labelledby');
      if (lb) {
        const t = textOfIds(lb, first.getRootNode());
        if (t.trim()) return t;
      }
    }
    // Start at the tightest ancestor containing the whole group, then keep
    // walking up until real question text appears. Many ATSes (Lever,
    // Greenhouse boards, ...) render the question in a sibling <div> two or
    // three levels above the options list, so the tightest ancestor holds
    // nothing but the option labels themselves.
    let anc = first.parentElement;
    while (anc && anc !== document.body && !inputs.every((r) => anc.contains(r))) {
      anc = anc.parentElement;
    }
    for (let depth = 0; depth < 4 && anc && anc !== document.body; depth++) {
      // Stop before absorbing a container that also holds OTHER questions'
      // fields — their text would pollute this group's question.
      const foreign = [...anc.querySelectorAll('input, select, textarea')]
        .some((c) => c.type !== 'hidden' && !inputs.includes(c));
      if (foreign) break;
      let full = cleanText(anc).trim();
      for (const r of inputs) {
        const ol = (getOptionLabel(r) || '').trim();
        if (ol) full = full.replace(ol, ' ');
      }
      full = full.replace(/\s+/g, ' ').trim();
      if (full) return full.slice(0, 300);
      anc = anc.parentElement;
    }
    return findNearbyText(first);
  }

  // ---------------------------------------------------------------------
  // Value matching (options, aliases, scores)
  // ---------------------------------------------------------------------

  const ALIAS_GROUPS = [
    ['yes', 'y', 'true'],
    ['no', 'n', 'false'],
    ['united states', 'united states of america', 'usa', 'us', 'america'],
    ['united kingdom', 'uk', 'great britain', 'england'],
    ['south korea', 'korea republic of', 'republic of korea', 'korea'],
    ['male', 'man'],
    ['female', 'woman'],
    ['non binary', 'nonbinary', 'non binary genderqueer or gender non conforming'],
    ['prefer not to say', 'prefer not to answer', 'i don t wish to answer', 'decline to self identify', 'decline to state', 'prefer not to disclose', 'i prefer not to answer', 'i do not wish to answer'],
    // US states <-> abbreviations
    ['alabama', 'al'], ['alaska', 'ak'], ['arizona', 'az'], ['arkansas', 'ar'],
    ['california', 'ca'], ['colorado', 'co'], ['connecticut', 'ct'], ['delaware', 'de'],
    ['florida', 'fl'], ['georgia', 'ga'], ['hawaii', 'hi'], ['idaho', 'id'],
    ['illinois', 'il'], ['indiana', 'in'], ['iowa', 'ia'], ['kansas', 'ks'],
    ['kentucky', 'ky'], ['louisiana', 'la'], ['maine', 'me'], ['maryland', 'md'],
    ['massachusetts', 'ma'], ['michigan', 'mi'], ['minnesota', 'mn'], ['mississippi', 'ms'],
    ['missouri', 'mo'], ['montana', 'mt'], ['nebraska', 'ne'], ['nevada', 'nv'],
    ['new hampshire', 'nh'], ['new jersey', 'nj'], ['new mexico', 'nm'], ['new york', 'ny'],
    ['north carolina', 'nc'], ['north dakota', 'nd'], ['ohio', 'oh'], ['oklahoma', 'ok'],
    ['oregon', 'or'], ['pennsylvania', 'pa'], ['rhode island', 'ri'], ['south carolina', 'sc'],
    ['south dakota', 'sd'], ['tennessee', 'tn'], ['texas', 'tx'], ['utah', 'ut'],
    ['vermont', 'vt'], ['virginia', 'va'], ['washington', 'wa'], ['west virginia', 'wv'],
    ['wisconsin', 'wi'], ['wyoming', 'wy'], ['district of columbia', 'dc', 'washington dc'],
  ];

  const ALIAS_INDEX = new Map();
  ALIAS_GROUPS.forEach((group, i) => {
    for (const term of group) ALIAS_INDEX.set(term, i);
  });

  function sameAliasGroup(a, b) {
    const ga = ALIAS_INDEX.get(a);
    return ga !== undefined && ga === ALIAS_INDEX.get(b);
  }

  const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'for', 'and', 'or', 'you', 'your', 'do', 'are', 'is', 'i', 'be', 'will', 'would', 'this', 'that', 'with', 'at', 'on', 'please', 'select', 'choose', 'enter']);

  function significantTokens(s) {
    return norm(s).split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t));
  }

  /** How well does candidate option text match the desired value? 0..100 */
  function matchScore(optionText, desired) {
    const o = norm(optionText);
    const d = norm(desired);
    if (!o || !d) return 0;
    if (o === d) return 100;
    if (sameAliasGroup(o, d)) return 95;

    // Phone country codes: "+82" should match "South Korea (+82)" etc.
    const dCode = d.match(/^\+?(\d{1,4})$/);
    if (dCode) {
      const re = new RegExp(`(^|[^0-9])\\+?${dCode[1]}([^0-9]|$)`);
      if (re.test(o)) return 90;
      return 0;
    }

    // Whole-phrase containment (word-boundary, so "no" never matches "north").
    if (d.length >= 3) {
      const re = new RegExp(`(^|\\s)${escapeRegex(d)}(\\s|$)`);
      if (re.test(o)) return 85;
      const reInv = new RegExp(`(^|\\s)${escapeRegex(o)}(\\s|$)`);
      if (o.length >= 3 && reInv.test(d)) return 75;
    }

    // Yes/No answers against long option sentences ("Yes, I am authorized...").
    const dGroup = ALIAS_INDEX.get(d);
    if (dGroup !== undefined) {
      const firstTok = o.split(' ')[0];
      if (ALIAS_INDEX.get(firstTok) === dGroup) return 82;
    }

    // Token overlap.
    const oTokens = new Set(o.split(' '));
    const dTokens = significantTokens(desired);
    if (!dTokens.length) return 0;
    const hit = dTokens.filter((t) => oTokens.has(t) || oTokens.has(ALIAS_GROUPS[ALIAS_INDEX.get(t)]?.[0])).length;
    return Math.round((hit / dTokens.length) * 70);
  }

  // ---------------------------------------------------------------------
  // Native value setting + user feedback
  // ---------------------------------------------------------------------

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fireEvents(el, { blur = true } = {}) {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (blur) el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function flash(el) {
    const target = el.type === 'file' ? (el.closest('div,section,label') || el) : el;
    if (!(target instanceof HTMLElement)) return;
    const prev = target.style.boxShadow;
    target.style.boxShadow = '0 0 0 2px #22c55e';
    target.style.transition = 'box-shadow 0.4s ease';
    setTimeout(() => { target.style.boxShadow = prev; }, 1400);
  }

  // ---------------------------------------------------------------------
  // Fillers per control type
  // ---------------------------------------------------------------------

  function fillText(el, value) {
    let v = String(value);
    const existing = (el.value || '').trim();
    if (existing) {
      // International phone widgets (ADP, intl-tel-input, ...) pre-fill the
      // input with just a dial code like "+1". Complete it instead of
      // treating the field as already answered.
      const dialCodeOnly = /^\+\d{0,4}$/.test(existing);
      if (!dialCodeOnly) return norm(existing) === norm(v); // never overwrite user input
      if (!v.startsWith('+') && /^[\d\s().-]{7,}$/.test(v)) v = existing + ' ' + v;
    }
    if (el.type === 'number') {
      // Strip currency formatting first so "$120,000" becomes 120000, not 120.
      const m = v.replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
      if (!m) return false;
      v = m[0];
    }
    if (el.type === 'date') {
      const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (us) v = `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    }
    if (el.maxLength > 0 && v.length > el.maxLength) v = v.slice(0, el.maxLength);
    el.focus();
    setNativeValue(el, v);
    fireEvents(el);
    flash(el);
    return true;
  }

  function fillSelect(select, desired) {
    if (select.selectedIndex > 0 && select.value) return false; // already chosen
    let best = null;
    let bestScore = 0;
    for (const opt of select.options) {
      if (opt.disabled) continue;
      const s = Math.max(matchScore(opt.textContent, desired), matchScore(opt.value, desired));
      if (s > bestScore) { best = opt; bestScore = s; }
    }
    if (!best || bestScore < 60) return false;
    if (select.value === best.value && select.selectedIndex === best.index) return false;
    setNativeValue(select, best.value);
    best.selected = true;
    fireEvents(select);
    flash(select);
    return true;
  }

  function fillRadioGroup(radios, desired) {
    let best = null;
    let bestScore = 0;
    for (const r of radios) {
      const s = matchScore(getOptionLabel(r), desired);
      if (s > bestScore) { best = r; bestScore = s; }
    }
    if (!best) return false;
    const checked = radios.find((r) => r.checked);
    if (checked === best) return false;
    // An unanswered group fills at the normal threshold. Overriding an
    // already-selected option (many ATSes preselect "I don't wish to answer"
    // on EEO questions) requires a stronger match.
    const threshold = checked ? 75 : 60;
    if (bestScore < threshold) return false;
    best.click();
    if (!best.checked) {
      best.checked = true;
      fireEvents(best, { blur: false });
    }
    flash(best.closest('label') || best);
    return true;
  }

  function fillCheckbox(box, desired) {
    const d = norm(desired);
    const wantsChecked = ALIAS_INDEX.get(d) === ALIAS_INDEX.get('yes') || matchScore(getOptionLabel(box), desired) >= 80;
    if (!wantsChecked || box.checked) return false;
    box.click();
    if (!box.checked) {
      box.checked = true;
      fireEvents(box, { blur: false });
    }
    flash(box.closest('label') || box);
    return true;
  }

  /**
   * "Check all that apply" groups (several checkboxes sharing a name). The
   * configured answer may hold several values separated by ";" or ",".
   */
  function fillCheckboxGroup(boxes, desired) {
    if (boxes.some((b) => b.checked)) return false; // already answered
    const parts = String(desired).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    let any = false;
    for (const part of parts) {
      let best = null;
      let bestScore = 0;
      for (const b of boxes) {
        const s = matchScore(getOptionLabel(b), part);
        if (s > bestScore) { best = b; bestScore = s; }
      }
      if (best && bestScore >= 60 && !best.checked) {
        best.click();
        if (!best.checked) {
          best.checked = true;
          fireEvents(best, { blur: false });
        }
        flash(best.closest('label') || best);
        any = true;
      }
    }
    return any;
  }

  function dataUrlToFile(fileData) {
    const [meta, b64] = fileData.dataUrl.split(',');
    const mime = fileData.type || (meta.match(/data:(.*?)[;,]/) || [])[1] || 'application/octet-stream';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], fileData.name, { type: mime });
  }

  function fillFile(input, fileData) {
    try {
      if (input.files && input.files.length) return false; // something already attached
      const accept = (input.getAttribute('accept') || '').toLowerCase();
      if (accept && fileData.name) {
        const ext = '.' + fileData.name.split('.').pop().toLowerCase();
        const mime = (fileData.type || '').toLowerCase();
        const ok = accept.split(',').some((a) => {
          a = a.trim();
          if (!a) return false;
          if (a.startsWith('.')) return a === ext;
          if (a.endsWith('/*')) return mime.startsWith(a.slice(0, -1));
          return a === mime;
        });
        if (!ok) return false;
      }
      const file = dataUrlToFile(fileData);
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      flash(input);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Best-effort for React-style autocomplete comboboxes (location, country, ...). */
  async function fillCombobox(input, desired) {
    if (input.value && input.value.trim()) return false;
    input.focus();
    input.click();
    setNativeValue(input, desired);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: desired }));
    await sleep(600);
    const inputRoot = input.getRootNode();
    const listId = input.getAttribute('aria-controls') || input.getAttribute('aria-owns');
    let scope = inputRoot.querySelector ? inputRoot : document;
    if (listId && inputRoot.getElementById) {
      const list = inputRoot.getElementById(listId.split(/\s+/)[0]);
      if (list) scope = list;
    }
    const options = [...scope.querySelectorAll('[role="option"]')].filter(isElementVisible);
    let best = null;
    let bestScore = 0;
    for (const opt of options) {
      const s = matchScore(opt.textContent, desired);
      if (s > bestScore) { best = opt; bestScore = s; }
    }
    if (best && bestScore >= 60) {
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
        best.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      await sleep(120);
    } else {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    fireEvents(input);
    flash(input);
    return true;
  }

  // ---------------------------------------------------------------------
  // Page context: job title / company for {job_title} and {company}
  // ---------------------------------------------------------------------

  let cachedJobTitle = null;
  function detectJobTitle() {
    if (cachedJobTitle !== null) return cachedJobTitle;
    const firstPart = (s) => (s || '').split(/\s[|•·–—-]\s/)[0].replace(/\s+/g, ' ').trim();
    let t = '';
    // Prefer explicit job-title elements, then the page heading, then metadata.
    for (const sel of ['[class*="job-title" i]', '[class*="jobtitle" i]', '[data-qa="posting-name"]', '.posting-headline h2', '.app-title', 'h1']) {
      const el = document.querySelector(sel);
      if (el) {
        t = firstPart(el.innerText);
        if (t) break;
      }
    }
    if (!t) {
      const og = document.querySelector('meta[property="og:title"]');
      if (og && og.content) t = firstPart(og.content);
    }
    if (!t) t = firstPart(document.title);
    cachedJobTitle = t.slice(0, 120);
    return cachedJobTitle;
  }

  let cachedCompany = null;
  function detectCompany() {
    if (cachedCompany !== null) return cachedCompany;
    const og = document.querySelector('meta[property="og:site_name"]');
    cachedCompany = og && og.content ? og.content.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    return cachedCompany;
  }

  /** Replace {job_title} / {role} / {position} / {company} in configured text. */
  function applyPlaceholders(text) {
    let out = String(text);
    if (out.indexOf('{') !== -1) {
      out = out.replace(/\{(?:job[ _-]?title|job[ _-]?role|role|position)\}/gi, () => detectJobTitle() || 'this role');
      out = out.replace(/\{company\}/gi, () => detectCompany() || 'your company');
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Field rules: what is this field asking for?
  // ---------------------------------------------------------------------

  // Order matters: more specific rules first. `re` is tested against the
  // normalized haystack; `not` vetoes a match.
  const RULES = [
    { key: 'email', re: /e ?mail/, get: (p) => p.email },
    { key: 'firstName', re: /first ?name|given ?name|\bfname\b|\bforename\b/, not: /referr/, get: (p) => p.firstName },
    { key: 'middleName', re: /middle ?name|\bmname\b/, not: /referr/, get: (p) => p.middleName },
    { key: 'lastName', re: /last ?name|family ?name|\bsurname\b|\blname\b/, not: /referr/, get: (p) => p.lastName },
    {
      key: 'fullName',
      re: /full ?name|legal ?name|complete name|candidate name|applicant name|your name|\bname\b/,
      not: /company|employer|school|university|user ?name|file|contact|manager|referr|reference|first|last|middle|nick|maiden|login|host/,
      get: (p) => [p.firstName, p.lastName].filter(Boolean).join(' '),
    },
    { key: 'phoneCountryCode', re: /country code|dial(ing)? code|phone code|calling code|phone country/, get: (p) => p.phoneCountryCode },
    { key: 'phoneType', re: /phone (device )?type|type of phone/, get: () => 'Mobile' },
    { key: 'phone', re: /phone|mobile|\bcell\b|telephone|\btel\b/, not: /country|extension|\bext\b|type/, get: (p) => p.phone },
    { key: 'linkedin', re: /linked ?in/, get: (p) => p.linkedin },
    { key: 'github', re: /git ?hub/, get: (p) => p.github },
    { key: 'twitter', re: /twitter/, get: (p) => p.twitter },
    { key: 'portfolio', re: /portfolio|personal (web ?site|site|url)|\bwebsite\b|\bhomepage\b|blog/, not: /company|linked ?in|git ?hub|twitter/, get: (p) => p.portfolio },
    { key: 'addressLine2', re: /address (line )?2|\bapt\b|apartment|suite|\bunit\b|address2/, get: (p) => p.addressLine2 },
    { key: 'addressLine1', re: /address|street/, not: /mail|city|state|zip|postal|country|line 2|address2/, get: (p) => p.addressLine1 },
    { key: 'city', re: /\bcity\b|\btown\b|locality/, get: (p) => p.city },
    { key: 'zip', re: /zip|post ?code|postal/, get: (p) => p.zip },
    { key: 'state', re: /\bstate\b|province|\bregion\b/, not: /united states|country|statement/, get: (p) => p.state },
    { key: 'country', re: /country|nationality/, not: /code|county/, get: (p) => p.country },
    { key: 'location', re: /location|where (do you|are you) (live|based|located)/, not: /office|preferred|willing/, get: (p) => [p.city, p.state, p.country].filter(Boolean).join(', ') },
    // EEO / self-identification questions come before work-detail rules: their
    // surrounding legalese often contains words like "compensation" that would
    // otherwise trigger the salary rule.
    { key: 'pronouns', re: /pronoun/, get: (p) => p.pronouns },
    { key: 'gender', re: /gender|\bsex\b/, not: /orientation|transgender/, get: (p) => p.gender },
    { key: 'hispanic', re: /hispanic|latin/, get: (p) => p.hispanic },
    { key: 'race', re: /\brace\b|ethnicit|ethnic (group|background|origin)/, not: /hispanic/, get: (p) => p.race },
    { key: 'veteran', re: /veteran|military status/, get: (p) => p.veteran },
    { key: 'disability', re: /disabilit|disabled|impairment/, get: (p) => p.disability },
    { key: 'currentCompany', re: /current (company|employer)|company ?name|\bemployer\b|organi[sz]ation|most recent (company|employer)/, get: (p) => p.currentCompany },
    { key: 'currentTitle', re: /(current|job|recent) title|current (role|position)|title of your (current|recent)/, get: (p) => p.currentTitle },
    { key: 'yearsOfExperience', re: /years? of (relevant |work |professional |related )*experience|experience in years|how many years/, get: (p) => p.yearsOfExperience },
    { key: 'salary', re: /salary|compensation|expected pay|pay (expectation|range)|desired pay|remuneration/, not: /veteran|military|disabilit/, get: (p) => p.salaryExpectation },
    { key: 'noticePeriod', re: /notice period|weeks? of notice/, get: (p) => p.noticePeriod },
    { key: 'availableDate', re: /start date|available to start|earliest (start|date)|availability date|date available|when can you (start|join)/, get: (p) => p.availableDate },
    // Signature rows ("Name ___  Date ___") at the end of EEO/voluntary forms.
    {
      key: 'signatureDate',
      re: /(^|\s)date(\s|$)|today s date|current date|date signed/,
      not: /birth|dob|start|end|expir|graduat|available|interview|hire|until|from|candidate/,
      get: () => {
        const d = new Date();
        return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
      },
    },
    { key: 'signature', re: /signature/, not: /date/, get: (p) => [p.firstName, p.lastName].filter(Boolean).join(' ') },
    { key: 'school', re: /school|university|college|institution|alma mater/, get: (p) => p.school },
    { key: 'degree', re: /degree|qualification|education level|highest level of education/, get: (p) => p.degree },
    { key: 'major', re: /\bmajor\b|field of study|discipline|concentration|area of study/, get: (p) => p.major },
    { key: 'graduationYear', re: /graduation|grad year|year of completion/, get: (p) => p.graduationYear },
    { key: 'gpa', re: /\bgpa\b|grade point/, get: (p) => p.gpa },
    {
      key: 'coverLetter',
      re: /cover ?letter|why (do you want|are you interested|would you like)|motivation letter|tell us why/,
      get: (p) => p.coverLetter
        || `Dear Hiring Manager,\n\nI am excited to apply for the {job_title} position. My background and experience align closely with the requirements of this role, and I am confident I can contribute meaningfully to your team.\n\nThank you for your time and consideration.\n\nSincerely,\n${[p.firstName, p.lastName].filter(Boolean).join(' ')}`,
    },
    { key: 'howDidYouHear', re: /how did you (hear|find|learn)|hear about (us|this)|referral source|where did you (hear|find)/, get: (p) => p.howDidYouHear },
    { key: 'authorizedToWork', re: /(legally )?authori[sz]ed to work|work authori[sz]ation|eligible to work|legally (able|permitted|entitled) to work|right to work|lawfully employed/, get: (p) => p.authorizedToWork },
    { key: 'requiresSponsorship', re: /sponsor/, get: (p) => p.requiresSponsorship },
    { key: 'willingToRelocate', re: /relocat/, get: (p) => p.willingToRelocate },
    { key: 'over18', re: /(over|at least|older than) (the age of )?18|18 years (of age )?or older/, get: (p) => p.over18 },
  ];

  /** Consent-style checkboxes we never touch unless a custom answer explicitly matches. */
  const CONSENT_RE = /agree|terms|privacy|consent|acknowledg|certif|signature|subscribe|newsletter|policy|gdpr|captcha|robot|human check/;

  /**
   * Haystacks to try for an option group, most specific first: the group's
   * own label, then the label plus nearby heading context (for forms whose
   * real question lives in a heading above a generic "check one" prompt).
   */
  function groupHays(inputs) {
    const base = norm(getGroupLabel(inputs) + ' ' + getAttrText(inputs[0]));
    const hays = base ? [base] : [];
    const heading = norm(headingContext(inputs[0]));
    if (heading) hays.push((heading + ' ' + base).trim());
    return hays;
  }

  /** User-defined Q&A pairs win over built-in rules. */
  function customAnswerFor(hay, profile) {
    let best = null;
    let bestScore = 0;
    for (const qa of profile.customAnswers || []) {
      const q = norm(qa.question);
      const answer = (qa.answer || '').trim();
      if (!q || !answer) continue;
      let score = 0;
      if (hay.includes(q)) {
        score = 90;
      } else {
        const qTokens = significantTokens(qa.question);
        if (qTokens.length) {
          const hayTokens = new Set(hay.split(' '));
          const hit = qTokens.filter((t) => hayTokens.has(t)).length;
          score = Math.round((hit / qTokens.length) * 80);
        }
      }
      if (score > bestScore) { best = answer; bestScore = score; }
    }
    return bestScore >= 65 ? applyPlaceholders(best) : null;
  }

  /** Resolve the value a field should get, or null. */
  function resolveValue(hay, profile) {
    if (!hay) return null;
    const custom = customAnswerFor(hay, profile);
    if (custom) return { value: custom, source: 'custom' };
    for (const rule of RULES) {
      if (!rule.re.test(hay)) continue;
      if (rule.not && rule.not.test(hay)) continue;
      const v = (rule.get(profile) || '').toString().trim();
      if (v) return { value: applyPlaceholders(v), source: rule.key };
    }
    return null;
  }

  function isCombobox(el) {
    if (el.tagName !== 'INPUT') return false;
    return el.getAttribute('role') === 'combobox'
      || el.getAttribute('aria-autocomplete') === 'list'
      || (el.closest('[role="combobox"]') !== null && el.getAttribute('aria-expanded') !== null);
  }

  // ---------------------------------------------------------------------
  // Main fill pass
  // ---------------------------------------------------------------------

  /**
   * All form controls on the page, including ones inside open shadow roots —
   * ADP WorkforceNow, Workday and other modern ATSes render fields inside web
   * components that document.querySelectorAll cannot see.
   */
  function collectControls() {
    const out = [];
    const walk = (root) => {
      let all;
      try { all = root.querySelectorAll('*'); } catch (e) { return; }
      for (const el of all) {
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  }

  async function runFill(profile, { auto = false } = {}) {
    const stats = { filled: 0, matched: 0 };
    if (!profile) return stats;

    const seenRadioGroups = new Set();
    const seenCheckboxGroups = new Set();
    const controls = collectControls();

    for (const el of controls) {
      try {
        if (auto && autoProcessed.has(el)) continue;
        if (!isUsable(el)) continue;
        const type = (el.type || '').toLowerCase();
        if (type === 'password' || type === 'search' || type === 'submit' || type === 'button' || type === 'image' || type === 'reset') continue;

        // ---- file inputs (resume / cover letter) ----
        if (type === 'file') {
          const hay = getHaystack(el);
          let fileData = null;
          if (/cover ?letter/.test(hay)) fileData = profile.coverLetterFile;
          else if (/resume|\bcv\b|curriculum|attach|upload/.test(hay) || hay === '') fileData = profile.resumeFile;
          if (fileData && fileData.dataUrl) {
            stats.matched++;
            if (fillFile(el, fileData)) stats.filled++;
            if (auto) autoProcessed.add(el);
          }
          continue;
        }

        // ---- radio groups (process once per group) ----
        if (type === 'radio') {
          const root = el.form || el.getRootNode();
          const groupKey = (el.form ? 'f' : 'd') + ':' + el.name;
          if (el.name && seenRadioGroups.has(groupKey)) continue;
          if (el.name) seenRadioGroups.add(groupKey);
          const radios = el.name
            ? [...root.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)].filter(isUsable)
            : [el];
          if (!radios.length) continue;
          let resolved = null;
          for (const hay of groupHays(radios)) {
            resolved = resolveValue(hay, profile);
            if (resolved) break;
          }
          if (resolved) {
            stats.matched++;
            if (fillRadioGroup(radios, resolved.value)) stats.filled++;
          }
          if (auto) radios.forEach((r) => autoProcessed.add(r));
          continue;
        }

        // ---- checkboxes ----
        if (type === 'checkbox') {
          // Several checkboxes sharing a name = a "check all that apply"
          // question; use the group's question text, like radio groups.
          if (el.name) {
            const groupKey = (el.form ? 'f' : 'd') + ':' + el.name;
            if (seenCheckboxGroups.has(groupKey)) continue;
            seenCheckboxGroups.add(groupKey);
            const root = el.form || el.getRootNode();
            const boxes = [...root.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(el.name)}"]`)].filter(isUsable);
            if (boxes.length > 1) {
              let groupValue = null;
              for (const groupHay of groupHays(boxes)) {
                groupValue = customAnswerFor(groupHay, profile);
                if (!groupValue && !CONSENT_RE.test(groupHay)) {
                  const resolved = resolveValue(groupHay, profile);
                  if (resolved) groupValue = resolved.value;
                }
                if (groupValue) break;
              }
              if (groupValue) {
                stats.matched++;
                if (fillCheckboxGroup(boxes, groupValue)) stats.filled++;
              }
              if (auto) boxes.forEach((b) => autoProcessed.add(b));
              continue;
            }
          }
          // Single checkbox: explicit custom answers always apply; built-in
          // rules apply too, but never to consent/terms boxes.
          const hay = getHaystack(el);
          let value = customAnswerFor(hay, profile);
          if (!value && !CONSENT_RE.test(hay)) {
            const resolved = resolveValue(hay, profile);
            if (resolved) value = resolved.value;
          }
          if (value) {
            stats.matched++;
            if (fillCheckbox(el, value)) stats.filled++;
          }
          if (auto) autoProcessed.add(el);
          continue;
        }

        // ---- selects ----
        if (el.tagName === 'SELECT') {
          const hay = getHaystack(el);
          const resolved = resolveValue(hay, profile);
          if (resolved) {
            stats.matched++;
            if (fillSelect(el, resolved.value)) stats.filled++;
          }
          if (auto) autoProcessed.add(el);
          continue;
        }

        // ---- text-ish inputs and textareas ----
        const hay = getHaystack(el);
        const resolved = resolveValue(hay, profile);
        if (!resolved) continue;
        stats.matched++;
        if (isCombobox(el)) {
          if (await fillCombobox(el, resolved.value)) stats.filled++;
        } else if (fillText(el, resolved.value)) {
          stats.filled++;
        }
        if (auto) autoProcessed.add(el);
      } catch (e) {
        // keep going — one bad field must not stop the pass
      }
    }
    return stats;
  }

  // ---------------------------------------------------------------------
  // Page detection + auto-run
  // ---------------------------------------------------------------------

  const ATS_HOST_RE = /greenhouse\.io|lever\.co|myworkday(jobs|site)?\.com|workday|ashbyhq\.com|smartrecruiters\.com|icims\.com|jobvite\.com|workable\.com|bamboohr\.com|breezy\.hr|applytojob\.com|jazz(hr)?\.co|taleo\.net|successfactors|oraclecloud\.com|adp\.com|recruitee\.com|teamtailor\.com|dover\.com|rippling\.com|greenhouse\.dev|wellfound\.com|jobs\.apple\.com|pinpointhq\.com|factorialhr|personio|join\.com/i;

  function looksLikeJobApplication() {
    if (ATS_HOST_RE.test(location.hostname)) return true;
    const hasFile = !!document.querySelector('input[type="file"]');
    const hasEmail = !!document.querySelector('input[type="email"], input[name*="email" i], input[id*="email" i]');
    if (hasFile && hasEmail) {
      const bodyText = norm((document.body?.innerText || '').slice(0, 8000));
      return /resume|curriculum|cover letter|apply|application/.test(bodyText);
    }
    return false;
  }

  function getState() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ profile: null, settings: { autoFill: true } }, (data) => {
          resolve(data || { profile: null, settings: { autoFill: true } });
        });
      } catch (e) {
        resolve({ profile: null, settings: { autoFill: false } });
      }
    });
  }

  function reportStats(stats, auto) {
    if (!stats.filled) return;
    try {
      chrome.runtime.sendMessage({ type: 'FILL_STATS', filled: stats.filled, auto: !!auto, href: location.href });
    } catch (e) { /* extension context gone */ }
  }

  let autoRunning = false;
  let autoPending = false;
  async function autoPass() {
    if (autoRunning) { autoPending = true; return; } // queue, don't drop
    autoRunning = true;
    try {
      const { profile, settings } = await getState();
      if (!profile || !settings || !settings.autoFill) return;
      if (!looksLikeJobApplication()) return;
      const stats = await runFill(profile, { auto: true });
      reportStats(stats, true);
    } finally {
      autoRunning = false;
      if (autoPending) {
        autoPending = false;
        setTimeout(autoPass, 50);
      }
    }
  }

  function debounce(fn, ms) {
    let t = null;
    return () => {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  async function initAutoRun() {
    const { profile, settings } = await getState();
    if (!profile || !settings || !settings.autoFill) return;
    // Many ATS forms render/expand after load — watch for late fields for a
    // while. Register the observer BEFORE the first pass so fields added while
    // that pass runs are not missed.
    if (document.body) {
      const debounced = debounce(autoPass, 900);
      const mo = new MutationObserver(debounced);
      mo.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 45000);
    }
    await sleep(700);
    await autoPass();
  }

  // ---------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'FILL') {
      getState().then(async ({ profile }) => {
        const stats = await runFill(profile, { auto: false });
        reportStats(stats, false);
        sendResponse(stats);
      });
      return true; // async response
    }
    if (msg && msg.type === 'PING') {
      sendResponse({ ok: true });
    }
    return undefined;
  });

  initAutoRun();
})();
