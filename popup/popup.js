/** Job AutoFill — popup logic. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const CORE_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'city', 'country', 'linkedin'];

  function setStatus(text, cls) {
    const el = $('status');
    el.textContent = text;
    el.className = cls || '';
  }

  // ---------------- profile summary ----------------

  chrome.storage.local.get({ profile: null, settings: { autoFill: true } }, ({ profile, settings }) => {
    $('auto-toggle').checked = !!(settings && settings.autoFill !== false);

    if (!profile || !profile.email) {
      $('setup-warning').hidden = false;
      return;
    }
    const total = CORE_FIELDS.length + 1; // +1 for resume
    let have = CORE_FIELDS.filter((k) => (profile[k] || '').trim()).length;
    if (profile.resumeFile && profile.resumeFile.dataUrl) have++;
    const pct = Math.round((have / total) * 100);
    $('completeness-wrap').hidden = false;
    $('bar-fill').style.width = pct + '%';
    $('completeness-text').textContent = `Profile ${pct}%`;
  });

  // ---------------- auto-fill toggle ----------------

  $('auto-toggle').addEventListener('change', (e) => {
    chrome.storage.local.get({ settings: { autoFill: true } }, ({ settings }) => {
      settings = settings || {};
      settings.autoFill = e.target.checked;
      chrome.storage.local.set({ settings });
    });
  });

  // ---------------- fill button ----------------

  $('fill-btn').addEventListener('click', async () => {
    const btn = $('fill-btn');
    btn.disabled = true;
    setStatus('Filling…');

    // Every frame that fills something reports FILL_STATS; sum them briefly
    // so counts from embedded iframes (Greenhouse etc.) are included.
    let total = 0;
    const listener = (msg) => {
      if (msg && msg.type === 'FILL_STATS' && !msg.auto) total += msg.filled || 0;
    };
    chrome.runtime.onMessage.addListener(listener);

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.id == null) throw new Error('no tab');
      await chrome.tabs.sendMessage(tab.id, { type: 'FILL' });
    } catch (e) {
      chrome.runtime.onMessage.removeListener(listener);
      btn.disabled = false;
      setStatus('Cannot fill this page. Try reloading the tab first.', 'error');
      return;
    }

    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      btn.disabled = false;
      if (total > 0) {
        setStatus(`Filled ${total} field${total === 1 ? '' : 's'} ✓`, 'success');
      } else {
        setStatus('No matching empty fields found on this page.');
      }
    }, 1800);
  });

  // ---------------- options link ----------------

  $('open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();
