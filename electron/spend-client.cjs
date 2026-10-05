"use strict";

/**
 * spend-client — the desk's read of cloud LLM spend (DeepSeek API and kin).
 *
 * Owner, 2026-10-04: "where do I see DeepSeek API spend/token usage?? it's not
 * lined into awdesk/pulse ... I need reports on this stuff."
 *
 * CONTRACT: the ONLY transport is gateway-mcp.cjs. One tool, `cloud_spend`
 * {hours}, backed by MicroScheduler GET /cloud/spend?hours=N, answering:
 *
 *   {window_hours, generated_at, total_usd, unpriced_requests,
 *    providers:[{provider, usd, prompt_tokens, completion_tokens, requests, failed,
 *                models:[{model, usd, prompt_tokens, completion_tokens, requests}]}],
 *    top_sources:[{source, usd, requests, tokens}],
 *    balance:{<provider>:{available, total_balance, currency, checked_at, error}}}
 *
 * Every answer is {ok:true, data} or {ok:false, reason, notDeployed}. 🚩 A failure
 * NEVER becomes zeros: "$0.00 today" on a desk whose reporting tool is absent is
 * a lie that reads exactly like "nothing spent". So an absent tool says so
 * (notDeployed), any other failure says why, and only a parsed contract body is
 * ever rendered as money.
 *
 * Answers are cached 60 s per window, failures included, so the tray refresh,
 * the spend page and the Pulse card share one gateway call per minute.
 */

const WINDOWS = Object.freeze([
  Object.freeze({ hours: 24, label: "24h" }),
  Object.freeze({ hours: 168, label: "7d" }),
  Object.freeze({ hours: 720, label: "30d" }),
]);
const WINDOW_HOURS = Object.freeze(WINDOWS.map((w) => w.hours));
const CACHE_MS = 60 * 1000;
const NOT_DEPLOYED_TEXT = "spend reporting not deployed yet";

/** A gateway/tool error that means "this tool does not exist (yet)". */
const NOT_DEPLOYED_RE = /unknown tool|tool[^.\n]{0,40}not (?:found|registered|available)|no such tool|method not found|not deployed/i;

function windowHours(hours) {
  const h = Number(hours);
  return WINDOW_HOURS.includes(h) ? h : 24;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value) {
  return value == null ? "" : String(value);
}

/** One model row, numbers coerced (a missing count is 0 tokens, not NaN). */
function shapeModel(row) {
  return {
    model: text(row && row.model) || "(unknown model)",
    usd: num(row && row.usd),
    prompt_tokens: num(row && row.prompt_tokens),
    completion_tokens: num(row && row.completion_tokens),
    requests: num(row && row.requests),
  };
}

function shapeProvider(row) {
  const models = Array.isArray(row && row.models) ? row.models.map(shapeModel) : [];
  models.sort((a, b) => b.usd - a.usd || b.requests - a.requests);
  return {
    provider: text(row && row.provider) || "(unknown provider)",
    usd: num(row && row.usd),
    prompt_tokens: num(row && row.prompt_tokens),
    completion_tokens: num(row && row.completion_tokens),
    requests: num(row && row.requests),
    failed: num(row && row.failed),
    models,
  };
}

function shapeBalance(row) {
  const b = row && typeof row === "object" ? row : {};
  const balance = text(b.total_balance);
  return {
    available: b.available === true && balance !== "",
    total_balance: balance,
    currency: text(b.currency) || "USD",
    checked_at: text(b.checked_at),
    error: b.error == null ? null : text(b.error),
  };
}

/**
 * Validate and shape one `cloud_spend` body. Throws when it is not the contract
 * -- a body with no `providers` list or no numeric `total_usd` is not a report,
 * and rendering it would put zeros on screen for an answer we did not get.
 */
function shapeSpend(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("cloud_spend: expected a JSON object");
  }
  if (raw.error) {
    const why = typeof raw.error === "string" ? raw.error : JSON.stringify(raw.error);
    throw new Error(`cloud_spend: ${why}`);
  }
  if (!Array.isArray(raw.providers)) throw new Error("cloud_spend: answer has no providers list");
  if (typeof raw.total_usd !== "number" || !Number.isFinite(raw.total_usd)) {
    throw new Error("cloud_spend: answer has no numeric total_usd");
  }
  const providers = raw.providers.map(shapeProvider).sort((a, b) => b.usd - a.usd || b.requests - a.requests);
  const balance = {};
  if (raw.balance && typeof raw.balance === "object") {
    for (const [name, row] of Object.entries(raw.balance)) balance[name] = shapeBalance(row);
  }
  const sum = (key) => providers.reduce((acc, p) => acc + p[key], 0);
  return {
    window_hours: num(raw.window_hours) || null,
    generated_at: text(raw.generated_at),
    total_usd: raw.total_usd,
    unpriced_requests: num(raw.unpriced_requests),
    requests: sum("requests"),
    failed: sum("failed"),
    prompt_tokens: sum("prompt_tokens"),
    completion_tokens: sum("completion_tokens"),
    providers,
    top_sources: (Array.isArray(raw.top_sources) ? raw.top_sources : []).map((row) => ({
      source: text(row && row.source) || "(unattributed)",
      usd: num(row && row.usd),
      requests: num(row && row.requests),
      tokens: num(row && row.tokens),
    })),
    balance,
  };
}

