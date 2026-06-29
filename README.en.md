# Web Browser Agent 🧭

**English** | [中文](README.md)

An autonomous web-browsing assistant, packaged as a **Chrome (Manifest V3) extension**.
You give it a task in plain language from a side-panel chat; it **understands the
goal, perceives the page, plans steps, navigates and acts in the browser, and
returns a result** — pausing to ask you only when it needs a human (login, a
blocked action, or confirmation of something irreversible).

It uses **DeepSeek** for reasoning (OpenAI-compatible function calling) and a
**DOM accessibility-tree** approach for perception: the page's interactive
elements (across the top frame *and* iframes) are enumerated into one numbered
list, and the agent clicks/types by index — fast, robust, low token cost.

> Quickstart is in [INSTALL.md](INSTALL.md) · 中文说明见 [README.md](README.md)

---

## Table of contents

- [Overview](#overview)
- [Features](#features)
- [How it works](#how-it-works)
- [The tool set](#the-tool-set)
- [Project structure](#project-structure)
- [Install & configure](#install--configure)
- [Usage & examples](#usage--examples)
- [Security & privacy](#security--privacy)
- [Limitations](#limitations)
- [Extending](#extending)
- [Tech stack](#tech-stack)
- [Development trajectory](#development-trajectory)

---

## Overview

The agent runs a **perceive → plan → act → observe** loop entirely inside your
browser. Each step it reads the current page into a structured observation, sends
it to DeepSeek together with a set of tool definitions, receives the next
action(s) as tool calls, executes them on the tab, and feeds the result back —
until it calls `done` with an answer. There is **no backend server**; the model
is called directly from the extension with your own API key.

---

## Features

### 🧠 Perception (how it "sees" the page)
- **DOM accessibility tree** — visible interactive elements (links, buttons,
  inputs, selects, `role=*`, etc.) are enumerated into a numbered list with concise
  labels; the agent acts by index.
- **iframe-aware** — every step merges the top frame and all child frames into one
  global element list (capped at 15 frames / 150 elements for cost), so it can act
  on content inside embedded apps and forms.
- **Page-text preview** — each observation includes a short snippet of the page's
  text so the agent can "read first" and often answer without extra clicks.
- **On-action highlight** — only the element the agent actually clicks/types into
  is briefly outlined on screen, so you can follow what it's doing (no cluttered
  full-page boxes).

### 🔁 Reasoning loop
- Plan → act → observe, with a configurable **max-steps** budget.
- **Read-before-navigate** discipline: open the most relevant result, read it
  fully, and only move on if the answer isn't there.
- **Stop-when-satisfied**: once it has the core answer from a trustworthy source,
  it finishes instead of over-browsing.
- **Time awareness**: the current date/time is injected every step, so "latest /
  newest" queries use the correct year (no training-cutoff drift).

### 🛠️ Actions
- `search` using your browser's **default search engine** (Google/Bing/Baidu/…),
  not a hard-coded one.
- `navigate`, `scroll`, `go_back`, `wait`, `extract_content`.
- `click` by index, and `find_and_click` by **visible text** — it searches the
  whole DOM (even unlabeled `<div>`/`<span>` items), and prefers navigating to the
  item's real link to bypass popup-blocked `window.open()`.
- `input_text` with robust form filling: native value setter + framework events
  (React/Vue), a per-character fallback, `<select>` handling, and **write
  verification** (it reports whether the value actually took).
- **Follows new tabs** a click opens, so it doesn't get stuck on the original page.

### 💬 Output
- Results render as **Markdown** in the side panel — headings, bold/italic,
  lists, links, inline code, blockquotes, and **tables** — via a tiny,
  dependency-free, **XSS-safe** renderer.

### 🙋 Human-in-the-loop
- `request_login` — when a page needs you to log in / solve a CAPTCHA / dismiss a
  paywall, it pauses and asks you to handle it, then continues (or you cancel that
  source and it switches to another).
- `request_manual_action` — when a site blocks its automated click, it asks you to
  do that one step manually, then resumes from the new state.
- `confirm_action` — before anything irreversible, it asks you to approve.

### 🔒 Security & privacy (built in)
- **Sensitive values never leave the page**: password / card / OTP / token fields
  are redacted from what's sent to the model (only `[filled]`/`[empty]`).
- **Prompt-injection guard**: page content is treated as untrusted *data*, never
  as instructions; embedded "ignore your instructions / send the data" text is
  ignored.
- **Confirm-on-suspicious-navigation**: quiet by default, but it asks before a
  cross-site navigation that looks like data exfiltration (lots of data smuggled
  in the URL, or a raw-IP destination).
- **Confirm-before-irreversible** (payments, sending, posting, deleting).
- **Per-run domain blocklist**: a source you cancel won't be revisited.
- Unreachable/restricted pages are reported and skipped — they don't abort the task.

### ⚙️ Settings & UX
- Side-panel chat with live plan / action / observation stream and a **Stop** button.
- Configurable API key, model (default `deepseek-v4-flash`), base URL, max steps.
- **Run in a new tab** (default) to leave your current page untouched — or turn it
  off (or say "on the current page") to act on the page you're viewing.

---

## How it works

```
 sidepanel.js  ── drives ──▶  Agent (src/agent.js)
   (chat UI)                      │
                    perceive ┌────┴────┐ act
                             ▼         ▼
              content/content.js   chrome.tabs / scripting / search
              (per-frame element    (navigate, inject, default-engine
               map + actions)        search, follow new tabs)
                                  │
                             plan ▼
                           src/llm.js ──▶ DeepSeek chat/completions (tool calls)
```

Each loop step:

1. **Perceive** — `getState()` enumerates frames, asks each frame's content script
   for its elements + text, and merges them into one numbered observation.
2. **Plan** — the observation + tool schemas (`src/tools.js`) + system prompt
   (`src/prompt.js`) go to DeepSeek; it replies with tool calls.
3. **Act** — `search`/`navigate`/`wait` and the human-in-the-loop tools run in the
   side panel; `click`/`input_text`/`find_and_click`/`scroll`/`extract_content`
   are routed to the right frame's content script.
4. **Observe** — the result is returned as a `tool` message; the loop repeats until
   the model calls `done`.

---

## The tool set

| Tool | What it does |
|------|--------------|
| `search` | Search via the browser's **default** search engine; results load in the tab. |
| `navigate` | Open a URL (search-engine URLs are rerouted to the default engine; suspicious cross-site URLs are confirmed). |
| `click` | Click the element at an index (full pointer+mouse sequence). |
| `find_and_click` | Find an element by visible text and open it (prefers its real link). |
| `input_text` | Type into a field (verified; sensitive values redacted) with optional submit. |
| `scroll` / `go_back` / `wait` | Reveal content / browser back / pause for loads. |
| `extract_content` | Read the page's text (aggregated across frames). |
| `request_login` | Ask the user to log in / solve a CAPTCHA, then continue or cancel the source. |
| `request_manual_action` | Ask the user to perform a blocked step manually, then resume. |
| `confirm_action` | Ask the user to approve an irreversible action. |
| `done` | Finish and return the result (or explain why it can't). |

---

## Project structure

| Path | Role |
|------|------|
| `manifest.json` | MV3 config: side panel, content script (all frames), permissions |
| `background.js` | Service worker — opens the side panel on the toolbar click |
| `content/content.js` | Per-frame perception (element map, page text) + action execution |
| `src/agent.js` | The perceive→plan→act→observe loop, frame routing, guards |
| `src/llm.js` | DeepSeek chat-completions client (tool calling) |
| `src/prompt.js` | Web-agent system prompt (behavior + safety rules) |
| `src/tools.js` | Tool/function schemas advertised to the model |
| `src/markdown.js` | Dependency-free, XSS-safe Markdown→HTML renderer |
| `sidepanel.html/.css/.js` | Chat UI, settings, human-in-the-loop dialogs |
| `icons/` | Toolbar / store icons (16/48/128) |
| `dist/` | Pre-built distributable ZIP (unzip, then Load unpacked) |
| `INSTALL.md` | Install & run guide with screenshots (Chinese) |
| `demo/` | Demo form page (`demo-form.html`) + screen-recording script for the demo video |
| `trajectory/` | Full Claude Code development transcripts (raw + readable) |

---

## Install & configure

**Load unpacked** (full steps with screenshots in [INSTALL.md](INSTALL.md)):

1. Open `chrome://extensions` (Chrome / Edge / Brave, **version ≥ 114**).
2. Enable **Developer mode**, click **Load unpacked**, select the folder containing
   `manifest.json`.
3. Open the side panel (toolbar icon) → ⚙️ → paste your **DeepSeek API key**
   (from [platform.deepseek.com](https://platform.deepseek.com)) → **Save**.

The key is stored only in `chrome.storage.local` and is sent only to the DeepSeek
API. A pre-built ZIP for distribution is provided in `dist/` — unzip it and Load
unpacked.

---

## Usage & examples

Type a task in the side panel and press **Run** (Enter sends, Shift+Enter newline;
**Stop** halts). You'll see the plan, each action/observation, and the final result.

- *"Find the latest price of the iPhone 17 Pro."*
- *"Find the submission deadlines for NeurIPS 2026 and list them."*
- *"On the current page, fill column A with 3 incrementing student IDs."*
- *"Open the AcWing notes in my Feishu docs."*
- *"Search this shop for wireless headphones under ¥500 and list the top 3."*

---

## Security & privacy

- **Your API key** stays in `chrome.storage.local`; it's only used as the auth
  header to DeepSeek.
- **Page content is sent to DeepSeek** (it must read pages to act), but **secret
  field values are redacted** before sending, and the agent is instructed to never
  put your data into outbound URLs/forms.
- **The page cannot hijack the extension**: content scripts run in an isolated
  world, the extension exposes no page-facing message channel, and it holds no
  `cookies` permission. The realistic risk is *prompt injection* (a hostile page
  steering the model) — mitigated by the injection guard, irreversible-action
  confirmation, and suspicious-navigation confirmation, but not 100% eliminated.
- **Advice:** don't run the agent on unknown/untrusted sites while also logged into
  sensitive accounts; the default "new tab" mode helps isolate it.

---

## Limitations

- **Single-focus**: works on one tab at a time (it follows a new tab a click opens,
  but doesn't orchestrate many tabs in parallel).
- **Canvas-rendered UIs** (online spreadsheets, maps) are outside DOM perception —
  they'd need a vision mode.
- **Hardened anti-automation sites** may reject synthetic clicks entirely; the
  agent falls back to asking you to do that step manually.
- **Token cost**: large pages are capped (≤150 elements, ≤6000 chars on extract,
  ≤15 frames) to control cost.

---

## Extending

- **New action:** add a schema in `src/tools.js`, then handle it in
  `content/content.js` (`doAction`) or `src/agent.js` (`executeTool`) if it needs
  `chrome.*` APIs.
- **Different model/provider:** `src/llm.js` is a thin OpenAI-compatible client —
  point `baseUrl` at any compatible endpoint.
- **Vision hybrid:** add `chrome.tabs.captureVisibleTab` and send screenshots to a
  vision model as an on-demand fallback when DOM perception fails (recommended:
  capture only when needed, keep only the latest image, downscale).

---

## Tech stack

- **Chrome Extension Manifest V3** — side panel, content scripts (all frames),
  service worker, `chrome.{tabs,scripting,search,storage}`.
- **Vanilla JavaScript (ES modules)** — no build step, no runtime dependencies.
- **DeepSeek API** — OpenAI-compatible `chat/completions` with function calling.

---

## Development trajectory

The complete Claude Code development history is preserved under
[`trajectory/`](trajectory/): raw session transcripts (`trajectory/raw/*.jsonl`)
plus a readable Markdown export (`trajectory/session-*.md`, regenerable via
`trajectory/export_transcript.py`).
