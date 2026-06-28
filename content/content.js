// Content script: perceives the page (builds a numbered map of interactive
// elements) and executes actions (click / type / scroll / extract) on request
// from the side panel. Written as a classic (non-module) idempotent script.
(function () {
  if (window.__WBA_INJECTED__) return;
  window.__WBA_INJECTED__ = true;

  const MAX_ELEMENTS = 120;
  const HIGHLIGHT_ID = "__wba_highlight_layer__";

  /** index -> Element, rebuilt on every GET_STATE */
  let elementMap = new Map();

  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "details",
    "summary",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=menuitem]",
    "[role=menuitemcheckbox]",
    "[role=tab]",
    "[role=switch]",
    "[role=option]",
    "[role=combobox]",
    "[role=searchbox]",
    "[role=textbox]",
    '[contenteditable=""]',
    "[contenteditable=true]",
    "[onclick]",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      parseFloat(style.opacity) === 0
    )
      return false;
    return true;
  }

  // Include elements roughly within a viewport above/below the fold so the
  // agent can decide to scroll to them.
  function nearViewport(el) {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    return r.bottom > -vh && r.top < vh * 2 && r.right > 0 && r.left < vw;
  }

  function clean(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  // Fields whose VALUE must never be sent to the model (passwords, payment, etc.).
  function isSensitiveField(el, type) {
    if (type === "password") return true;
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (/current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp/.test(ac))
      return true;
    const id = (el.getAttribute("name") || "") + " " + (el.id || "");
    return /pass|pwd|password|card|cvv|cvc|ssn|secret|token|otp|verif|密码|银行卡|身份证|验证码/i.test(
      id
    );
  }

  function getLabel(el) {
    const parts = [];
    const aria = el.getAttribute("aria-label");
    if (aria) parts.push(clean(aria));

    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      parts.push("type=" + type);
      const ph = el.getAttribute("placeholder");
      if (ph) parts.push("placeholder=" + clean(ph));
      if ((type === "checkbox" || type === "radio") && "checked" in el) {
        parts.push(el.checked ? "[checked]" : "[unchecked]");
      } else if (isSensitiveField(el, type)) {
        // Never expose secret values (passwords, card numbers, OTP, …).
        parts.push(el.value ? "[filled]" : "[empty]");
      } else if (el.value) {
        parts.push("value=" + clean(el.value).slice(0, 50));
      }
    } else if (el.tagName === "TEXTAREA") {
      const ph = el.getAttribute("placeholder");
      if (ph) parts.push("placeholder=" + clean(ph));
      if (isSensitiveField(el, "textarea")) {
        parts.push(el.value ? "[filled]" : "[empty]");
      } else if (el.value) {
        parts.push("value=" + clean(el.value).slice(0, 50));
      }
    } else if (el.tagName === "SELECT") {
      const opt = el.options[el.selectedIndex];
      if (opt) parts.push("selected=" + clean(opt.text));
    }

    const title = el.getAttribute("title");
    if (title) parts.push(clean(title));
    const alt = el.getAttribute("alt");
    if (alt) parts.push(clean(alt));

    const text = clean(el.innerText || el.textContent);
    if (text) parts.push(text.slice(0, 100));

    let label = parts.join(" | ").slice(0, 160);
    if (!label) label = "(no text)";
    return label;
  }

  function buildElements() {
    elementMap = new Map();
    const out = [];
    const seen = new Set();
    let idx = 0;
    const nodes = document.querySelectorAll(INTERACTIVE_SELECTOR);
    for (const el of nodes) {
      if (seen.has(el)) continue;
      if (el.disabled) continue;
      if (el.closest("[aria-hidden=true]")) continue;
      if (!isVisible(el)) continue;
      if (!nearViewport(el)) continue;
      seen.add(el);
      const index = idx++;
      elementMap.set(index, el);
      out.push({
        index,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        label: getLabel(el),
      });
      if (out.length >= MAX_ELEMENTS) break;
    }
    return out;
  }

  function getState() {
    const elements = buildElements();
    const scrollMax = Math.max(
      0,
      document.documentElement.scrollHeight - window.innerHeight
    );
    const main =
      document.querySelector("main, article, [role=main]") || document.body;
    const preview = clean(main.innerText).slice(0, 900);
    return {
      url: location.href,
      title: document.title,
      scroll: `${Math.round(window.scrollY)} / ${Math.round(scrollMax)} px${
        window.scrollY < scrollMax ? " (more content below)" : ""
      }`,
      preview,
      elements,
      truncated: elements.length >= MAX_ELEMENTS,
    };
  }

  // ---- Highlight overlay (purely visual; never captured as an element) ----
  function removeHighlights() {
    const layer = document.getElementById(HIGHLIGHT_ID);
    if (layer) layer.remove();
  }

  // Briefly outline ONLY the element the agent just acted on, so the user can
  // see where it clicked / typed. Auto-removes; no all-element labelling.
  function flashHighlight(el) {
    removeHighlights();
    const r = el.getBoundingClientRect();
    const layer = document.createElement("div");
    layer.id = HIGHLIGHT_ID;
    layer.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
    const box = document.createElement("div");
    box.style.cssText = `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:2px solid #2563eb;box-sizing:border-box;border-radius:3px;box-shadow:0 0 0 3px rgba(37,99,235,0.3);`;
    layer.appendChild(box);
    document.documentElement.appendChild(layer);
    setTimeout(removeHighlights, 1500);
  }

  // ---- Actions ----
  function getEl(index) {
    const el = elementMap.get(Number(index));
    if (!el) throw new Error(`No element with index ${index}. Re-read state.`);
    return el;
  }

  // Find the smallest visible element whose text matches `query` (exact first,
  // then substring). Searches the WHOLE DOM, not just the interactive selector,
  // so it can target clickable <div>/<span> labels that perception misses.
  function findElementByText(query) {
    const q = clean(query).toLowerCase();
    if (!q) return { el: null, count: 0 };
    let exact = null,
      exactLen = Infinity,
      count = 0;
    let partial = null,
      partialLen = Infinity;
    for (const el of document.body.querySelectorAll("*")) {
      const text = clean(el.textContent || "").toLowerCase();
      if (!text || text.length > 200) continue;
      const isExact = text === q;
      if (!isExact && !text.includes(q)) continue;
      if (!isVisible(el)) continue;
      if (isExact) {
        count++;
        if (text.length < exactLen) {
          exact = el;
          exactLen = text.length;
        }
      } else if (text.length < partialLen) {
        partial = el;
        partialLen = text.length;
      }
    }
    return { el: exact || partial, count: exact ? count : partial ? 1 : 0 };
  }

  // Find a real navigable link tied to the matched element: its own <a href>,
  // an ancestor <a>, or a nearby <a> whose text matches the query. Navigating to
  // this URL avoids popup-blocked window.open() and trusted-gesture requirements.
  function findLinkFor(el, query) {
    const q = clean(query).toLowerCase();
    let cur = el;
    for (let i = 0; i < 6 && cur && cur !== document.body; i++) {
      if (cur.tagName === "A" && /^https?:/.test(cur.href)) return cur.href;
      cur = cur.parentElement;
    }
    cur = el;
    for (let i = 0; i < 6 && cur && cur !== document.body; i++) {
      if (cur.querySelectorAll) {
        for (const a of cur.querySelectorAll("a[href]")) {
          if (/^https?:/.test(a.href) && clean(a.textContent).toLowerCase().includes(q))
            return a.href;
        }
      }
      cur = cur.parentElement;
    }
    return null;
  }

  // Walk up to the nearest element that looks clickable; fall back to el itself
  // (a click on a child bubbles up to a handler on an ancestor anyway).
  function clickableAncestor(el) {
    let cur = el;
    for (let i = 0; i < 6 && cur && cur !== document.body; i++) {
      if (
        cur.matches(
          "a[href], button, [role=button], [role=link], [role=menuitem], [role=tab], [onclick], [tabindex]"
        ) ||
        getComputedStyle(cur).cursor === "pointer"
      )
        return cur;
      cur = cur.parentElement;
    }
    return el;
  }

  // Dispatch a full pointer + mouse sequence (with coordinates) so SPA handlers
  // — which often listen on pointerdown/mousedown rather than the bare click —
  // actually fire. el.click() alone is frequently ignored by web apps.
  function realClick(el) {
    el.scrollIntoView({ block: "center", inline: "center" });
    flashHighlight(el);
    const r = el.getBoundingClientRect();
    const o = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      button: 0,
    };
    const PE = window.PointerEvent || MouseEvent;
    el.dispatchEvent(new PE("pointerover", o));
    el.dispatchEvent(new MouseEvent("mouseover", o));
    el.dispatchEvent(new PE("pointerdown", o));
    el.dispatchEvent(new MouseEvent("mousedown", o));
    if (typeof el.focus === "function") el.focus();
    el.dispatchEvent(new PE("pointerup", o));
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.click();
  }

  // The indexed node may be a wrapper around the real field; find the editable.
  function resolveEditable(el) {
    if (!el) return null;
    if (el.matches("input:not([type=hidden]), textarea, select") || el.isContentEditable)
      return el;
    const inner = el.querySelector(
      "input:not([type=hidden]), textarea, select, [contenteditable=''], [contenteditable=true]"
    );
    return inner || el;
  }

  // Set value through the prototype's native setter so frameworks (React/Vue)
  // that override the element's `value` property still observe the change.
  function setNativeValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function currentValue(el) {
    return el.isContentEditable ? el.textContent || "" : el.value ?? "";
  }

  // Fire the event sequence modern frameworks listen for.
  function fireInput(el, data) {
    el.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data,
      })
    );
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data })
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Fallback: simulate real keystrokes for fields that ignore a bulk value set.
  function typeCharByChar(el, text) {
    setNativeValue(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    for (const ch of text) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keypress", { key: ch, bubbles: true }));
      setNativeValue(el, currentValue(el) + ch);
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch })
      );
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pressEnter(el) {
    for (const t of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(
        new KeyboardEvent(t, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
        })
      );
    }
    // Only auto-submit a SINGLE-field form (e.g. a search box). Never auto-submit
    // a multi-field form, and never from a <textarea> — submitting such a form
    // must be an explicit, confirmable click, not a side effect of typing.
    if (el.tagName === "TEXTAREA") return;
    const form = el.form || el.closest("form");
    if (!form) return;
    const fields = form.querySelectorAll(
      "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea, select"
    );
    if (fields.length <= 1) {
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
    }
  }

  function doAction(action) {
    const { name, args = {} } = action;
    switch (name) {
      case "click": {
        const el = getEl(args.index);
        realClick(el);
        return { ok: true, message: `Clicked [${args.index}] <${el.tagName.toLowerCase()}>` };
      }
      case "find_and_click": {
        const { el, count } = findElementByText(args.text || "");
        if (!el)
          return {
            ok: false,
            found: false,
            message: `No visible element containing "${args.text}". Scroll to reveal more, or try the page's search box / another source.`,
          };
        // Prefer navigating to a real link: bypasses popup-blocked window.open().
        const href = findLinkFor(el, args.text || "");
        if (href) {
          flashHighlight(el);
          return { ok: true, found: true, href, message: `Found link for "${args.text}": ${href}` };
        }
        const target = clickableAncestor(el);
        realClick(target);
        return {
          ok: true,
          found: true,
          matches: count,
          clickedTag: target.tagName.toLowerCase(),
          message: `Clicked the element containing "${args.text}" (<${target.tagName.toLowerCase()}>). If the next state is unchanged, this app opens items via a blocked window.open() — synthetic clicks cannot work here. Tell the user a trusted-click mode is needed, or try the item's own link / search box.`,
        };
      }
      case "input_text": {
        const text = String(args.text ?? "");
        const el = resolveEditable(getEl(args.index));
        if (!el) return { error: `Element ${args.index} is not editable.` };
        const isField =
          el.tagName === "SELECT" ||
          el.isContentEditable ||
          el.matches("input:not([type=hidden]), textarea");
        if (!isField)
          return {
            error: `Element ${args.index} (<${el.tagName.toLowerCase()}>) is not a text field. Click it first, or choose the actual input element.`,
          };
        el.scrollIntoView({ block: "center" });
        flashHighlight(el);
        el.focus();

        // <select>: pick the matching option instead of typing.
        if (el.tagName === "SELECT") {
          const t = text.toLowerCase();
          const opt = Array.from(el.options).find(
            (o) =>
              o.text.trim() === text ||
              o.value === text ||
              o.text.toLowerCase().includes(t)
          );
          if (!opt) return { error: `No <option> matching "${text}".` };
          el.value = opt.value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, value: opt.text, message: `Selected "${opt.text}"` };
        }

        const readonly =
          el.readOnly || el.getAttribute("aria-readonly") === "true";

        // Strategy 1: native value set + framework events.
        if (el.isContentEditable) {
          el.textContent = "";
          el.dispatchEvent(
            new InputEvent("beforeinput", {
              bubbles: true,
              cancelable: true,
              inputType: "insertText",
              data: text,
            })
          );
          el.textContent = text;
          el.dispatchEvent(
            new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })
          );
        } else {
          try {
            el.select();
          } catch {}
          setNativeValue(el, text);
          fireInput(el, text);
        }

        // Verify; if it didn't stick, retry with per-character keystrokes.
        let value = currentValue(el);
        if (value !== text && !el.isContentEditable) {
          typeCharByChar(el, text);
          value = currentValue(el);
        }

        const verified = value === text || (text !== "" && value.includes(text));
        if (args.submit) pressEnter(el);

        // Don't echo secret values back to the model.
        const sensitive = isSensitiveField(el, (el.getAttribute("type") || "text").toLowerCase());
        return {
          ok: verified,
          verified,
          value: sensitive ? (value ? "[hidden]" : "") : value,
          readonly,
          message: sensitive
            ? verified
              ? `Entered the value into [${args.index}]${args.submit ? " and submitted" : ""} (hidden for privacy).`
              : `Could not set [${args.index}] (value hidden). It may be a custom widget, read-only (${readonly}), in an iframe, or it rejects synthetic input.`
            : verified
            ? `Typed "${text}" into [${args.index}]${args.submit ? " and submitted" : ""}`
            : `Could not set [${args.index}]; its value is now "${value}". It may be a custom widget, read-only (${readonly}), inside an iframe, or it rejects synthetic input.`,
        };
      }
      case "scroll": {
        const amount = args.amount || Math.round(window.innerHeight * 0.8);
        const dir = args.direction === "up" ? -1 : 1;
        window.scrollBy({ top: dir * amount, behavior: "instant" });
        return { ok: true, message: `Scrolled ${args.direction || "down"} ${amount}px` };
      }
      case "go_back": {
        history.back();
        return { ok: true, message: "Navigated back" };
      }
      case "extract_content": {
        const main =
          document.querySelector("main, article, [role=main]") || document.body;
        const text = clean(main.innerText).slice(0, 6000);
        return { ok: true, url: location.href, title: document.title, content: text };
      }
      default:
        throw new Error(`Unknown action: ${name}`);
    }
  }

  // ---- Message bridge ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (msg.type === "PING") {
        sendResponse({ ok: true });
      } else if (msg.type === "GET_STATE") {
        sendResponse(getState(msg.highlight));
      } else if (msg.type === "ACTION") {
        sendResponse(doAction(msg.action));
      } else {
        sendResponse({ error: "unknown message type" });
      }
    } catch (e) {
      sendResponse({ error: String(e && e.message ? e.message : e) });
    }
    return true; // keep channel open for async safety
  });
})();
