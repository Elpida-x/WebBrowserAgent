// Minimal, dependency-free, XSS-safe Markdown -> HTML renderer.
// Strategy: every piece of source text is HTML-escaped FIRST; only a fixed
// whitelist of tags is then emitted, and link hrefs are scheme-checked. So the
// resulting HTML is safe to assign via innerHTML even for untrusted LLM/page text.

const ESC = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Private-use-area sentinels for inline-code placeholders: never appear in real
// text and are untouched by the bold/italic/link rules.
const CODE_OPEN = String.fromCharCode(0xE000);
const CODE_CLOSE = String.fromCharCode(0xE001);

// url here is already HTML-escaped. Only allow safe schemes / anchors.
function safeUrl(url) {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[#/]/.test(u)) return u;
  return null;
}

function renderInline(text) {
  let s = ESC(text);

  // inline code -> placeholders so other rules don't touch its contents
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return CODE_OPEN + (codes.length - 1) + CODE_CLOSE;
  });

  // links [label](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const safe = safeUrl(url);
    if (!safe) return m;
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // bold then italic (bold first so ** is consumed before *)
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, "$1<em>$2</em>");

  // restore inline code
  const restore = new RegExp(CODE_OPEN + "(\\d+)" + CODE_CLOSE, "g");
  s = s.replace(restore, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

// Split a table row into trimmed cells; tolerate optional leading/trailing pipes.
function splitTableRow(row) {
  const s = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return s.split("|").map((c) => c.trim());
}

// A GFM delimiter row, e.g. "| --- | :--: | ---: |".
function isDelimiterRow(line) {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line);
}

export function renderMarkdown(src) {
  if (!src) return "";
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block ```
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      out.push(`<pre><code>${ESC(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // blank line
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // heading
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${renderInline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // table (GFM): a row containing "|" immediately followed by a delimiter row
    if (/\|/.test(line) && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(":");
        const r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : "";
      });
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const cell = (tag, text, idx) =>
        `<${tag}${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ""}>${renderInline(
          text
        )}</${tag}>`;
      const thead = `<tr>${header.map((c, idx) => cell("th", c, idx)).join("")}</tr>`;
      const tbody = rows
        .map(
          (r) => `<tr>${header.map((_, idx) => cell("td", r[idx] ?? "", idx)).join("")}</tr>`
        )
        .join("");
      out.push(`<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`);
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      out.push(`<ul>${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      out.push(`<ol>${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ol>`);
      continue;
    }

    // paragraph: gather consecutive lines until a blank or a block starter
    const buf = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*#{1,6}\s+/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !(/\|/.test(lines[i]) && i + 1 < lines.length && isDelimiterRow(lines[i + 1]))
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${buf.map(renderInline).join("<br>")}</p>`);
  }

  return out.join("\n");
}
