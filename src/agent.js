// The autonomous agent loop: perceive -> plan (LLM) -> act -> observe.
import { chatCompletion } from "./llm.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { TOOLS } from "./tools.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Where a brand-new task tab starts (a search engine, ready to search).
const NEW_TAB_START_URL = "https://www.bing.com";

export class Agent {
  /**
   * @param {object} cfg  { apiKey, baseUrl, model, maxSteps }
   * @param {object} cb   UI callbacks: onPlan, onThought, onAction, onObservation, onDone, onError
   */
  constructor(cfg, cb = {}) {
    this.cfg = cfg;
    this.cb = cb;
    this.tabId = null;
    this.abort = new AbortController();
    this.stopped = false;
    this.blockedDomains = new Set(); // sources the user cancelled this run
    this._createdTabId = null; // most recent tab opened during the run
    this._onCreated = (tab) => {
      this._createdTabId = tab.id;
    };
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
  }

  emit(name, ...args) {
    if (typeof this.cb[name] === "function") this.cb[name](...args);
  }

  async run(task) {
    try {
      this.task = task || "";
      // The "run in new tab" setting is overridden when the task refers to the
      // current/open page — then we must operate on the user's active tab.
      const onCurrentPage = this.refersToCurrentPage(task);
      if (this.cfg.newTab !== false && !onCurrentPage) {
        // Open a fresh tab so the user's current page is left untouched.
        const created = await chrome.tabs.create({
          url: NEW_TAB_START_URL,
          active: true,
        });
        this.tabId = created.id;
      } else {
        const tab = await this.getActiveTab();
        if (!tab)
          throw new Error("No active tab found. Open a normal web page and try again.");
        this.tabId = tab.id;
        if (onCurrentPage) {
          this.emit("onObservation", {
            ok: true,
            message: "检测到“当前页面”，将在你当前打开的标签页上操作。",
          });
        }
      }
      chrome.tabs.onCreated.addListener(this._onCreated);

      const messages = [
        {
          role: "system",
          content: `${SYSTEM_PROMPT}\n\n# Current date\nThe current date and time is ${this.nowString()}. Treat this as "now" — it overrides any date assumptions from your training data.`,
        },
      ];

      const maxSteps = this.cfg.maxSteps || 25;
      for (let step = 1; step <= maxSteps && !this.stopped; step++) {
        // 1) Perceive
        const state = await this.getState();
        if (state.unreachable) {
          // Report to the user, but keep going (the model will try another source).
          this.emit("onObservation", {
            ok: false,
            message: `无法访问该页面 / Page not accessible: ${state.error}`,
          });
        }
        const observation = this.formatState(state, step, maxSteps);
        messages.push({
          role: "user",
          content: step === 1 ? `Task: ${task}\n\n${observation}` : observation,
        });

        // 2) Plan
        const msg = await chatCompletion({
          ...this.cfg,
          messages,
          tools: TOOLS,
          signal: this.abort.signal,
        });

        const assistant = { role: "assistant", content: msg.content ?? "" };
        if (msg.tool_calls && msg.tool_calls.length) assistant.tool_calls = msg.tool_calls;
        messages.push(assistant);

        if (msg.content) {
          if (step === 1) this.emit("onPlan", msg.content);
          else this.emit("onThought", msg.content);
        }

        // 3) Act
        if (!msg.tool_calls || !msg.tool_calls.length) {
          // Model replied with prose and no action — treat as final answer.
          this.emit("onDone", { result: msg.content || "(no result)", success: true });
          return;
        }

        for (const tc of msg.tool_calls) {
          if (this.stopped) return;
          const name = tc.function.name;
          let args = {};
          try {
            args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            args = {};
          }

          if (name === "done") {
            this.emit("onAction", name, args);
            this.emit("onDone", {
              result: args.result || "(no result provided)",
              success: args.success !== false,
            });
            return;
          }

          this.emit("onAction", name, args);
          const result = await this.executeTool(name, args);
          this.emit("onObservation", result);

          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(result).slice(0, 2500),
          });
        }
      }

