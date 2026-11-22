"use strict";

// The Wiki tab's markdown renderer: nothing it writes can run or load anything.

const test = require("node:test");
const assert = require("node:assert/strict");
const { TAGS, linkTarget, renderMarkdown, slugOf, wikiLinksOf } = require("./explore-markdown.cjs");

/** Every tag name in a rendered string. */
const tagsIn = (html) => [...String(html).matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase());
/** Every attribute NAME inside a tag. Quoted values are emptied first: a value is data, and
 *  the renderer escapes every quote in it, so nothing inside a value can become a name. */
const attrsIn = (html) => [...String(html).matchAll(/<[a-zA-Z][^>]*>/g)]
  .flatMap((m) => [...m[0].replace(/"[^"]*"/g, '""').matchAll(/\s([a-zA-Z-]+)=/g)].map((a) => a[1].toLowerCase()));

const HOSTILE = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "<iframe src=\"https://evil.example\"></iframe>",
  "<a href=\"javascript:alert(1)\">x</a>",
  "[click](javascript:alert(1))",
  "[click](data:text/html,<script>alert(1)</script>)",
  "[file](file:///C:/Windows/win.ini)",
  "[pane](aither://secrets/)",
  "![pixel](https://tracker.example/p.gif)",
  "![local](../../secret.png)",
  "[x](https://ok.example/\"onmouseover=\"alert(1))",
  "[[page\" onclick=\"alert(1)]]",
  "<style>body{background:url(https://evil.example/x)}</style>",
  "<svg onload=alert(1)>",
  "**bold <script>x</script>**",
  "| a | <script>b</script> |\n|---|---|\n| <img src=x> | d |",
  "```\n<script>in code</script>\n```",
  "> quote <object data=x>",
  "- item <embed src=x>",
  "# heading <script>h</script>",
  "//evil.example/x and [proto](//evil.example/x)",
].join("\n\n");

test("hostile markdown renders as text: only the known tags, no href / src / style / on* anywhere", () => {
  const { html } = renderMarkdown(HOSTILE);
  for (const tag of tagsIn(html)) assert.ok(TAGS.includes(tag), `unexpected tag <${tag}>`);
  const attrs = new Set(attrsIn(html));
  for (const a of attrs) assert.ok(["class", "data-wiki", "data-ext"].includes(a), `unexpected attribute ${a}`);
  assert.equal(/<script|<img|<iframe|<object|<embed|<style|<svg/i.test(html), false);
  assert.equal([...attrs].some((a) => /^on/.test(a) || ["href", "src", "style", "srcdoc", "action"].includes(a)), false, "no handler or loading attribute");
  // No raw quote survives inside an attribute value, so a value cannot close early.
  for (const value of [...html.matchAll(/data-(?:wiki|ext)="([^"]*)"/g)].map((m) => m[1])) assert.equal(/["<>]/.test(value), false);
  // The script source is still THERE, as escaped text the owner can read.
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("no data-ext ever carries a non-web scheme, and no image is fetched", () => {
  const { html, links } = renderMarkdown(HOSTILE);
  const ext = [...html.matchAll(/data-ext="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(ext.length >= 1);
  for (const url of ext) assert.match(url, /^https?:\/\//);
  for (const url of links.ext) assert.match(url, /^https?:\/\//);
  assert.equal(links.ext.some((u) => /javascript|data:|file:|aither:/i.test(u)), false);
  // The remote image is a labelled link the owner may click; the local one is text only.
  assert.match(html, /<a class="md-ext" data-ext="https:\/\/tracker\.example\/p\.gif"><span class="md-img">\[image: pixel\]<\/span><\/a>/);
  assert.match(html, /<span class="md-img">\[image: local\]<\/span>/);
});

test("an attribute cannot be broken out of: quotes in a slug or a URL stay inside it", () => {
  const { html } = renderMarkdown('[[a" onclick="x]] and [t](https://ok.example/a"b)');
  assert.equal(/onclick="x"/.test(html), false);
  assert.match(html, /data-wiki="a&quot; onclick=&quot;x"/);
});

test("links: wiki pages stay in the pane, web links are external, anything else is text", () => {
  assert.deepEqual(linkTarget("https://example.com/a?b=1"), { kind: "ext", url: "https://example.com/a?b=1" });
  assert.deepEqual(linkTarget("other-page.md"), { kind: "wiki", slug: "other-page" });
  assert.deepEqual(linkTarget("../concepts/Agent Loop.md#how"), { kind: "wiki", slug: "Agent Loop" });
  assert.deepEqual(linkTarget("entities/lyra"), { kind: "wiki", slug: "lyra" });
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "aither://secrets/", "mailto:a@b.c",
    "//evil.example/x", "#anchor", "notes.pdf", "image.png", ""]) {
    assert.deepEqual(linkTarget(bad), { kind: "none" }, bad);
  }
  assert.equal(slugOf("../../etc/passwd"), "passwd");
  assert.equal(slugOf("a\u0000b"), "");
});

test("the blocks it knows: headings, lists, code, quotes, rules, tables, inline marks", () => {
  const md = ["# Title", "", "Some **bold**, *italic*, `code` and a [[linked-page|label]].", "", "- one", "- two", "  - nested",
    "", "1. first", "2. second", "", "```js", "const a = 1 < 2;", "```", "", "> quoted", "", "---", "", "| h1 | h2 |", "| --- | --- |", "| a | b |",
    "", "See <https://example.com/x> and https://example.org/y."].join("\n");
  const { html, links, headings } = renderMarkdown(md);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>, <em>italic<\/em>, <code>code<\/code>/);
  assert.match(html, /<a class="md-wiki" data-wiki="linked-page">label<\/a>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><li class="md-sub">nested<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<pre><code>const a = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(html, /<blockquote>quoted<\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<table><thead><tr><th>h1<\/th><th>h2<\/th><\/tr><\/thead><tbody><tr><td>a<\/td><td>b<\/td><\/tr><\/tbody><\/table>/);
  assert.deepEqual(links.wiki, ["linked-page"]);
  assert.deepEqual(links.ext.sort(), ["https://example.com/x", "https://example.org/y"]);
  assert.deepEqual(headings, [{ level: 1, text: "Title" }]);
});

test("wikiLinksOf: [[links]] and relative .md links, images and web links left out", () => {
  const md = "[[alpha]] [[Beta Page|b]] [c](gamma.md) [w](https://x.example) ![i](delta.md) [[alpha]]";
  assert.deepEqual(wikiLinksOf(md), ["alpha", "Beta Page", "gamma"]);
});

test("a page longer than the bound is cut and says so", () => {
  const { truncated, html } = renderMarkdown("word ".repeat(200_000));
  assert.equal(truncated, true);
  assert.ok(html.length < 700_000);
});
