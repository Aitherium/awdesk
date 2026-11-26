"use strict";

/**
 * agent-bridge.cjs -- Live AitherOS data plane for Unified AitherBrowser.
 *
 * Wires the Antigravity-style workbench cleanly to real local services:
 *   - Decision Cards via ../decision-cards.cjs (local store + gateway failover)
 *   - Conversations persisted in userData/unified-conversations.json
 *   - Live awsh harness sessions (AWSH_URL, default http://127.0.0.1:8362)
 *   - Live automations from ~/.aither/wakes.json (awrise)
 *   - Live local LLM chat via MicroScheduler / local router (127.0.0.1:8150)
 *
 * Pure Node CJS (zero Electron imports).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const decisionCards = require("../decision-cards.cjs");
const { storeCredential } = require("../card-credential.cjs");
const { resolveSecretPromptScript } = require("../secret-prompt-path.cjs");

const CONVERSATIONS_FILE = "unified-conversations.json";
const DEFAULT_LLM_BASE = process.env.AITHER_LLM_URL || "http://127.0.0.1:8150";
const DEFAULT_AWSH_BASE = process.env.AWSH_URL || "http://127.0.0.1:8362";
const DEFAULT_SWARM_BASE = process.env.AWDESK_SWARM_API_URL || "http://127.0.0.1:8182/api/swarms";

const SOVEREIGN_FAIRIES = Object.freeze([
  { id: "atlas", label: "Atlas", color: "#4ade80", role: "Planner" },
  { id: "demiurge", label: "Demiurge", color: "#f87171", role: "Builder" },
  { id: "lyra", label: "Lyra", color: "#60a5fa", role: "Research" },
  { id: "iris", label: "Iris", color: "#c084fc", role: "Visuals" },
  { id: "hera", label: "Hera", color: "#fbbf24", role: "Watch" },
  { id: "vera", label: "Vera", color: "#2dd4bf", role: "Docs" },
]);

function defaultConversations() {
  const now = Date.now();
  return [
    {
      id: "conv-welcome",
      title: "Aither Unified Workbench",
      project: "AitherOS",
      model: "aither-orchestrator",
      updatedAt: now,
      browserUrl: "https://aithr.net",
      messages: [
        {
          id: "m-welcome-1",
          role: "assistant",
          createdAt: now,
          content:
            "Unified **AitherBrowser** is live — one window, zero popup sprawl, zero `gl.readPixels` stalls.\n\n" +
            "- Press **`Alt+1`** (or click **Avatar**) to shrink to the draggable companion orb.\n" +
            "- Press **`Alt+2`** for this 3-pane Antigravity workbench.\n" +
            "- Press **`Alt+3`** (or click **Desktop**) to blow up into the full **AitherOS Living Desktop** (`https://aithr.net`).\n\n" +
            "Drop a task below, click any open Decision Card inline, or open any localhost/web preview in the right pane.",
        },
      ],
    },
  ];
}

const DEFAULT_MODELS = Object.freeze([
  "aither-orchestrator",
  "deepseek-v4-flash-pool",
  "bonsai-27b-local",
]);

function createAgentBridge({ userDataDir = "", fetchImpl = globalThis.fetch } = {}) {
  let conversations = loadConversations();

  function loadConversations() {
    if (!userDataDir) return defaultConversations();
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(userDataDir, CONVERSATIONS_FILE), "utf8"));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch { /* fresh start */ }
    return defaultConversations();
  }

  function saveConversations() {
    if (!userDataDir) return;
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      const tmp = path.join(userDataDir, `${CONVERSATIONS_FILE}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(conversations, null, 2), "utf8");
      fs.renameSync(tmp, path.join(userDataDir, CONVERSATIONS_FILE));
    } catch { /* best effort */ }
  }

  function listConversations() {
    return conversations.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function createConversation({ title = "New Conversation", project = "AitherOS", model = "aither-orchestrator", browserUrl = "https://aithr.net" } = {}) {
    const now = Date.now();
    const conv = {
      id: `conv-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: String(title || "New Conversation").trim() || "New Conversation",
      project: String(project || "AitherOS"),
      model: String(model || "aither-orchestrator"),
      updatedAt: now,
      browserUrl,
      messages: [],
    };
    conversations.unshift(conv);
    saveConversations();
    return conv;
  }

  function deleteConversation(id) {
    const idx = conversations.findIndex((c) => c.id === id);
    if (idx < 0) return false;
    conversations.splice(idx, 1);
    if (conversations.length === 0) conversations = defaultConversations();
    saveConversations();
    return true;
  }

  function listDecisions() {
    try {
      const q = decisionCards.bridgeQueue();
      const cards = Array.isArray(q?.cards) ? q.cards : [];
      return {
        ok: true,
        count: cards.length,
        cards: cards.map((c) => ({
          id: c.id,
          title: c.title || c.id,
          summary: c.summary || "",
          urgency: c.urgency || "normal",
          kind: c.kind || "decision",
          createdAt: c.created_at || 0,
          options: Array.isArray(c.options) ? c.options : [],
          defaultKey: c.default_key || null,
          secretName: c.secret_name || c.secretName || null,
          credentialScope: c.credential_scope || c.credentialScope || null,
          credentialFormat: c.credential_format || c.credentialFormat || null,
          credentialDescription: c.credential_description || c.credentialDescription || null,
        })),
      };
    } catch (err) {
      return { ok: false, count: 0, cards: [], error: String(err?.message || err) };
    }
  }

  async function answerDecision(id, optionKey, note = "") {
    try {
      const res = await decisionCards.answerCard(String(id), String(optionKey), note || undefined);
      return { ok: res?.ok !== false, result: res };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  async function cancelDecision(id, reason = "dismissed in unified browser") {
    try {
      const res = await decisionCards.cancelCard(String(id), reason);
      return { ok: res?.ok !== false, result: res };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  async function submitCredential(cardId, secretValue, { appRootDir = "", spawnFn = spawn } = {}) {
    const val = String(secretValue || "");
    if (!val) return { ok: false, error: "Secret value is empty." };
    const q = listDecisions();
    const card = q.cards.find((c) => c.id === cardId);
    if (!card) return { ok: false, error: `Decision card ${cardId} not found in open queue.` };
    try {
      return await storeCredential({
        card,
        value: val,
        resolveScript: () => resolveSecretPromptScript({ appDir: appRootDir || process.cwd() }),
        spawnFn,
      });
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  function listAutomations() {
    const wakesPath = path.join(os.homedir(), ".aither", "wakes.json");
    try {
      const raw = JSON.parse(fs.readFileSync(wakesPath, "utf8"));
      const items = Array.isArray(raw) ? raw : Array.isArray(raw?.wakes) ? raw.wakes : Object.values(raw || {});
      return items.slice(0, 30).map((w, i) => ({
        id: String(w.id || w.name || `wake-${i}`),
        name: String(w.name || w.id || `Automation ${i + 1}`),
        schedule: String(w.schedule || w.cron || w.every || ""),
        enabled: w.enabled !== false,
        lastStatus: String(w.last_status || w.status || "idle"),
      }));
    } catch {
      return [];
    }
  }

  async function listAwshSessions() {
    if (typeof fetchImpl !== "function") return { ok: false, sessions: [], offline: true };
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 1800);
      const res = await fetchImpl(`${DEFAULT_AWSH_BASE}/sessions`, { signal: ac.signal });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, sessions: [], offline: true };
      const data = await res.json();
      const list = Array.isArray(data) ? data : Array.isArray(data?.sessions) ? data.sessions : [];
      return { ok: true, sessions: list.slice(0, 25), offline: false };
    } catch {
      return { ok: false, sessions: [], offline: true };
    }
  }

  async function sendChatMessage({ conversationId, text, model, onChunk }) {
    const content = String(text || "").trim();
    if (!content) return { ok: false, error: "empty message" };
    let conv = conversations.find((c) => c.id === conversationId);
    if (!conv) conv = createConversation({ title: content.slice(0, 48), model });
    if (conv.messages.length === 0 && conv.title === "New Conversation") {
      conv.title = content.slice(0, 48);
    }
    const now = Date.now();
    const userMsg = { id: `m-${now.toString(36)}-u`, role: "user", content, createdAt: now };
    conv.messages.push(userMsg);
    conv.updatedAt = now;
    if (model) conv.model = model;
    saveConversations();

    const assistantMsg = {
      id: `m-${(now + 1).toString(36)}-a`,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      model: conv.model,
    };

    if (typeof fetchImpl !== "function") {
      assistantMsg.content = "Local router fetch is unavailable in this environment.";
      conv.messages.push(assistantMsg);
      saveConversations();
      return { ok: false, conversation: conv, message: assistantMsg };
    }

    const endpoint = `${DEFAULT_LLM_BASE.replace(/\/$/, "")}/v1/chat/completions`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 45000);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const payload = {
        model: conv.model || "aither-orchestrator",
        stream: true,
        messages: [
          {
            role: "system",
            content:
              "You are Aither inside the unified AitherBrowser workbench. Be direct, concise, and actionable.",
          },
          ...conv.messages.slice(-16).map((m) => ({ role: m.role, content: m.content })),
        ],
      };
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${endpoint}`);
      }

      const contentType = String(res.headers?.get?.("content-type") || "");
      if (contentType.includes("text/event-stream") && res.body && typeof res.body.getReader === "function") {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === "[DONE]") continue;
            try {
              const parsed = JSON.parse(dataStr);
              const delta = parsed?.choices?.[0]?.delta?.content || "";
              if (delta) {
                assistantMsg.content += delta;
                if (typeof onChunk === "function") onChunk(conv.id, assistantMsg.id, delta);
              }
            } catch { /* partial chunk */ }
          }
        }
      } else {
        const data = await res.json();
        assistantMsg.content = data?.choices?.[0]?.message?.content || JSON.stringify(data);
        if (typeof onChunk === "function") onChunk(conv.id, assistantMsg.id, assistantMsg.content);
      }

      conv.messages.push(assistantMsg);
      conv.updatedAt = Date.now();
      saveConversations();
      return { ok: true, conversation: conv, message: assistantMsg };
    } catch (err) {
      assistantMsg.content =
        `Local inference endpoint (\`${endpoint}\`) is offline or unreachable (${err?.message || err}). ` +
        "Start MicroScheduler (`:8150`) or set `AITHER_LLM_URL` to stream replies live.";
      conv.messages.push(assistantMsg);
      conv.updatedAt = Date.now();
      saveConversations();
      return { ok: false, offline: true, conversation: conv, message: assistantMsg };
    } finally {
      clearTimeout(timer);
    }
  }

  function vrmSearchDirs(appRootDir) {
    const dirs = [];
    if (process.env.AITHER_VRM_DIR) dirs.push(process.env.AITHER_VRM_DIR);
    if (appRootDir) {
      dirs.push(path.join(appRootDir, "public", "assets"));
      dirs.push(path.join(appRootDir, "dist", "assets"));
    }
    dirs.push(path.join(os.homedir(), ".aither", "avatars"));
    // Sibling D:\desk fallback when running from D:\wt\* worktree
    dirs.push("D:\\desk\\public\\assets");
    dirs.push("/mnt/d/desk/public/assets");
    return dirs;
  }

  function listVrmModels(appRootDir = "") {
    const seen = new Map();
    for (const dir of vrmSearchDirs(appRootDir)) {
      try {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
          if (!/\.vrm$/i.test(name) || seen.has(name)) continue;
          const full = path.join(dir, name);
          const stat = fs.statSync(full);
          if (!stat.isFile()) continue;
          const label = name
            .replace(/^model-avreg-/i, "")
            .replace(/\.vrm$/i, "")
            .replace(/[-_]+/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
          seen.set(name, { id: name, label, filePath: full, sizeBytes: stat.size });
        }
      } catch { /* ignore unreadable dir */ }
    }
    return Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label));
  }

  function readVrmBytes(id, appRootDir = "") {
    const safeId = path.basename(String(id || ""));
    if (!/\.vrm$/i.test(safeId)) return null;
    const found = listVrmModels(appRootDir).find((m) => m.id === safeId);
    if (!found) return null;
    try {
      const buf = fs.readFileSync(found.filePath);
      return { id: found.id, label: found.label, bytes: new Uint8Array(buf) };
    } catch {
      return null;
    }
  }

  async function listSwarms() {
    if (typeof fetchImpl !== "function") {
      return { ok: false, offline: true, swarms: [], fairies: SOVEREIGN_FAIRIES.map((f) => ({ ...f, active: false })) };
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1800);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const res = await fetchImpl(DEFAULT_SWARM_BASE, { signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rawList = Array.isArray(data) ? data : Array.isArray(data?.swarms) ? data.swarms : [];
      const swarms = rawList.slice(0, 20).map((s, i) => ({
        id: String(s.id || s.swarm_id || `swarm-${i}`),
        title: String(s.title || s.goal || s.id || `Swarm ${i + 1}`),
        status: String(s.status || "running"),
        memberCount: Array.isArray(s.members) ? s.members.length : Number(s.member_count || 0),
        updatedAt: Number(s.updated_at || Date.now()),
        url: String(s.ui_url || `https://aithr.net/swarms/${s.id || ""}`),
      }));
      const activeNames = new Set(
        rawList
          .flatMap((s) => (Array.isArray(s.members) ? s.members : []))
          .map((m) => String(m?.lead || m?.name || m?.role || "").toLowerCase()),
      );
      return {
        ok: true,
        offline: false,
        swarms,
        fairies: SOVEREIGN_FAIRIES.map((f) => ({ ...f, active: activeNames.has(f.id) })),
      };
    } catch {
      return { ok: false, offline: true, swarms: [], fairies: SOVEREIGN_FAIRIES.map((f) => ({ ...f, active: false })) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function listModels() {
    if (typeof fetchImpl !== "function") {
      return { ok: false, offline: true, models: [...DEFAULT_MODELS] };
    }
    const endpoint = `${DEFAULT_LLM_BASE.replace(/\/$/, "")}/v1/models`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1800);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const res = await fetchImpl(endpoint, { signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
      const ids = raw
        .map((m) => String(typeof m === "string" ? m : m?.id || "").trim())
        .filter(Boolean);
      const merged = Array.from(new Set([...ids, ...DEFAULT_MODELS]));
      return { ok: true, offline: false, models: merged };
    } catch {
      return { ok: false, offline: true, models: [...DEFAULT_MODELS] };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    listConversations,
    createConversation,
    deleteConversation,
    listDecisions,
    answerDecision,
    cancelDecision,
    submitCredential,
    listAutomations,
    listAwshSessions,
    listVrmModels,
    readVrmBytes,
    listSwarms,
    listModels,
    sendChatMessage,
  };
}

module.exports = {
  CONVERSATIONS_FILE,
  DEFAULT_LLM_BASE,
  DEFAULT_AWSH_BASE,
  DEFAULT_SWARM_BASE,
  DEFAULT_MODELS,
  SOVEREIGN_FAIRIES,
  createAgentBridge,
};
