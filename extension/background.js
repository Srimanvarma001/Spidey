// crawler.js toggles itself: a second injection into the same tab calls the spider back.
// It reports its state with a message, which is all the bookkeeping the toolbar button needs.

const TITLE_OFF = 'Release the spider';
const TITLE_ON = 'Call the spider back (or press Esc)';
const TITLE_BLOCKED = 'The spider cannot crawl this page';

chrome.action.setBadgeBackgroundColor({ color: '#ff3e6e' });
// Not in every Chromium version; the default badge text colour is fine without it.
if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' });

// These calls fail if the tab was closed in the meantime, which needs no handling.
function setState(tabId, text, title) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setTitle({ tabId, title }).catch(() => {});
}

chrome.action.onClicked.addListener((tab) => {
  chrome.scripting
    .executeScript({ target: { tabId: tab.id }, files: ['crawler.js'] })
    .catch(() => {
      // Pages the browser protects (chrome://, the Web Store, the PDF viewer) cannot be
      // scripted. Say so on the button for a moment instead of doing nothing.
      setState(tab.id, '!', TITLE_BLOCKED);
      setTimeout(() => setState(tab.id, '', TITLE_OFF), 2500);
    });
});

// Sent by crawler.js when the spider starts and when it leaves, whichever way it leaves
// (button, shortcut or Esc). Badge and title set per tab reset themselves on navigation.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!sender.tab || typeof message.webCrawler !== 'boolean') return;
  setState(sender.tab.id, message.webCrawler ? 'ON' : '', message.webCrawler ? TITLE_ON : TITLE_OFF);
});
