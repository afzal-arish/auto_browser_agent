// Auto Browser Agent — background service worker (Manifest V3).
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Pages Chrome extensions are not allowed to script. Best-effort list; the
// injection attempt itself is also caught and mapped to a friendly message.
const RESTRICTED_SCHEMES = [
  "chrome:", "chrome-extension:", "chrome-untrusted:", "devtools:",
  "edge:", "brave:", "opera:", "vivaldi:", "about:", "view-source:", "data:"
];
const RESTRICTED_HOSTS = ["chromewebstore.google.com", "chrome.google.com"];

function isRestrictedUrl(url) {
  if (!url) return false; // unknown URL: let the injection attempt decide
  try {
    const u = new URL(url);
    if (RESTRICTED_SCHEMES.includes(u.protocol)) return true;
    return RESTRICTED_HOSTS.some(h => u.hostname === h || u.hostname.endsWith("." + h));
  } catch {
    return false;
  }
}

// 1. Try communicating with the content script.
// 2. If the receiver does not exist, inject content/content.js.
// 3. Wait briefly for initialization.
// 4. Retry the message.
// 5. Return a useful error if injection is impossible.
// Never blindly re-injects: if a ping succeeds, the script is already there.
async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "AGENT_PING" });
    if (res && res.ok) return { ok: true, injected: false };
  } catch {
    // no receiver yet — fall through to injection
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/content.js"] });
  } catch (e) {
    console.warn("Could not inject content script:", e?.message);
    return { ok: false, error: "Cannot inject content script into this page." };
  }

  await sleep(200);
  for (let i = 0; i < 5; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "AGENT_PING" });
      if (res && res.ok) return { ok: true, injected: true };
    } catch {
      // still initializing — keep waiting
    }
    await sleep(150);
  }
  return { ok: false, error: "Content script did not initialize on this page." };
}

// Centralized messaging: ensure the content script exists, send the message,
// and retry once if the receiver disappears mid-flight. Always resolves to a
// structured { ok, error, result } — never throws "Receiving end does not exist".
async function sendToTab(tabId, message) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, error: "The tab is no longer available." };
  if (isRestrictedUrl(tab.url)) {
    return { ok: false, error: "This page cannot be automated by a Chrome extension. Open a normal webpage and try again." };
  }

  const ensured = await ensureContentScript(tabId);
  if (!ensured.ok) return ensured;

  try {
    const result = await chrome.tabs.sendMessage(tabId, message);
    return { ok: true, result };
  } catch (e) {
    console.warn("Receiver disappeared, re-ensuring content script:", e?.message);
    const re = await ensureContentScript(tabId);
    if (!re.ok) return re;
    try {
      const result = await chrome.tabs.sendMessage(tabId, message);
      return { ok: true, result };
    } catch (e2) {
      console.warn("Message still failed after re-ensuring:", e2?.message);
      return { ok: false, error: "Could not reach the page. It may have navigated or been closed." };
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "GET_ACTIVE_TAB") {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      sendResponse({ ok: true, tab: tabs?.[0] });
      return;
    }
    if (msg?.type === "SEND_TO_TAB" && Number.isInteger(msg.tabId)) {
      sendResponse(await sendToTab(msg.tabId, msg.message));
      return;
    }
    sendResponse({ ok: false, error: "Unknown message type." });
  })().catch(e => sendResponse({ ok: false, error: e.message }));
  return true;
});