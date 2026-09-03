const MODEL = "openai/gpt-oss-120b";
const MAX_STEPS = 30;
const $ = id => document.getElementById(id);

let running = false;
let session = 0; // bumped on every Start/Stop so stale loop iterations can never act

function log(x) {
  const d = document.createElement("div");
  d.className = "item";
  d.textContent = x;
  $("log").prepend(d);
}
function status(x) { $("status").textContent = x; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

chrome.storage.local.get(["groqKey"], r => { if (r.groqKey) $("key").value = r.groqKey; });
$("key").addEventListener("change", () => chrome.storage.local.set({ groqKey: $("key").value.trim() }));

function stopAgent() {
  session++; // invalidate every pending loop iteration
  running = false;
  status("Stopped");
  log("Agent stopped by user.");
  $("start").disabled = false;
  $("stop").disabled = true;
}
$("stop").onclick = stopAgent;

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !tab.id) throw new Error("No active tab found. Open a webpage and try again.");
  return tab;
}

// Centralized messaging. Finds the active tab (unless a tabId is passed, in
// which case the agent keeps driving the tab it started on), ensures the content
// script is available via the background worker, and sends with one retry.
// Always resolves to a structured { ok, error, ... }; never throws
// "Could not establish connection".
async function sendToActiveTab(message, tabId) {
  let id = tabId;
  if (id === undefined) {
    try {
      const tab = await activeTab();
      id = tab.id;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: "SEND_TO_TAB", tabId: id, message });
    if (!res || typeof res !== "object") return { ok: false, error: "No response from the background service worker." };
    return res;
  } catch {
    return { ok: false, error: "Could not reach the background service worker." };
  }
}

function systemPrompt() {
  return `You are a browser task planner. Decide ONE safe browser action at a time.
Return ONLY valid JSON:
{"action":"click","element_id":12}
{"action":"type","element_id":12,"text":"hello"}
{"action":"select","element_id":12,"value":"x"}
{"action":"scroll","direction":"down"}
{"action":"scroll","direction":"up"}
{"action":"wait","milliseconds":500}
{"action":"done"}

Rules:
- Use only element_id values present in the latest observation. Never invent an element ID.
- Prefer visible, clearly labeled controls.
- If the goal is already satisfied, or cannot be completed on this page, respond with {"action":"done"}.
- Do not navigate to unrelated sites.
- Do not expose or transmit passwords, API keys, authentication tokens, or other secrets.
- Do not make purchases, send messages, submit sensitive forms, or perform destructive actions without an explicit confirmation step from the user.
- Take exactly one action.`;
}

async function plan(key, goal, obs, hint) {
  const userContent = `USER GOAL:\n${goal}\n\nCURRENT PAGE:\n${JSON.stringify(obs)}${hint ? `\n\n${hint}` : ""}`;
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt() },
      { role: "user", content: userContent }
    ],
    temperature: 0,
    max_tokens: 300,
    response_format: { type: "json_object" }
  };
  let delay = 1000;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (r.status === 429) {
      log("Groq rate limit reached; backing off...");
      await sleep(delay);
      delay *= 2;
      continue;
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error?.message || `Groq HTTP ${r.status}`);
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("Model returned no action.");
    const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    let action;
    try {
      action = JSON.parse(cleaned);
    } catch {
      throw new Error("Model returned invalid JSON.");
    }
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new Error("Model returned an invalid action.");
    }
    return action;
  }
  throw new Error("Groq rate limit persisted after retries.");
}

function validateAction(a) {
  const valid = new Set(["click", "type", "select", "scroll", "wait", "done"]);
  if (!a || typeof a !== "object") throw new Error("Invalid action from model.");
  if (!valid.has(a.action)) throw new Error(`Model returned unsupported action: ${a.action}`);
  if (["click", "type", "select"].includes(a.action) &&
      (a.element_id === undefined || a.element_id === null)) {
    throw new Error(`Action "${a.action}" is missing element_id.`);
  }
  if (a.action === "type" && typeof a.text !== "string") throw new Error('Action "type" is missing text.');
  if (a.action === "select" && typeof a.value !== "string") throw new Error('Action "select" is missing value.');
  if (a.action === "scroll" && a.direction !== "up" && a.direction !== "down") {
    throw new Error('Action "scroll" needs direction "up" or "down".');
  }
  if (a.action === "wait" && (!Number.isFinite(a.milliseconds) || a.milliseconds < 0)) {
    throw new Error('Action "wait" needs a positive milliseconds value.');
  }
}

