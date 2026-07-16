/** Job AutoFill — options page logic. */
(() => {
  'use strict';

  const TEXT_FIELDS = [
    'firstName', 'middleName', 'lastName', 'email', 'phoneCountryCode', 'phone', 'pronouns',
    'addressLine1', 'addressLine2', 'city', 'state', 'zip', 'country',
    'linkedin', 'github', 'portfolio', 'twitter',
    'currentCompany', 'currentTitle', 'yearsOfExperience', 'salaryExpectation',
    'noticePeriod', 'availableDate', 'howDidYouHear', 'coverLetter',
    'school', 'degree', 'major', 'graduationYear', 'gpa',
    'authorizedToWork', 'requiresSponsorship', 'willingToRelocate', 'over18',
    'startImmediately', 'teamLeadExperience', 'visaType', 'interviewConsent',
    'gender', 'hispanic', 'race', 'veteran', 'disability', 'sexualOrientation', 'communities',
    'transgender', 'ageRange', 'contactConsent',
  ];

  const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB

  const $ = (id) => document.getElementById(id);

  // In-memory copies of the stored files ({name, type, size, dataUrl} or null).
  const files = { resumeFile: null, coverLetterFile: null };

  // ---------------- load ----------------

  function load() {
    chrome.storage.local.get({ profile: {}, settings: { autoFill: true } }, ({ profile, settings }) => {
      profile = profile || {};
      for (const key of TEXT_FIELDS) {
        const el = $(key);
        if (el && profile[key] != null) el.value = profile[key];
      }
      $('setting-autoFill').checked = settings && settings.autoFill !== false;

      files.resumeFile = profile.resumeFile || null;
      files.coverLetterFile = profile.coverLetterFile || null;
      renderFileStatus('resume', files.resumeFile);
      renderFileStatus('coverLetterFile', files.coverLetterFile);

      const list = $('qa-list');
      list.innerHTML = '';
      for (const qa of profile.customAnswers || []) addQaRow(qa.question, qa.answer);
      if (!(profile.customAnswers || []).length) addQaRow('', '');
    });
  }

  // ---------------- files ----------------

  function humanSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function renderFileStatus(prefix, fileData) {
    const status = $(prefix + '-status');
    const removeBtn = $(prefix + '-remove');
    if (fileData) {
      status.textContent = `${fileData.name} (${humanSize(fileData.size)})`;
      status.classList.add('has-file');
      removeBtn.hidden = false;
    } else {
      status.textContent = 'No file saved.';
      status.classList.remove('has-file');
      removeBtn.hidden = true;
    }
  }

  function wireFilePicker(prefix, inputId, storeKey) {
    const input = $(inputId);
    $(prefix + '-pick').addEventListener('click', () => input.click());
    $(prefix + '-remove').addEventListener('click', () => {
      files[storeKey] = null;
      input.value = '';
      renderFileStatus(prefix, null);
      setStatus('Click "Save settings" to confirm removal.', false);
    });
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (file.size > MAX_FILE_BYTES) {
        setStatus(`File is too large (${humanSize(file.size)}). Max is ${humanSize(MAX_FILE_BYTES)}.`, true);
        input.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        files[storeKey] = { name: file.name, type: file.type, size: file.size, dataUrl: reader.result };
        renderFileStatus(prefix, files[storeKey]);
        setStatus('File loaded — click "Save settings" to store it.', false);
      };
      reader.onerror = () => setStatus('Could not read the file.', true);
      reader.readAsDataURL(file);
    });
  }

  wireFilePicker('resume', 'resumeFile', 'resumeFile');
  wireFilePicker('coverLetterFile', 'coverLetterFileInput', 'coverLetterFile');

  // ---------------- custom Q&A ----------------

  function addQaRow(question, answer) {
    const tpl = $('qa-row-template');
    const row = tpl.content.firstElementChild.cloneNode(true);
    row.querySelector('.qa-question').value = question || '';
    row.querySelector('.qa-answer').value = answer || '';
    row.querySelector('.qa-remove').addEventListener('click', () => row.remove());
    $('qa-list').appendChild(row);
  }

  $('qa-add').addEventListener('click', () => addQaRow('', ''));

  function collectQa() {
    const rows = [...document.querySelectorAll('.qa-row')];
    return rows
      .map((row) => ({
        question: row.querySelector('.qa-question').value.trim(),
        answer: row.querySelector('.qa-answer').value.trim(),
      }))
      .filter((qa) => qa.question && qa.answer);
  }

  // ---------------- save ----------------

  let statusTimer = null;
  function setStatus(text, isError) {
    const el = $('save-status');
    el.textContent = text;
    el.classList.toggle('error', !!isError);
    clearTimeout(statusTimer);
    if (text) statusTimer = setTimeout(() => { el.textContent = ''; }, 4000);
  }

  $('save').addEventListener('click', () => {
    const profile = {};
    for (const key of TEXT_FIELDS) {
      const el = $(key);
      profile[key] = el ? el.value.trim() : '';
    }
    profile.customAnswers = collectQa();
    profile.resumeFile = files.resumeFile;
    profile.coverLetterFile = files.coverLetterFile;

    const settings = { autoFill: $('setting-autoFill').checked };

    chrome.storage.local.set({ profile, settings }, () => {
      if (chrome.runtime.lastError) {
        setStatus('Save failed: ' + chrome.runtime.lastError.message, true);
      } else {
        setStatus('Saved ✓', false);
      }
    });
  });

  load();
})();
