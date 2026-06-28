// Service worker: open the side panel when the toolbar icon is clicked.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn("setPanelBehavior failed:", err));
});

// Fallback for browsers/versions where openPanelOnActionClick is unavailable.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (err) {
    console.warn("sidePanel.open failed:", err);
  }
});
