"use strict";

/**
 * explore-markdown.cjs -- a wiki page's markdown as HTML that cannot run or load
 * anything (aither://explore, the Wiki tab).
 *
 * Safe by construction, not by filtering: every character of the source is escaped,
 * and the only tags this module ever writes are the ones in TAGS. A raw `<script>` or
 * `<img onerror>` in a page is therefore TEXT. No tag it writes carries `href`, `src`,
 * `style` or an `on*` handler:
 *
 *   [[slug]] / [[slug|label]] / [text](other-page.md)   <a data-wiki="slug">   stays in the pane
 *   [text](https://...) / <https://...> / a bare URL    <a data-ext="url">     main opens an owner tab
 *   ![alt](anything)                                    <span class="md-img">  never fetched
 *   javascript: / data: / file: / any other scheme      plain text
 *
 * The page turns a click on data-wiki / data-ext into an IPC call; nothing navigates by
 * itself. Pure, so explore-markdown.test.cjs asserts all of it under `node --test`.
 */

const MAX_SOURCE = 512 * 1024;
const MAX_LINK = 2000;
const MAX_SLUG = 160;
/** Every tag renderMarkdown can emit. The test fails on any other. */
const TAGS = Object.freeze(["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "pre", "code", "blockquote",
  "hr", "strong", "em", "a", "span", "table", "thead", "tbody", "tr", "th", "td", "br"]);

function esc(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** A page name out of a link: last path segment, no `.md`, no fragment. "" when it is not one. */
function slugOf(target) {
  let t = String(target == null ? "" : target).trim();
  // eslint-disable-next-line no-control-regex
  if (!t || /[\u0000-\u001f]/.test(t)) return "";
  t = t.split("#")[0].split("?")[0].replace(/\\/g, "/");
  const last = t.split("/").filter((p) => p && p !== "." && p !== "..").pop() || "";
  const slug = last.replace(/\.(md|markdown)$/i, "").trim();
  return slug.length > MAX_SLUG ? "" : slug;
}

/**
 * What a link target is: {kind: "ext", url} (http/https only), {kind: "wiki", slug}
 * (a relative page), or {kind: "none"} (anything else: an anchor, another scheme).
 */
function linkTarget(raw) {
  const t = String(raw == null ? "" : raw).trim().replace(/^<|>$/g, "");
  if (!t || t.length > MAX_LINK) return { kind: "none" };
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      if (u.protocol === "http:" || u.protocol === "https:") return { kind: "ext", url: u.href };
    } catch { /* not a URL: text */ }
    return { kind: "none" };
  }
  // Any other scheme (javascript:, data:, file:, mailto:, aither:) and protocol-relative //host.
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("//") || t.startsWith("#")) return { kind: "none" };
  const bare = t.split("#")[0].split("?")[0];
  const ext = /\.([a-z0-9]{1,8})$/i.exec(bare);
  if (ext && !/^(md|markdown)$/i.test(ext[1])) return { kind: "none" };
  const slug = slugOf(t);
  return slug ? { kind: "wiki", slug } : { kind: "none" };
}

function anchor(target, labelHtml) {
  if (target.kind === "wiki") return `<a class="md-wiki" data-wiki="${esc(target.slug)}">${labelHtml}</a>`;
  if (target.kind === "ext") return `<a class="md-ext" data-ext="${esc(target.url)}">${labelHtml}</a>`;
  return labelHtml;
}

const INLINE_SOURCE = [
  "(`+)([\\s\\S]*?)\\1",                              // 1,2  code span
  "!\\[([^\\]\\n]*)\\]\\(([^)\\s]*)(?:\\s+\"[^\"]*\")?\\)", // 3,4  image
  "\\[\\[([^\\]\\n|]{1,200})(?:\\|([^\\]\\n]{1,200}))?\\]\\]", // 5,6  wikilink
  "\\[([^\\]\\n]{1,400})\\]\\(([^)\\s]*)(?:\\s+\"[^\"]*\")?\\)", // 7,8  link
  "<(https?:\\/\\/[^>\\s]{1,2000})>",                  // 9    autolink
  "(https?:\\/\\/[^\\s<>()\\[\\]]{1,2000})",           // 10   bare URL
  "\\*\\*([^*\\n]+)\\*\\*",                            // 11   bold
  "(?<![A-Za-z0-9*])\\*([^*\\n]+)\\*(?![A-Za-z0-9*])", // 12   italic
  "(?<![A-Za-z0-9_])_([^_\\n]+)_(?![A-Za-z0-9_])",     // 13   italic
].join("|");

