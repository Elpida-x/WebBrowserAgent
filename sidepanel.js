import { Agent } from "./src/agent.js";
import { llmDefaults } from "./src/llm.js";
import { renderMarkdown } from "./src/markdown.js";

const $ = (id) => document.getElementById(id);

const els = {
  settings: $("settings"),
  settingsBtn: $("settingsBtn"),
  apiKey: $("apiKey"),
  model: $("model"),
  baseUrl: $("baseUrl"),
  maxSteps: $("maxSteps"),
  newTab: $("newTab"),
  saveSettings: $("saveSettings"),
  settingsStatus: $("settingsStatus"),
  log: $("log"),
  emptyState: $("emptyState"),
  taskInput: $("taskInput"),
  runBtn: $("runBtn"),
  stopBtn: $("stopBtn"),
};

const SETTINGS_KEYS = ["apiKey", "model", "baseUrl", "maxSteps", "newTab"];
let agent = null;
let thinkingEl = null;

// ---------- Settings ----------
async function loadSettings() {
  const d = llmDefaults();
  const stored = await chrome.storage.local.get(SETTINGS_KEYS);
  els.apiKey.value = stored.apiKey || "";
  els.model.value = stored.model || d.model;
  els.baseUrl.value = stored.baseUrl || d.baseUrl;
  els.maxSteps.value = stored.maxSteps || 25;
  els.newTab.checked = stored.newTab !== false; // default: run in a new tab
}

async function saveSettings() {
  const data = {
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim() || llmDefaults().model,
    baseUrl: els.baseUrl.value.trim() || llmDefaults().baseUrl,
    maxSteps: Math.max(1, Math.min(100, parseInt(els.maxSteps.value, 10) || 25)),
    newTab: els.newTab.checked,
  };
  await chrome.storage.local.set(data);
  els.settingsStatus.textContent = "Saved ✓";
  setTimeout(() => (els.settingsStatus.textContent = ""), 1500);
}

function currentConfig() {
  return {
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim() || llmDefaults().model,
    baseUrl: els.baseUrl.value.trim() || llmDefaults().baseUrl,
    maxSteps: parseInt(els.maxSteps.value, 10) || 25,
    newTab: els.newTab.checked,
  };
}

// ---------- Rendering ----------
function clearEmpty() {
  if (els.emptyState) els.emptyState.remove();
}

function addMsg(cls, content, role, asMarkdown = false) {
  clearEmpty();
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  if (role) {
    const r = document.createElement("span");
    r.className = "role";
    r.textContent = role;
    div.appendChild(r);
  }
  div.appendChild(makeBody(content, asMarkdown));
  els.log.appendChild(div);
  scrollDown();
  return div;
}

// Renders Markdown to safe HTML when asMarkdown, else plain text.
function makeBody(content, asMarkdown) {
  const body = document.createElement("div");
  if (asMarkdown) {
    body.className = "md";
    body.innerHTML = renderMarkdown(content);
  } else {
    body.textContent = content;
  }
  return body;
}

function showThinking() {
  removeThinking();
  thinkingEl = document.createElement("div");
  thinkingEl.className = "thinking";
  thinkingEl.innerHTML = `<span class="dot"></span> thinking…`;
  els.log.appendChild(thinkingEl);
  scrollDown();
}
function removeThinking() {
  if (thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }
}

function formatAction(name, args) {
  const parts = Object.entries(args).map(([k, v]) => {
    if (typeof v === "string" && v.length > 60) v = v.slice(0, 57) + "…";
    return `${k}=${JSON.stringify(v)}`;
  });
  return `🔧 ${name}(${parts.join(", ")})`;
}

function scrollDown() {
  els.log.scrollTop = els.log.scrollHeight;
}

