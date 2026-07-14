/**
 * Job AutoFill — background service worker.
 * Context-menu trigger + per-tab badge showing how many fields were filled.
 */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'job-autofill-fill',
      title: 'Autofill this job application',
      contexts: ['page', 'editable'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'job-autofill-fill' && tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'FILL' }).catch(() => { /* no content script on this page */ });
  }
});

// Aggregate fill counts per tab (frames report independently) into the badge.
const tabCounts = new Map();

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'FILL_STATS' && sender.tab && sender.tab.id != null) {
    const tabId = sender.tab.id;
    const total = (tabCounts.get(tabId) || 0) + (msg.filled || 0);
    tabCounts.set(tabId, total);
    if (total > 0) {
      chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
      chrome.action.setBadgeText({ tabId, text: String(total) });
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabCounts.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabCounts.delete(tabId);
});
