// Desktop User-Agent for facebook.com. With a mobile UA Facebook serves a different, data-less
// page (no embedded JSON, tiny thumbnails), which the content script cannot use.
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const RULE = {
  id: 1,
  priority: 1,
  action: {
    type: "modifyHeaders",
    requestHeaders: [{ header: "user-agent", operation: "set", value: DESKTOP_UA }]
  },
  condition: {
    requestDomains: ["facebook.com"],
    resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest"]
  }
};

async function apply(enabled) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE.id],
    addRules: enabled ? [RULE] : []
  });
  await chrome.action.setBadgeText({ text: enabled ? "" : "off" });
}

async function sync() {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  await apply(enabled);
}

chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);

// Clicking the toolbar icon toggles the plain view and reloads the tab.
chrome.action.onClicked.addListener(async (tab) => {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  await chrome.storage.local.set({ enabled: !enabled });
  await apply(!enabled);
  if (tab.id) chrome.tabs.reload(tab.id);
});