// Pause and ask the user to handle something (login, a blocked action, …).
// Resolves "confirm" | "cancel".
function askUser({ title, message, confirmLabel, cancelLabel, domain }) {
  return new Promise((resolve) => {
    removeThinking();
    clearEmpty();
    const div = document.createElement("div");
    div.className = "msg ask";
    const r = document.createElement("span");
    r.className = "role";
    r.textContent = title || "需要你的操作 / Action needed";
    div.appendChild(r);
    const body = document.createElement("div");
    body.textContent =
      message || `网站 ${domain || ""} 需要你的操作,请在浏览器中完成后继续。`;
    div.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "ask-actions";
    const yes = document.createElement("button");
    yes.className = "btn primary";
    yes.textContent = confirmLabel || "继续";
    const no = document.createElement("button");
    no.className = "btn secondary";
    no.textContent = cancelLabel || "取消";
    const choose = (choice, btn) => {
      yes.disabled = true;
      no.disabled = true;
      btn.classList.add("chosen");
      resolve(choice);
      showThinking();
    };
    yes.addEventListener("click", () => choose("confirm", yes));
    no.addEventListener("click", () => choose("cancel", no));
    actions.appendChild(yes);
    actions.appendChild(no);
    div.appendChild(actions);
    els.log.appendChild(div);
    scrollDown();
  });
}

// ---------- Run ----------
function setRunning(running) {
  els.runBtn.classList.toggle("hidden", running);
  els.stopBtn.classList.toggle("hidden", !running);
  els.taskInput.disabled = running;
}

async function run() {
  const task = els.taskInput.value.trim();
  if (!task) return;

  const cfg = currentConfig();
  if (!cfg.apiKey) {
    els.settings.classList.remove("hidden");
    addMsg("error", "Please add your DeepSeek API key in settings first.", "Setup");
    return;
  }

  addMsg("user", task, "You");
  els.taskInput.value = "";
  setRunning(true);
  showThinking();

  agent = new Agent(cfg, {
    onPlan: (text) => {
      removeThinking();
      addMsg("plan", text, "Plan", true);
      showThinking();
    },
    onThought: (text) => {
      removeThinking();
      if (text && text.trim()) addMsg("thought", text, "Reasoning", true);
      showThinking();
    },
    onAskUser: (q) => askUser(q),
    onAction: (name, args) => {
      removeThinking();
      // done shows a result card; these show their own prompt cards.
      if (
        name === "done" ||
        name === "request_login" ||
        name === "request_manual_action" ||
        name === "confirm_action"
      )
        return;
      addMsg("action", formatAction(name, args), "Action");
      showThinking();
    },
    onObservation: (result) => {
      let text;
      if (result?.error) text = `⚠️ ${result.error}`;
      else if (result?.content)
        text = `📄 ${String(result.content).slice(0, 300)}${
          result.content.length > 300 ? "…" : ""
        }`;
      else if (result && result.ok === false)
        text = `⚠️ ${result.message || "action did not succeed"}`;
      else text = `✓ ${result?.message || "ok"}`;
      addMsg("observation", text, "Result");
      showThinking();
    },
    onDone: ({ result, success }) => {
      removeThinking();
      const div = addMsg(`result ${success ? "" : "fail"}`, "", success ? "Done" : "Stopped");
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = success ? "✅ Task complete" : "⛔ Could not complete";
      div.appendChild(title);
      div.appendChild(makeBody(result, true));
      scrollDown();
      setRunning(false);
    },
    onError: (msg) => {
      removeThinking();
      addMsg("error", msg, "Error");
      setRunning(false);
    },
  });

  agent.run(task);
}

function stop() {
  if (agent) agent.stop();
  removeThinking();
  addMsg("observation", "Stopped by user.", "—");
  setRunning(false);
}

// ---------- Wiring ----------
els.settingsBtn.addEventListener("click", () =>
  els.settings.classList.toggle("hidden")
);
els.saveSettings.addEventListener("click", saveSettings);
els.runBtn.addEventListener("click", run);
els.stopBtn.addEventListener("click", stop);
els.taskInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    run();
  }
});

loadSettings();
