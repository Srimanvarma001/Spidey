// crawler.js toggles itself: a second injection into the same tab removes the spider.
chrome.action.onClicked.addListener((tab) => {
  chrome.scripting
    .executeScript({ target: { tabId: tab.id }, files: ['crawler.js'] })
    .catch(() => {
      // Pages the browser protects (chrome://, the Web Store) cannot be scripted.
    });
});