/** Turn any failure into {ok:false, reason, notDeployed}. */
function failure(error, rawText = "") {
  const why = String((error && error.message) || error || "unknown error");
  const notDeployed = NOT_DEPLOYED_RE.test(why) || NOT_DEPLOYED_RE.test(String(rawText || "").slice(0, 400));
  return { ok: false, notDeployed, reason: notDeployed ? NOT_DEPLOYED_TEXT : why.slice(0, 300) };
}

/** Parse the tool's joined text content, then shape it. */
function parseSpend(answerText) {
  let value;
  try {
    value = JSON.parse(String(answerText == null ? "" : answerText));
  } catch {
    const head = String(answerText || "").trim().slice(0, 160);
    throw new Error(`cloud_spend: unparseable answer${head ? `: ${head}` : " (empty)"}`);
  }
  return shapeSpend(value);
}

function defaultCall(name, args) {
  return require("./gateway-mcp.cjs").callTool(name, args);
}

/**
 * Build a client over an injectable `call(name, args) -> Promise<string>`
 * (gateway-mcp's callTool by default) so tests need no live gateway.
 */
function createSpendClient({ call = defaultCall, now = () => Date.now(), cacheMs = CACHE_MS } = {}) {
  const cache = new Map(); // hours -> {at, value}
  const inflight = new Map(); // hours -> Promise

  async function fetchOnce(hours) {
    let raw = "";
    try {
      raw = await call("cloud_spend", { hours });
      return { ok: true, data: parseSpend(raw) };
    } catch (error) {
      return failure(error, raw);
    }
  }

  return {
    /** {ok:true, data} | {ok:false, reason, notDeployed}; never throws. */
    report: async (hours = 24, { fresh = false } = {}) => {
      const h = windowHours(hours);
      const hit = cache.get(h);
      if (!fresh && hit && now() - hit.at < cacheMs) return hit.value;
      if (inflight.has(h)) return inflight.get(h);
      const pending = fetchOnce(h).then((value) => {
        cache.set(h, { at: now(), value });
        inflight.delete(h);
        return value;
      });
      inflight.set(h, pending);
      return pending;
    },
    clear: () => cache.clear(),
  };
}

function usd(value) {
  return `$${num(value).toFixed(2)}`;
}

/** "$12.34" for USD, "12.34 CNY" otherwise; null when no balance is known. */
function balanceText(balance) {
  if (!balance || !balance.available) return null;
  const n = Number(balance.total_balance);
  const amount = Number.isFinite(n) ? n.toFixed(2) : balance.total_balance;
  return balance.currency === "USD" ? `$${amount}` : `${amount} ${balance.currency}`;
}

/**
 * The tray's one spend line. Unpriced requests are named, because a total that
 * silently omits them understates the bill.
 */
function spendTrayLabel(result) {
  if (!result) return "AI spend: checking…";
  if (!result.ok) {
    return result.notDeployed ? `AI spend: ${NOT_DEPLOYED_TEXT}` : `AI spend: unavailable (${String(result.reason || "no answer").slice(0, 60)})`;
  }
  const data = result.data;
  let label = `AI spend today: ${usd(data.total_usd)}`;
  if (data.unpriced_requests > 0) label += ` + ${data.unpriced_requests} unpriced`;
  const ds = data.balance && data.balance.deepseek;
  if (ds) label += ds.available ? ` · DeepSeek balance ${balanceText(ds)}` : " · DeepSeek balance unavailable";
  return label;
}

/** Zero-or-one tray rows; the row is clickable and opens the spend page. */
function spendTrayItems(result, open) {
  return [{ label: spendTrayLabel(result), enabled: typeof open === "function", click: () => open && open() }];
}

module.exports = {
  createSpendClient, shapeSpend, parseSpend, failure, spendTrayLabel, spendTrayItems, balanceText,
  windowHours, WINDOWS, WINDOW_HOURS, CACHE_MS, NOT_DEPLOYED_TEXT,
};