function actionLabel(a) {
  if (!a) return "unknown action";
  switch (a.action) {
    case "click": return `click element ${a.element_id}`;
    case "type": return `type into element ${a.element_id}`;
    case "select": return `select "${a.value}" on element ${a.element_id}`;
    case "scroll": return `scroll ${a.direction}`;
    case "wait": return `wait ${a.milliseconds}ms`;
    case "done": return "done";
    default: return JSON.stringify(a);
  }
}

// Polls the content script's mutation revision so the agent can tell whether the
// page meaningfully changed after an action (navigation, new button, modal, ...).
async function waitForPageChange(tabId, sinceRevision, mySession, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!running || session !== mySession) return { changed: false };
    await sleep(300);
    try {
      const res = await sendToActiveTab({ type: "AGENT_PAGE_CHANGED", since: sinceRevision }, tabId);
      if (res?.ok && res.result && res.result.changed) {
        return { changed: true, revision: res.result.revision };
      }
    } catch {
      // page may be navigating; keep polling
    }
  }
  return { changed: false };
}

async function runAgent(key, goal, tab, mySession) {
  const alive = () => running && session === mySession;
  let lastActionNote = "";
  try {
    log("Active tab detected");

    // First observe also verifies (and, if needed, injects) the content script.
    let observed = await sendToActiveTab({ type: "AGENT_OBSERVE" }, tab.id);
    if (!observed.ok || !observed.result?.snapshot) throw new Error(observed.error || "Could not observe the page.");
    log("Content script ready");
    log("Page observed");
    let snapshot = observed.result.snapshot;

    for (let step = 1; step <= MAX_STEPS; step++) {
      if (!alive()) return;
      log(`Interactive elements: ${snapshot.elements.length}`);
      log("Asking GPT-OSS 120B");

      const action = await plan(key, goal, snapshot, lastActionNote);
      if (!alive()) return;
      log(`Action: ${actionLabel(action)}`);

      if (action.action === "done") {
        status("Done");
        log("Agent reports the goal is complete.");
        return;
      }
      validateAction(action);

      const exec = await sendToActiveTab({ type: "AGENT_EXECUTE", action }, tab.id);
      if (!alive()) return;
      if (!exec.ok) {
        // Stale element (page changed under us): re-observe and ask the model
        // for a fresh action instead of using the dead element.
        if (/re-observe|no longer available/i.test(exec.error || "")) {
          log("Page changed; re-observing...");
          lastActionNote = `Previous action (${actionLabel(action)}) failed because its target element disappeared. The page was re-observed.`;
          await sleep(600);
          if (!alive()) return;
          const re = await sendToActiveTab({ type: "AGENT_OBSERVE" }, tab.id);
          if (!re.ok || !re.result?.snapshot) throw new Error(re.error || "Could not observe the page.");
          snapshot = re.result.snapshot;
          log("Page observed");
          continue;
        }
        throw new Error(exec.error);
      }
      log("Action executed");

      const changed = await waitForPageChange(tab.id, snapshot.revision, mySession);
      if (!alive()) return;
      if (changed.changed) {
        log("Page changed");
        lastActionNote = `Previous action (${actionLabel(action)}) executed successfully and the page changed.`;
      } else {
        log("No page change detected");
        lastActionNote = `Previous action (${actionLabel(action)}) executed but the page did not change. Choose a different action or respond with done.`;
      }

      await sleep(250);
      if (!alive()) return;
      const next = await sendToActiveTab({ type: "AGENT_OBSERVE" }, tab.id);
      if (!next.ok || !next.result?.snapshot) throw new Error(next.error || "Could not observe the page.");
      snapshot = next.result.snapshot;
      log("Page observed");
    }
    log(`Reached the ${MAX_STEPS}-step safety cap. Stopping.`);
  } catch (e) {
    log(`ERROR: ${e.message}`);
    status("Error");
  }
}

$("start").onclick = async () => {
  if (running) return; // never start a duplicate loop
  const key = $("key").value.trim(), goal = $("goal").value.trim();
  if (!key) return log("Enter your Groq API key.");
  if (!goal) return log("Enter a task.");
  chrome.storage.local.set({ groqKey: key });

  running = true;
  session++; // invalidate any previous run still unwinding
  const mySession = session;
  $("start").disabled = true;
  $("stop").disabled = false;
  status("Running");
  $("log").innerHTML = "";
  log("Agent started");
  log(`Task: ${goal}`);

  try {
    const tab = await activeTab();
    await runAgent(key, goal, tab, mySession);
  } catch (e) {
    log(`ERROR: ${e.message}`);
    status("Error");
  } finally {
    running = false;
    $("start").disabled = false;
    $("stop").disabled = true;
    if ($("status").textContent === "Running") status("Idle");
  }
};