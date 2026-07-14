# Job AutoFill (Chrome Extension)

A Chrome extension that works like Jobright Autofill: when you open a job application page,
it automatically fills the form with your pre-configured data — text fields, dropdowns,
radio-button questions, resume upload, and phone country codes.

## Features

- **Auto-fill on page load** — detects job application pages (Greenhouse, Lever, Workday,
  Ashby, SmartRecruiters, iCIMS, Workable, BambooHR, Taleo, and more, plus a generic
  resume-form heuristic) and fills them automatically. Can be toggled off in settings or the popup.
- **Manual fill** — toolbar popup button ("Fill this page") or right-click → *Autofill this job application*.
- **Text fields** — name, email, phone, address, links (LinkedIn/GitHub/portfolio), company,
  title, salary, notice period, education, cover letter, and more, matched by label,
  placeholder, `aria-label`, and `name`/`id` attributes.
- **Dropdowns** — picks the best-matching option with fuzzy scoring plus alias handling
  ("United States" ↔ "USA" ↔ "United States of America", US state names ↔ abbreviations,
  "Prefer not to say" variants, etc.).
- **Phone country codes** — "+1" correctly selects options like "United States (+1)".
- **Question answering** — radio groups and selects for work authorization, visa sponsorship,
  relocation, EEO self-identification (gender, race/ethnicity, veteran, disability), and any
  **custom Q&A pairs** you define (custom answers take priority over built-ins).
- **Resume / cover-letter upload** — your saved files are attached to matching
  `<input type="file">` fields (respects the field's `accept` filter).
- **ARIA combobox support** — best-effort typing + option-click for React-style autocomplete
  widgets used by modern ATSes.
- **Works inside iframes** — embedded application forms (e.g. Greenhouse boards) are filled too.
- **Feedback** — filled fields flash green; the toolbar badge shows how many fields were filled.

## Safety by design

- Never clicks **Submit** — you always review and send the application yourself.
- Never overwrites values you've already typed.
- Never checks consent/terms/privacy checkboxes (unless you explicitly configure a matching
  custom answer).
- Skips password fields.
- All data (including the resume file) is stored **locally** via `chrome.storage.local`;
  nothing is sent anywhere.

## Install

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder (`AutoFill`).

## Setup

1. Click the extension icon → **Edit profile & answers** (or right-click the icon → Options).
2. Fill in your personal info, links, work/education details, eligibility answers,
   EEO answers, and upload your resume (PDF/DOC/DOCX, up to 8 MB).
3. Add **custom questions & answers** for anything else forms ask you
   (e.g. question contains "security clearance" → answer "No").
4. Click **Save settings**.

## Use

- With auto-fill enabled (default), just open a job application page — fields fill automatically
  and flash green.
- Or click the toolbar icon → **Fill this page**, or right-click the page →
  **Autofill this job application**.
- Review everything, attach anything that's missing, and submit yourself.

## Project layout

```
manifest.json          MV3 manifest
background.js          Service worker: context menu + badge counts
content/content.js     Fill engine: field detection, label matching, fillers
popup/                 Toolbar popup (fill button, auto-fill toggle, profile meter)
options/               Settings page (profile, documents, custom Q&A)
icons/                 Extension icons
```
