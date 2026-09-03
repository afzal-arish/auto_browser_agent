(() => {
  if (window.__autoBrowserAgentLoaded) return;
  window.__autoBrowserAgentLoaded = true;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const SELECTOR = [
    "button", "a[href]", "input", "textarea", "select",
    "[role=button]", "[role=link]", "[role=radio]", "[role=checkbox]",
    "[role=option]", "[role=combobox]", "[contenteditable=true]"
  ].join(",");

  // ---- lightweight change detection --------------------------------
  // A MutationObserver bumps `revision` (debounced) whenever the DOM meaningfully
  // changes (new elements, attribute changes, text changes). The agent uses it to
  // tell whether the page state has changed; it never triggers Groq calls by itself.
  let revision = 0;
  let revisionTimer = null;
  const observer = new MutationObserver(() => {
    if (revisionTimer) return;
    revisionTimer = setTimeout(() => { revisionTimer = null; revision++; }, 300);
  });

  function startObserver() {
    const target = document.documentElement || document.body;
    if (!target) { setTimeout(startObserver, 250); return; }
    observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  } else {
    startObserver();
  }

  // ---- element helpers ----------------------------------------------
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") return false;
    return true;
  }

  // Never leak sensitive values into the model context.
  const SENSITIVE_RE = /pass|pwd|secret|token|api[_-]?key|apikey|authorization|credential|csrf|session|otp|2fa|cvv|card|pin/i;
  function isSensitive(el) {
    const type = (el.getAttribute && el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return true;
    const hay = [
      el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("autocomplete"),
      el.getAttribute("aria-label"), el.getAttribute("placeholder")
    ].filter(Boolean).join(" ");
    return SENSITIVE_RE.test(hay);
  }

  // Scrub obvious credential material (API keys, JWTs, bearer tokens) even when
  // it appears in page text or a value.
  const SECRET_PATTERNS = [
    [/\bgsk_[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
    [/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "[REDACTED]"],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
    [/([?&](?:token|api[_-]?key|apikey|auth|access[_-]?token|session|sid|jwt)=)[^&\s#]+/gi, "$1[REDACTED]"]
  ];
  function scrub(s) {
    if (typeof s !== "string") return s;
    let out = s;
    for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
    return out;
  }

  // ---- observation --------------------------------------------------
  // element_id -> actual DOM element, rebuilt on every AGENT_OBSERVE.
  // IDs always correspond exactly to the elements the executor will use.
  let elementMap = [];

  function elementText(el) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (el.tagName === "INPUT" && (type === "submit" || type === "button" || type === "reset")) {
      return (el.getAttribute("value") || "").trim(); // label of a submit-style button
    }
    return el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
  }

  function buildObservation() {
    const list = [...document.querySelectorAll(SELECTOR)].filter(visible).slice(0, 250);
    elementMap = list; // the exact elements referenced by the returned IDs
    return list.map((el, id) => {
      const r = el.getBoundingClientRect();
      return {
        id,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        name: el.getAttribute("name"),
        text: scrub(elementText(el)).trim().slice(0, 200),
        placeholder: el.getAttribute("placeholder"),
        type: el.getAttribute("type"),
        // current value where safe; omitted entirely for sensitive fields
        value: (typeof el.value === "string" && !isSensitive(el)) ? scrub(el.value).slice(0, 200) : undefined,
        disabled: !!el.disabled,
        checked: el.checked === true ? true : undefined,
        selected: el.selected === true ? true : undefined,
        bounds: {
          x: Math.round(r.x), y: Math.round(r.y),
          width: Math.round(r.width), height: Math.round(r.height)
        }
      };
    });
  }

  function snapshot() {
    return {
      url: scrub(location.href),
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
      revision,
      text: scrub((document.body?.innerText || "").replace(/\s+/g, " ")).slice(0, 12000),
      elements: buildObservation()
    };
  }

  function resolve(id) {
    const el = elementMap[Number(id)];
    // The stored element is authoritative: if it is gone or no longer visible,
    // the ID is stale and the caller must re-observe and re-plan.
    if (!el || !visible(el)) {
      throw new Error("Element is no longer available. Re-observe the page and ask the model for a new action.");
    }
    return el;
  }

  // ---- action execution ---------------------------------------------
  const VALID_ACTIONS = new Set(["click", "type", "select", "scroll", "wait", "done"]);

  function validateAction(action) {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new Error("Invalid action: expected an object.");
    }
    const a = action.action;
    if (!VALID_ACTIONS.has(a)) throw new Error(`Unsupported action: ${a}`);
    if ((a === "click" || a === "type" || a === "select") &&
        (action.element_id === undefined || action.element_id === null)) {
      throw new Error(`Action "${a}" requires element_id.`);
    }
    if (a === "type" && typeof action.text !== "string") throw new Error('Action "type" requires text.');
    if (a === "select" && typeof action.value !== "string") throw new Error('Action "select" requires value.');
    if (a === "scroll" && action.direction !== "up" && action.direction !== "down") {
      throw new Error('Action "scroll" requires direction "up" or "down".');
    }
    if (a === "wait" && (!Number.isFinite(action.milliseconds) || action.milliseconds < 0)) {
      throw new Error('Action "wait" requires a positive milliseconds value.');
    }
  }

  async function execute(action) {
    validateAction(action);

    if (action.action === "wait") {
      const ms = Math.min(Math.max(Number(action.milliseconds) || 500, 100), 5000);
      await sleep(ms);
      return { ok: true, revision };
    }
    if (action.action === "scroll") {
      const amount = Math.round(innerHeight * 0.75);
      window.scrollBy({ top: action.direction === "up" ? -amount : amount, behavior: "smooth" });
      await sleep(500);
      return { ok: true, revision };
    }
    if (action.action === "done") {
      return { ok: true, done: true, revision };
    }

    const el = resolve(action.element_id);
    if (el.disabled) {
      throw new Error("Element is disabled. Re-observe the page and ask the model for a new action.");
    }

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(250);
    el.focus?.();

    if (action.action === "click") {
      el.click();
    } else if (action.action === "type") {
      const text = String(action.text ?? "");
      if (el.isContentEditable) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      } else {
        if (!("value" in el)) throw new Error("Target is not editable.");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set ||
                       Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (setter) setter.call(el, text);
        else el.value = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } else if (action.action === "select") {
      if (el.tagName !== "SELECT") throw new Error("Target is not a select element.");
      el.value = String(action.value ?? "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    await sleep(700);
    return { ok: true, changed: true, revision };
  }

  // ---- messaging ----------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "AGENT_PING") {
      sendResponse({ ok: true, revision });
      return;
    }
    if (msg?.type === "AGENT_PAGE_CHANGED") {
      sendResponse({
        ok: true,
        changed: revision !== Number(msg.since),
        revision,
        url: location.href,
        title: document.title
      });
      return;
    }
    if (msg?.type === "AGENT_OBSERVE") {
      sendResponse({ ok: true, snapshot: snapshot() });
      return;
    }
    if (msg?.type === "AGENT_EXECUTE") {
      execute(msg.action)
        .then(result => sendResponse(result))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;
    }
  });
})();