      if (!this.stopped) {
        this.emit("onDone", {
          result: `Reached the step limit (${maxSteps}) without finishing. Try a more specific task or raise the limit in settings.`,
          success: false,
        });
      }
    } catch (e) {
      if (this.stopped) return;
      this.emit("onError", e.message || String(e));
    } finally {
      try {
        chrome.tabs.onCreated.removeListener(this._onCreated);
      } catch {}
    }
  }

  // ---- Tool execution ----
  async executeTool(name, args) {
    try {
      if (name === "request_login") {
        return await this.askLogin(args);
      }
      if (name === "request_manual_action") {
        return await this.askManual(args);
      }
      if (name === "confirm_action") {
        return await this.askConfirm(args);
      }
      if (name === "search") {
        const q = args.query || "";
        let how = "the default search engine";
        try {
          if (!chrome.search || !chrome.search.query)
            throw new Error("chrome.search API unavailable");
          try {
            // Preferred: render results in the agent's tab.
            await chrome.search.query({ text: q, tabId: this.tabId });
          } catch (e1) {
            // Some builds reject tabId — fall back to CURRENT_TAB on the (active) tab.
            await chrome.tabs.update(this.tabId, { active: true });
            await chrome.search.query({ text: q, disposition: "CURRENT_TAB" });
          }
        } catch (e) {
          how = `Bing (default-engine search failed: ${e.message || e})`;
          await chrome.tabs.update(this.tabId, {
            url: "https://www.bing.com/search?q=" + encodeURIComponent(q),
          });
        }
        await this.waitForLoad();
        return { ok: true, message: `Searched "${q}" via ${how}.` };
      }
      if (name === "navigate") {
        // Guardrail: never let the agent open a search engine directly — reroute
        // through the user's default engine via the search tool.
        const eng = this.searchEngineQuery(args.url);
        if (eng) {
          if (eng.query) return await this.executeTool("search", { query: eng.query });
          return {
            ok: false,
            message:
              "Don't open a search engine homepage to search. Use the search tool with your query — it uses the user's default engine.",
          };
        }
        const blocked = await this.guardNavigation(args.url);
        if (blocked) return blocked;
        await chrome.tabs.update(this.tabId, { url: args.url });
        await this.waitForLoad();
        return { ok: true, message: `Navigated to ${args.url}` };
      }
      if (name === "wait") {
        await sleep(Math.min(10000, (args.seconds || 2) * 1000));
        return { ok: true, message: "Waited." };
      }
      // ---- content-script actions (frame-aware) ----
      if (name === "extract_content") {
        return await this.extractAllFrames(args);
      }
      if (name === "scroll" || name === "go_back") {
        const r = await this.sendToFrame(0, { type: "ACTION", action: { name, args } });
        await sleep(name === "scroll" ? 300 : 800);
        return r;
      }
      if (name === "find_and_click") {
        return await this.findAndClickAcrossFrames(args);
      }
      if (name === "click" || name === "input_text") {
        const route = this.frameMap && this.frameMap[Number(args.index)];
        if (!route)
          return { error: `No element with index ${args.index}. Re-read the page state.` };
        if (name === "click") this._createdTabId = null; // arm new-tab detection
        const result = await this.sendToFrame(route.frameId, {
          type: "ACTION",
          action: { name, args: { ...args, index: route.localIndex } },
        });
        await sleep(800);
        if (name === "click" && (await this.adoptNewTabIfAny()) && result && !result.error) {
          result.note = "This click opened a new tab; now operating on the new tab.";
        }
        return result;
      }
      return { error: `Unknown tool: ${name}` };
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }

  // Read text from every frame (main content may live inside an iframe).
  async extractAllFrames(args) {
    const frameIds = await this.getFrameIds();
    let text = "";
    for (const fid of frameIds) {
      try {
        const r = await this.sendToFrame(fid, {
          type: "ACTION",
          action: { name: "extract_content", args },
        });
        if (r && r.content) text += (text ? "\n\n— — —\n\n" : "") + r.content;
      } catch {}
      if (text.length > 6000) break;
    }
    return { ok: true, content: text.slice(0, 6000) };
  }

  // Try find_and_click in each frame; act in the first frame that matches.
  async findAndClickAcrossFrames(args) {
    const frameIds = await this.getFrameIds();
    this._createdTabId = null;
    let last = null;
    for (const fid of frameIds) {
      let r;
      try {
        r = await this.sendToFrame(fid, {
          type: "ACTION",
          action: { name: "find_and_click", args },
        });
      } catch {
        continue;
      }
      last = r;
      if (r && r.found) {
        if (r.href) {
          const blocked = await this.guardNavigation(r.href);
          if (blocked) return blocked;
          await chrome.tabs.update(this.tabId, { url: r.href });
          await this.waitForLoad();
          return { ok: true, navigated: true, message: `Opened "${args.text}" via its link (${r.href}).` };
        }
        await sleep(800);
        if ((await this.adoptNewTabIfAny()) && !r.error) {
          r.note = "This click opened a new tab; now operating on the new tab.";
        }
        return r;
      }
    }
    return last || { ok: false, found: false, message: `Could not find "${args.text}" in any frame.` };
  }

  // If the last click spawned a new tab, switch tracking (and focus) to it.
  async adoptNewTabIfAny() {
    const newId = this._createdTabId;
    if (!newId || newId === this.tabId) return false;
    this._createdTabId = null;
    try {
      await chrome.tabs.get(newId); // throws if it no longer exists
      this.tabId = newId;
      await chrome.tabs.update(newId, { active: true });
      await this.waitForLoad();
      return true;
    } catch {
      return false;
    }
  }

  domainOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  // Does the task ask to act on the page the user already has open?
  refersToCurrentPage(task) {
    return /当前页面|当前页|当前网页|当前标签|这个页面|这一页|这张页面|本页面|本页|此页|这个网页|这张网页|current page|this page|on this page|current tab|this tab/i.test(
      task || ""
    );
  }

  // If `url` points at a known search engine, return { query } (the search terms,
  // possibly ""), else null. Used to reroute searches to the default engine.
  searchEngineQuery(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "");
      const engines = [
        "bing.com",
        "google.com",
        "google.cn",
        "baidu.com",
        "duckduckgo.com",
        "sogou.com",
        "so.com",
        "yahoo.com",
        "yandex.com",
      ];
      const isEngine = engines.some((e) => host === e || host.endsWith("." + e));
      if (!isEngine) return null;
      const p = u.searchParams;
      const query =
        p.get("q") || p.get("wd") || p.get("text") || p.get("query") || p.get("kw") || "";
      return { query };
    } catch {
      return null;
    }
  }

  // Registrable-ish base domain (handles store.apple.com -> apple.com and
  // apple.com.cn -> apple.com.cn).
  baseDomain(host) {
    const parts = (host || "").split(".").filter(Boolean);
    if (parts.length <= 2) return parts.join(".");
    const slds = ["com", "co", "net", "org", "gov", "edu", "ac"];
    if (slds.includes(parts[parts.length - 2])) return parts.slice(-3).join(".");
    return parts.slice(-2).join(".");
  }

  // Quiet by default — only a CROSS-site navigation that looks like data
  // exfiltration (lots of data smuggled in the URL, or a raw-IP host) is flagged.
  async isSuspiciousNav(url) {
    let t;
    try {
      t = new URL(url);
    } catch {
      return false;
    }
    if (!/^https?:$/.test(t.protocol)) return false;
    let currentHost = "";
    try {
      const tab = await chrome.tabs.get(this.tabId);
      currentHost = new URL(tab.url).hostname;
    } catch {}
    const base = this.baseDomain(t.hostname);
    if (base === this.baseDomain(currentHost)) return false; // same site → allow
    if (this.task && base && this.task.toLowerCase().includes(base)) return false; // user named it
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t.hostname)) return true; // raw IP destination
    let maxVal = 0;
    for (const [, v] of t.searchParams) maxVal = Math.max(maxVal, v.length);
    if (t.search.length + t.hash.length > 300 || maxVal > 150) return true; // data smuggling
    return false;
  }

  // Returns a result object if navigation should be blocked, else null (allow).
  async guardNavigation(url) {
    const d = this.domainOf(url);
    if (d && this.blockedDomains.has(d)) {
      return {
        ok: false,
        message: `${d} was cancelled by the user earlier in this task — not visiting it again. Use a different source.`,
      };
    }
    if (await this.isSuspiciousNav(url)) {
      const choice = this.cb.onAskUser
        ? await this.cb.onAskUser({
            title: "确认跳转 / Confirm navigation",
            message: `Agent 准备跳转到一个可疑地址,可能在向外发送数据:\n\n${url}\n\n确认跳转吗?`,
            confirmLabel: "确认跳转",
            cancelLabel: "取消",
          })
        : "cancel";
      if (choice !== "confirm") {
        if (d) this.blockedDomains.add(d);
        return { ok: false, message: `User declined a suspicious navigation to ${url}.` };
      }
    }
    return null;
  }

  // Pause and let the user log in / solve a gate, or cancel this source.
  async askLogin(args) {
    let domain = "";
    try {
      const t = await chrome.tabs.get(this.tabId);
      domain = this.domainOf(t.url);
    } catch {}
    const choice = this.cb.onAskUser
      ? await this.cb.onAskUser({
          title: "需要登录 / Login required",
          domain,
          message:
            (args && args.message) ||
            `网站 ${domain || ""} 需要登录后才能查看。请在浏览器标签页中登录,然后点“我已登录,继续”;或点“取消”改用其他来源。`,
          confirmLabel: "我已登录，继续",
          cancelLabel: "取消查看该网站",
        })
      : "cancel";
    if (choice === "confirm") {
      return {
        ok: true,
        decision: "confirmed",
        message:
          "User confirmed they have logged in / handled the gate. Re-read the page; the needed content should now be visible.",
      };
    }
    if (domain) this.blockedDomains.add(domain);
    return {
      ok: true,
      decision: "cancelled",
      domain,
      message: `User cancelled this source. Do NOT visit ${
        domain || "this site"
      } again in this task; use other information sources.`,
    };
  }

  // The site blocked an automated action — ask the user to do it manually.
  async askManual(args) {
    const instruction = (args && args.instruction) || "";
    const choice = this.cb.onAskUser
      ? await this.cb.onAskUser({
          title: "操作被网页拦截 / Action blocked",
          message: instruction
            ? `网页拦截了插件的自动操作。请在浏览器中手动完成这一步:\n\n${instruction}\n\n完成后点“我已完成，继续”;无法完成则点“跳过”。`
            : "网页拦截了插件的自动操作。请在浏览器中手动完成当前这一步,然后点“我已完成，继续”。",
          confirmLabel: "我已完成，继续",
          cancelLabel: "跳过",
        })
      : "cancel";
    if (choice === "confirm") {
      return {
        ok: true,
        decision: "done",
        message:
          "User performed the action manually. Re-read the page and continue from the new state.",
      };
    }
    return {
      ok: true,
      decision: "skipped",
      message: "User skipped the manual action. Try a different approach or another source.",
    };
  }

  // Confirm an irreversible action before performing it.
  async askConfirm(args) {
    const action = (args && args.action) || "";
    const choice = this.cb.onAskUser
      ? await this.cb.onAskUser({
          title: "确认操作 / Confirm action",
          message: action
            ? `Agent 即将执行一个不可逆操作:\n\n${action}\n\n确认执行吗?`
            : "Agent 即将执行一个不可逆操作,确认执行吗?",
          confirmLabel: "确认执行",
          cancelLabel: "取消",
        })
      : "cancel";
    if (choice === "confirm") {
      return { ok: true, decision: "confirmed", message: "User confirmed. Proceed with the action." };
    }
    return {
      ok: true,
      decision: "cancelled",
      message:
        "User cancelled. Do NOT perform the action. Stop before the irreversible step and report what is ready.",
    };
  }

  // ---- Perception (merges the top frame and all iframes) ----
  async getState() {
    try {
      await this.ensureFrameReady(0);
    } catch (e) {
      return await this.unreachableState(e.message || String(e));
    }
    const frameIds = await this.getFrameIds();
    this.frameMap = []; // global index -> { frameId, localIndex }
    const merged = { url: "", title: "", scroll: "", preview: "", elements: [], truncated: false };
    const previews = [];
    let g = 0;
    for (const fid of frameIds) {
      let s;
      try {
        if (fid !== 0) await this.ensureFrameReady(fid, 2500);
        s = await this.sendToFrame(fid, { type: "GET_STATE" });
      } catch {
        if (fid === 0) return await this.unreachableState("perception failed");
        continue; // skip an unreachable child frame
      }
      if (!s || s.error) {
        if (fid === 0) return await this.unreachableState((s && s.error) || "no response");
        continue;
      }
      if (fid === 0) {
        merged.url = s.url;
        merged.title = s.title;
        merged.scroll = s.scroll;
      }
      if (s.preview && s.preview.length > 20) previews.push(s.preview);
      for (const el of s.elements || []) {
        if (merged.elements.length >= 150) {
          merged.truncated = true;
          break;
        }
        const gi = g++;
        this.frameMap[gi] = { frameId: fid, localIndex: el.index };
        merged.elements.push({ index: gi, tag: el.tag, role: el.role, label: el.label });
      }
    }
    merged.preview = previews.join("\n— — —\n").slice(0, 1400);
    return merged;
  }

  async unreachableState(error) {
    let url = "";
    let title = "";
    try {
      const t = await chrome.tabs.get(this.tabId);
      url = t.url || "";
      title = t.title || "";
    } catch {}
    return { unreachable: true, url, title, error };
  }

  nowString() {
    const now = new Date();
    const date = now.toLocaleDateString("en-CA"); // YYYY-MM-DD
    const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    return `${date} ${time}${tz ? " " + tz : ""}`;
  }

  formatState(state, step, maxSteps) {
    if (state.unreachable) {
      return (
        `[Browser state | step ${step}/${maxSteps}]\n` +
        `Current date: ${this.nowString()}\n` +
        `URL: ${state.url || "(unknown)"}\n` +
        `This page could NOT be accessed: ${state.error}\n` +
        `Do not stop the task — navigate to a normal website or a different source to continue.\n`
      );
    }
    let s = `[Browser state | step ${step}/${maxSteps}]\n`;
    s += `Current date: ${this.nowString()}\n`;
    s += `URL: ${state.url}\nTitle: ${state.title}\nScroll: ${state.scroll}\n\n`;
    if (state.preview) {
      s += `Page text (preview — call extract_content for the full text):\n"${state.preview}"\n\n`;
    }
    s += `Interactive elements (use the [index] with click / input_text):\n`;
    if (state.elements && state.elements.length) {
      for (const e of state.elements) {
        s += `[${e.index}] <${e.tag}${e.role ? ` role=${e.role}` : ""}> ${e.label}\n`;
      }
      if (state.truncated) s += `... (list truncated; scroll for more)\n`;
    } else {
      s += `(none detected — try scrolling, waiting, or navigating)\n`;
    }
    return s;
  }

  // ---- Tab plumbing ----
  async getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab;
  }

  // All injectable frame IDs in the tab (top frame 0 first), capped for safety.
  async getFrameIds() {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: this.tabId, allFrames: true },
        func: () => true,
      });
      let ids = Array.from(new Set(res.map((r) => r.frameId)));
      ids.sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : a - b));
      return ids.slice(0, 15);
    } catch {
      return [0];
    }
  }

  async sendToFrame(frameId, message) {
    try {
      return await chrome.tabs.sendMessage(this.tabId, message, { frameId });
    } catch {
      // Content script not present in that frame yet — inject and retry.
      await chrome.scripting.executeScript({
        target: { tabId: this.tabId, frameIds: [frameId] },
        files: ["content/content.js"],
      });
      return await chrome.tabs.sendMessage(this.tabId, message, { frameId });
    }
  }

  // Wait until a frame's content script answers. Only the top frame (0) throws
  // on failure (= page unreachable); child frames just time out and are skipped.
  async ensureFrameReady(frameId, timeoutMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const pong = await chrome.tabs.sendMessage(this.tabId, { type: "PING" }, { frameId });
        if (pong && pong.ok) return;
      } catch {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: this.tabId, frameIds: [frameId] },
            files: ["content/content.js"],
          });
        } catch {
          // not injectable yet (chrome://, mid-load) — retry
        }
      }
      await sleep(300);
    }
    if (frameId === 0) {
      throw new Error(
        "Could not reach the page. It may be a restricted page (chrome://, web store) — open a normal website."
      );
    }
  }

  async waitForLoad(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const tab = await chrome.tabs.get(this.tabId);
        if (tab.status === "complete") break;
      } catch {}
      await sleep(250);
    }
    await sleep(400); // settle dynamic content
    await this.ensureFrameReady(0);
  }
}