/** One line of text with its inline markup, escaped. `links` collects what it points at. */
function inline(text, links, depth = 0) {
  const src = String(text == null ? "" : text);
  let out = "";
  let last = 0;
  // A regex of its own per call: inline() recurses (bold inside a link label), and a
  // shared global regex would have its lastIndex reset under the outer loop.
  const re = new RegExp(INLINE_SOURCE, "g");
  let m;
  const nested = (t) => (depth < 3 ? inline(t, links, depth + 1) : esc(t));
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] != null) {
      out += `<code>${esc(m[2].trim())}</code>`;
    } else if (m[3] != null || (m[4] != null && m[0].startsWith("!"))) {
      const target = linkTarget(m[4]);
      const label = `<span class="md-img">[image: ${esc(m[3] || slugOf(m[4]) || "untitled")}]</span>`;
      out += target.kind === "ext" ? anchor(target, label) : label;
      if (target.kind === "ext") links.ext.add(target.url);
    } else if (m[5] != null) {
      const slug = slugOf(m[5]);
      if (slug) {
        links.wiki.add(slug);
        out += anchor({ kind: "wiki", slug }, esc((m[6] || m[5]).trim()));
      } else out += esc(m[0]);
    } else if (m[7] != null) {
      const target = linkTarget(m[8]);
      if (target.kind === "wiki") links.wiki.add(target.slug);
      if (target.kind === "ext") links.ext.add(target.url);
      out += anchor(target, nested(m[7]));
    } else if (m[9] != null || m[10] != null) {
      const rawUrl = (m[9] || m[10]).replace(/[.,;:!?]+$/, "");
      const trail = (m[9] || m[10]).slice(rawUrl.length);
      const target = linkTarget(rawUrl);
      if (target.kind === "ext") links.ext.add(target.url);
      out += anchor(target, esc(rawUrl)) + esc(trail);
    } else if (m[11] != null) {
      out += `<strong>${nested(m[11])}</strong>`;
    } else {
      out += `<em>${nested(m[12] != null ? m[12] : m[13])}</em>`;
    }
  }
  return out + esc(src.slice(last));
}

function tableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/**
 * Markdown -> {html, links: {wiki: string[], ext: string[]}, headings: [{level, text}], truncated}.
 * Blocks: ATX headings, fenced code, lists (one level of nesting by indent), block
 * quotes, rules, pipe tables, paragraphs. Anything it does not know is a paragraph.
 */
function renderMarkdown(source) {
  let text = String(source == null ? "" : source).replace(/\r\n?/g, "\n");
  const truncated = text.length > MAX_SOURCE;
  if (truncated) text = text.slice(0, MAX_SOURCE);
  const links = { wiki: new Set(), ext: new Set() };
  const headings = [];
  const lines = text.split("\n");
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map((l) => inline(l, links)).join("<br>")}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = /^\s{0,3}(```+|~~~+)\s*([A-Za-z0-9_+-]{0,24})/.exec(line);
    if (fence) {
      flush();
      const body = [];
      const close = fence[1][0];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s{0,3}\\${close}{3,}\\s*$`).test(lines[i])) { body.push(lines[i]); i += 1; }
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      headings.push({ level: h[1].length, text: h[2].slice(0, 200) });
      out.push(`<h${h[1].length}>${inline(h[2], links)}</h${h[1].length}>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push("<hr>"); continue; }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const quote = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) { quote.push(lines[i].replace(/^\s{0,3}>\s?/, "")); i += 1; }
      i -= 1;
      out.push(`<blockquote>${quote.map((l) => inline(l, links)).join("<br>")}</blockquote>`);
      continue;
    }
    const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]);
      const tag = ordered ? "ol" : "ul";
      const baseIndent = item[1].length;
      const parts = [];
      while (i < lines.length) {
        const it = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i]);
        if (!it) break;
        const deep = it[1].length >= baseIndent + 2;
        parts.push(`<li${deep ? ' class="md-sub"' : ""}>${inline(it[3], links)}</li>`);
        i += 1;
      }
      i -= 1;
      out.push(`<${tag}>${parts.join("")}</${tag}>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const head = tableRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { rows.push(tableRow(lines[i])); i += 1; }
      i -= 1;
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c, links)}</th>`).join("")}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, links)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    para.push(line);
  }
  flush();
  return { html: out.join("\n"), links: { wiki: [...links.wiki], ext: [...links.ext] }, headings, truncated };
}

/** The [[wikilinks]] and relative .md links of a page, without rendering it (the link graph). */
function wikiLinksOf(source) {
  const text = String(source == null ? "" : source).slice(0, MAX_SOURCE);
  const found = new Set();
  let m;
  const wl = /\[\[([^\]\n|]{1,200})(?:\|[^\]\n]{1,200})?\]\]/g;
  while ((m = wl.exec(text))) { const s = slugOf(m[1]); if (s) found.add(s); }
  const ml = /(?<!!)\[[^\]\n]{1,400}\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g;
  while ((m = ml.exec(text))) { const t = linkTarget(m[1]); if (t.kind === "wiki") found.add(t.slug); }
  return [...found];
}

module.exports = { MAX_SOURCE, TAGS, esc, linkTarget, renderMarkdown, slugOf, wikiLinksOf };
