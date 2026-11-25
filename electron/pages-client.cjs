"use strict";

/**
 * pages-client.cjs -- save a page (or a research report) into AitherOne.
 *
 * Owner, 2026-11-24: the one app should be "slack + notion", so a research report,
 * a saved web page or a forge output has to land somewhere you can find again.
 * That somewhere is AitherOne (`/workspace/one`): an ordinary document whose
 * tenancy, RBAC, Strata backing and history come from the `/api/docs/*` routes.
 *
 * No second store and no second credential: `createDocsCall` (aitherone-link.cjs)
 * is the same HTTP half the canvas uses, authenticated by the desk's existing
 * Online session bearer.
 *
 *   savePage(client, {title, markdown, sourceUrl})  -> {ok, docId, updatedAt}
 *   reportToMarkdown(report)                        -> a page body from
 *                                                      `awresearch --output json`
 *   researchToPage(client, report)                  -> savePage of that body
 *
 * The report shape is awresearch's `ResearchReport.to_dict()`:
 *   {question, research_depth, claims: [{text, sources: [n], unsourced_reason}],
 *    sources: [{title, url, ...}], raw_response}
 * Source numbers are 1-BASED in awresearch's own markdown; they are kept, never
 * re-derived, so a citation in the page points at the same source as the CLI.
 *
 * Pure except the injected client, so every verb is asserted under node --test.
 */

const MAX_SOURCE_TITLE = 200;

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : "");

/** A page title from whatever the caller has: the explicit one wins, else the question. */
function titleOf({ title, markdown, sourceUrl } = {}) {
  const explicit = str(title).trim();
  if (explicit) return explicit.slice(0, 160);
  const first = str(markdown).split("\n").find((line) => line.trim());
  if (first) return first.replace(/^#+\s*/, "").trim().slice(0, 160) || "Untitled page";
  if (str(sourceUrl).trim()) return str(sourceUrl).trim().slice(0, 160);
  return "Untitled page";
}

/** The body written to AitherOne: the page as given, with the page it came from named once. */
function bodyOf({ markdown, sourceUrl } = {}) {
  const body = str(markdown);
  const url = str(sourceUrl).trim();
  if (!url) return body;
  if (body.includes(url)) return body;
  return `${body}${body.endsWith("\n") ? "" : "\n"}\n---\nSource: ${url}\n`;
}

/**
 * An awresearch report -> a page body: the summary, every claim with its citation
 * numbers intact, then the numbered source list. A claim with no source and no
 * reason is shown as unsourced rather than silently dropped -- the page must not
 * look better sourced than the report was.
 */
function reportToMarkdown(report) {
  const r = isObj(report) ? report : {};
  const question = str(r.question).trim() || "Research report";
  const sources = Array.isArray(r.sources) ? r.sources : [];
  const claims = Array.isArray(r.claims) ? r.claims : [];
  const lines = [`# ${question}`, ""];
  const depth = str(r.research_depth).trim();
  lines.push(depth ? `_Depth: ${depth}_` : "_Depth: not recorded_", "");
  if (str(r.raw_response).trim()) lines.push("## Summary", "", str(r.raw_response).trim(), "");
  lines.push("## Claims", "");
  if (!claims.length) {
    lines.push("(No claims in this report)", "");
  } else {
    for (const claim of claims) {
      const c = isObj(claim) ? claim : {};
      const text = str(c.text).trim();
      if (!text) continue;
      const cited = (Array.isArray(c.sources) ? c.sources : []).filter((n) => Number.isInteger(n) && n >= 1);
      if (cited.length) lines.push(`- ${text} ${cited.map((n) => `[${n}]`).join(" ")}`);
      else if (str(c.unsourced_reason).trim()) lines.push(`- ${text} (unsourced: ${str(c.unsourced_reason).trim()})`);
      else lines.push(`- ${text} (unsourced)`);
    }
    lines.push("");
  }
  lines.push("## Sources", "");
  if (!sources.length) {
    lines.push("(No sources in this report)");
  } else {
    sources.forEach((source, i) => {
      const s = isObj(source) ? source : { url: String(source || "") };
      const url = str(s.url).trim();
      const named = str(s.title).trim().slice(0, MAX_SOURCE_TITLE);
      if (named && url) lines.push(`${i + 1}. ${named} — ${url}`);
      else lines.push(`${i + 1}. ${named || url || "(untitled source)"}`);
    });
  }
  return lines.join("\n") + "\n";
}

/** Write a page into AitherOne. A signed-out or refused client returns its own error. */
async function savePage(client, { title, markdown, sourceUrl } = {}) {
  if (!client || typeof client.createDoc !== "function") {
    return { ok: false, error: "no AitherOne client -- sign in to AitherOS Online first" };
  }
  const body = bodyOf({ markdown, sourceUrl });
  if (!body.trim()) return { ok: false, error: "nothing to save: the page is empty" };
  return client.createDoc(titleOf({ title, markdown, sourceUrl }), "document", body);
}

/** A research report -> a page, in one call. */
async function researchToPage(client, report) {
  const r = isObj(report) ? report : {};
  const markdown = reportToMarkdown(r);
  const firstUrl = (Array.isArray(r.sources) ? r.sources : [])
    .map((s) => str(isObj(s) ? s.url : s).trim()).find(Boolean) || "";
  return savePage(client, { title: str(r.question).trim() || "Research report", markdown, sourceUrl: firstUrl });
}

module.exports = { titleOf, bodyOf, reportToMarkdown, savePage, researchToPage };
