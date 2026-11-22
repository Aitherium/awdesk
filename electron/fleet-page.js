/* global window, document, setTimeout, clearTimeout, setInterval */
/* fleet-control.html -- page script. The fleet as ONE living network on the REAL bead-space
 * engine (window.BeadSpace from vendor/bead-space/bead-space.iife.js, the package's own
 * build): the pattern the ARC solver's mind universe proved -- a fixed set of bodies,
 * lit when they act, the layout re-run only when what is drawn actually changed.
 *
 *   nodes   the awnix host, Fleet, GPU, ARC (the verbs' owners), the probed doors, every
 *           service of galaxy:fleet (window.fleet.network(), main's space-client) and the
 *           public aw* bricks (window.fleet.ecosystem(), mapped by BeadSpace.fromEcosystem);
 *   edges   the universe's depends / traffic links, the GPU's own services, the doors into
 *           the host, aitheros -> Fleet and awnix -> host;
 *   health  node colour (one palette, the legend's), a pulse when a node's health changes
 *           and on every down node, packets along real traffic links.
 *
 * The header says ONE thing: the pill's word and a single status line carrying the same
 * verdict. Auto-refresh verdicts never go to the log; the log holds action output only.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const W = window;
  /** fleet-overview.js (loaded before this script): the header counts, the attention list. */
  const OV = W.FleetOverview;
  const log = $("log");
  const pill = $("pill");
  const buttons = [...document.querySelectorAll("button[data-action]")];
  const DESTRUCTIVE = new Set(["down", "gaming", "gpu-sleep", "fleet-sleep", "fleet-critical", "arc-stop",
    "host-start", "host-stop", "host-restart", "host-reattach"]);
  const setAttr = (node, k, v) => { if (node && node.setAttribute) node.setAttribute(k, v); };
  const SPRITES = "vendor/bead-space/kenney-simple-space";
  /** A token's computed colour (SVG fill takes no var()); the fallback only when it cannot be read. */
  function tokenColor(name, fallback) {
    try {
      const probe = document.createElement("span");
      probe.style.color = `var(${name})`;
      document.body.appendChild(probe);
      const c = W.getComputedStyle(probe).color;
      document.body.removeChild(probe);
      return c || fallback;
    } catch { return fallback; }
  }
  /** Health -> colour: the SAME tokens the legend in fleet-control.html paints. */
  const HEALTH_COLOR = Object.freeze({
    ok: tokenColor("--up", "#3fd08a"), degraded: tokenColor("--mixed", "#b48cf0"), down: tokenColor("--down", "#ff5a5f"),
    parked: tokenColor("--quiet", "#f0b43c"), starting: tokenColor("--primary", "#5aa8ff"), unknown: tokenColor("--unknown", "#6b7787"),
  });
  const STATUS_OF_HEALTH = Object.freeze({
    ok: "open", degraded: "blocked", down: "blocked", parked: "deferred", starting: "in_progress", unknown: "open",
  });
  const HOT_MS = 45_000;
  const T0 = Date.parse("2026-01-01T00:00:00Z");
  const born = (i) => new Date(T0 + i * 3_600_000).toISOString();

  // ── state ────────────────────────────────────────────────────────────────
  let lastStatus = null;
  let hostVerdict = null;
  let arcVerdict = null;
  let selected = null;     // "host" | "fleet" | "gpu" | "arc" | "door:<i>" | "svc:<id>" | "brick:<id>"
  let doors = [];
  let adoptable = false;
  let armed = null;
  let armTimer = null;
  let busy = null;
  let probing = false;
  let everProbed = false;
  let localRun = false;
  let net = null;          // window.fleet.network() answer
  let eco = null;          // window.fleet.ecosystem() answer
  let netError = "";
  /** "overview" (the default: what needs you, groups collapsed) or "map" (the network). */
  let view = "overview";
  const openGroups = new Set();
  let armedService = null;   // the restart button waiting for its confirming second click
  const healthSeen = new Map();   // id -> state at the last draw
  const changedAt = new Map();    // id -> when its health last changed

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /** One-word-safe truncation: a label never runs past `max` and never ends mid-clip. */
  function short(text, max = 22) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
  }

  // ── the action log: what a VERB printed, said once ─────────────────────────
  let lastKey = null;
  let lastNode = null;
  let lastCount = 0;
  function line(text, cls) {
    log.hidden = false;
    const key = `${cls || ""}|${String(text).replace(/\d+(\.\d+)?/g, "#")}`;
    if (key === lastKey && lastNode && log.lastChild === lastNode) {
      lastCount += 1;
      lastNode.textContent = `${text} (x${lastCount})`;
      log.scrollTop = log.scrollHeight;
      return;
    }
    const node = el("div", cls || "", text);
    log.appendChild(node);
    lastKey = key; lastNode = node; lastCount = 1;
    while (log.childElementCount > 400) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  function emptyState() {
    if (probing) return "probing…";
    return everProbed ? "not in this verdict" : "not probed yet";
  }

  // Mirrors fleet-control.cjs holdIsStale.
  function holdIsStale(st) {
    const fl = (st && st.fleet) || {};
    return Boolean(st && st.held && fl.scope === "all" && (fl.running ?? 0) > 0
      && (fl.masked ?? 0) < (fl.units ?? 0) / 2);
  }

  function classify(st) {
    if (!st || st.cannotJudge) return "UNKNOWN";
    const fl = st.fleet || {};
    if (fl.running === 0 && (fl.masked ?? 0) > 0) return "DOWN";
    if (st.held && !holdIsStale(st)) return "GPU QUIET";
    if ((fl.masked ?? 0) > 0) return "MIXED";
    if ((fl.running ?? 0) > 0) return "UP";
    return "UNKNOWN";
  }

  /** "the X did not answer -- why. Nothing changed." -> "the X did not answer -- why" (the full text is the title) */
  function firstClause(why) {
    return String(why || "no verdict").split(/(?<=\.)\s/)[0].replace(/\.$/, "");
  }

  function mapCounts() {
    const c = { total: 0, down: 0, degraded: 0, parked: 0 };
    for (const n of (net && net.nodes) || []) {
      c.total += 1;
      if (c[n.health.state] != null) c[n.health.state] += 1;
    }
    return c;
  }

  /**
   * THE verdict: the pill's word and the status line's words come from here and nowhere
   * else, so they cannot disagree. A fleet that cannot be judged NEVER reads UP: a stale
   * verdict is CANNOT JUDGE with the last good numbers and their age in the line.
   */
  function verdict(st) {
    if (busy) return { state: "BUSY", text: `running "${busy}" -- progress in the log below`, tone: "" };
    if (!st) {
      return probing ? { state: "PROBING", text: "probing the fleet: distro, doors and GPU counters (the first pass can take a minute)", tone: "" }
        : { state: "UNKNOWN", text: "not probed yet", tone: "" };
    }
    if (st.cannotJudge) {
      const stale = st.stale;
      if (stale) {
        const fl = (stale.verdict && stale.verdict.fleet) || {};
        return { state: "CANNOT JUDGE", tone: "bad",
          text: `fresh probe failed (${firstClause(stale.reason || st.error)}) -- the numbers are ${Math.round(stale.age_ms / 1000)} s old`
            + (fl.running != null ? `: ${fl.running} running then` : "") };
      }
      return { state: "CANNOT JUDGE", text: `status probe failed: ${firstClause(st.error)}`, tone: "bad" };
    }
    const state = classify(st);
    const fl = st.fleet || {};
    const bits = [];
    if (fl.running != null) bits.push(`${fl.running} running`);
    if (fl.masked) bits.push(`${fl.masked}/${fl.units ?? "?"} masked`);
    if (st.held) bits.push(holdIsStale(st) ? "GPU hold stale" : "GPU held");
    const m = mapCounts();
    if (m.total) {
      const bad = [m.down ? `${m.down} down` : "", m.degraded ? `${m.degraded} degraded` : "", m.parked ? `${m.parked} parked` : ""].filter(Boolean);
      bits.push(`map: ${m.total} services${bad.length ? `, ${bad.join(", ")}` : ""}`);
    }
    const tone = state === "DOWN" ? "bad" : state === "MIXED" || state === "GPU QUIET" || m.down ? "warn" : "";
    return { state, text: bits.join(" · ") || state, tone };
  }

  function paintHeader() {
    const st = lastStatus;
    const v = verdict(st);
    pill.dataset.state = v.state;
    pill.textContent = busy ? `RUNNING: ${busy.toUpperCase()}` : v.state;
    const sl = $("statusline");
    sl.textContent = v.text;
    sl.title = (st && st.error) || v.text;
    sl.dataset.tone = v.tone;
  }

  // ── host / holders / doors: the dock's detail blocks ────────────────────────
  function renderHost(v) {
    hostVerdict = v || null;
    const node = $("host-line");
    if (!v) { node.textContent = "not probed yet"; return; }
    if (v.cannotJudge && !v.distro) { node.textContent = `CANNOT JUDGE: ${v.error || "no verdict"}`; redraw(); return; }
    const pr = v.probe || {};
    const bits = [`${v.distro || "?"} (${v.distro_source || "?"})`, v.verdict || "?", `state ${v.state || "?"}`];
    if (pr.systemd) bits.push(`systemd ${pr.systemd}`);
    if (pr.running != null) bits.push(`${pr.running} containers`);
    const issues = [...(v.problems || []), ...(v.warnings || [])];
    node.textContent = bits.join(" · ") + (issues.length ? ` -- ${issues.join("; ")}` : "");
    node.className = v.verdict === "HEALTHY" ? "ok" : "none";
    redraw();
  }

  function unreadable(error) {
    const raw = String(error || "");
    const msg = /timed? ?out/i.test(raw) ? "the Windows GPU counters timed out"
      : /Command failed/i.test(raw) ? "the Windows GPU counters could not be read"
      : raw.split(/\r?\n/)[0].slice(0, 140);
    const node = el("div", "none", `not readable right now: ${msg}`);
    node.title = raw;
    return node;
  }

  function shortName(h) {
    const base = String(h.name || "").split(/[\\/]/).pop().replace(/\.exe$/i, "");
    return base.length > 16 ? `${base.slice(0, 15)}…` : base || `pid ${h.pid}`;
  }

  function renderHolders(holders, error) {
    const box = $("holders");
    while (box.childElementCount > 1) box.removeChild(box.lastChild);
    if (!Array.isArray(holders)) { box.appendChild(error ? unreadable(error) : el("div", "none", emptyState())); return; }
    if (holders.length === 0) {
      box.appendChild(error ? unreadable(error) : el("div", "none", "no process holds more than 0.1 GiB"));
      return;
    }
    for (const h of holders) {
      const row = el("div", "h");
      row.appendChild(el("span", "g", `${h.gib.toFixed(2)} GiB`));
      row.appendChild(el("span", "n", `${shortName(h)} (pid ${h.pid})`));
      row.appendChild(el("span", "hint", h.hint || ""));
      row.title = h.cmd || h.hint || "";
      box.appendChild(row);
    }
  }

  /** "Genesis via MCP gateway" -> "Genesis"; "Cloudflare Access login (origin ...)" -> "Cloudflare Access login". */
  function doorName(label) {
    return String(label || "").replace(/\s*\(.*$/, "").replace(/\s+via\s.*$/i, "");
  }

  // ── render: the verdict into the HUD, the header and the network ────────────
  function render(st) {
    lastStatus = st;
    const stale = st && st.cannotJudge && st.stale ? st.stale : null;
    const src = stale ? stale.verdict : st;
    const fl = (src && src.fleet) || {};
    paintStats();
    renderHolders(src && src.gpu_holders, src && src.gpu_holders_error);
    doors = Array.isArray(src && src.surfaces) ? src.surfaces : [];
    if (selected && selected.startsWith("door:") && !doors[Number(selected.slice(5))]) closeDock();
    const rec = (st && st.state) || {};
    const recordedCount = (rec.units || []).length + (rec.runners || []).length + (rec.all_units || []).length;
    adoptable = (fl.masked ?? 0) > recordedCount;
    $("b-adopt").disabled = !!busy || !adoptable;
    paintHeader();
    paintDetails();
    redraw();
  }

  /**
   * The header's four numbers. A number nobody could read says so in words ("unknown",
   * with the reason as its tooltip and in the status line) -- never a bare "?".
   */
  function paintStats() {
    const c = OV.hudCounts(lastStatus, net, hostVerdict);
    const unknown = probing ? "probing…" : "unknown";
    const age = c.staleS != null ? ` <small>· ${c.staleS} s ago</small>` : "";
    const stat = (id, html, why) => {
      const node = $(id);
      const blank = html == null;
      node.classList.toggle("probing", blank && unknown === "probing…");
      node.innerHTML = blank ? unknown : html;
      node.title = blank ? (why || "") : "";
    };
    stat("s-running", c.running == null ? null
      : `${c.running}${c.runningFrom === "host" ? " <small>(host probe)</small>" : age}`, c.why);
    const mapWhy = netError ? `service map: ${netError}` : "service map not read yet";
    stat("s-down", c.down == null ? null : `${c.down}${c.degraded ? ` <small>+${c.degraded} degraded</small>` : ""}`, mapWhy);
    stat("s-parked", c.parked == null ? null : String(c.parked), mapWhy);
    stat("s-vram", c.vram ? `${c.vram.usedGiB.toFixed(1)} <small>used · ${c.vram.freeGiB.toFixed(1)} free GiB</small>${age}` : null, c.why);
  }

  // ── health of the four control nodes ───────────────────────────────────────
  function controlHealth() {
    const st = lastStatus;
    const stale = st && st.cannotJudge && st.stale ? st.stale : null;
    const src = stale ? stale.verdict : st;
    const fl = (src && src.fleet) || {};
    let host = !st ? "unknown" : st.cannotJudge && !stale ? "down" : stale ? "unknown" : "ok";
    if (hostVerdict && hostVerdict.verdict) host = hostVerdict.verdict === "HEALTHY" ? "ok" : "degraded";
    const running = fl.running;
    const masked = fl.masked ?? 0;
    const fleet = !src || (st.cannotJudge && !stale) ? "unknown" : running === 0 && masked > 0 ? "down"
      : masked > 0 ? "degraded" : running > 0 ? (stale ? "unknown" : "ok") : "unknown";
    const vr = src && src.vram;
    const frac = vr && vr.total_mib ? vr.used_mib / vr.total_mib : null;
    const gpu = !src || src.cannotJudge ? "unknown" : src.held && !holdIsStale(src) ? "parked" : frac != null && frac > 0.95 ? "degraded" : "ok";
    const a = arcVerdict;
    const arc = !a ? "unknown" : a.cannotJudge || !a.ok ? "down" : (a.problems || []).length ? "degraded" : "ok";
    return { host, fleet, gpu, arc, frac, src, fl };
  }

  function paintDetails() {
    const { src, fl } = controlHealth();
    const st = lastStatus;
    const stale = st && st.cannotJudge && st.stale ? st.stale : null;
    if (!hostVerdict) {
      const hl = $("host-line");
      if (src && !(st && st.cannotJudge && !stale)) {
        const bits = ["distro answers"];
        if (src.systemd) bits.push(`systemd ${src.systemd}`);
        if (fl.running != null) bits.push(`${fl.running} containers`);
        hl.textContent = `${bits.join(" · ")} -- Host status for the full probe (disk, tiers, keepers)`;
      } else if (st && st.cannotJudge && !stale) {
        hl.textContent = "the distro did not answer -- Host status says why";
      }
    }
    $("fleet-detail").textContent = fl.running == null ? `containers: ${emptyState()}`
      : `${fl.running} container(s) running · ${fl.masked ?? 0}/${fl.units ?? "?"} units masked${fl.scope ? ` · scope ${fl.scope}` : ""}${stale ? ` · ${Math.round(stale.age_ms / 1000)} s old` : ""}`;
    const a = arcVerdict;
    if (a) {
      const wm = a.world_model || {};
      $("arc-detail").textContent = `${a.verdict || (a.ok ? "ok" : "refused")}${wm.train_steps != null ? ` · train_steps ${wm.train_steps}` : ""}${(a.problems || []).length ? ` · ${a.problems.join("; ")}` : ""}`;
    }
  }

  // ── the network data ───────────────────────────────────────────────────────
  const CONTROL = [["host", "awnix host"], ["fleet", "Fleet"], ["gpu", "GPU"], ["arc", "ARC"]];
  const CONTROL_R = { host: 20, fleet: 16, gpu: 14, arc: 12 };
  /** A service group smaller than this joins "other": thirty one-planet constellations is noise. */
  const MIN_GROUP = 3;

  function buildData() {
    const ch = controlHealth();
    const nodes = [];
    const links = [];
    const now = Date.now();
    let i = 0;
    for (const [key, title] of CONTROL) {
      const state = ch[key];
      const hot = busy && ((key === "fleet" && /^fleet|^adopt/.test(busy)) || (key === "gpu" && /^gpu/.test(busy))
        || (key === "arc" && /^arc/.test(busy)) || (key === "host" && /^host/.test(busy)));
      nodes.push({ id: `ctl:${key}`, title, cluster: "awnix", status: hot ? "in_progress" : STATUS_OF_HEALTH[state],
        assignee: hot ? "Aither" : null, createdAt: born(i++), meta: { kind: "ctl", key, health: state } });
    }
    links.push({ source: "ctl:host", target: "ctl:fleet", kind: "parent-child" });
    links.push({ source: "ctl:fleet", target: "ctl:gpu", kind: "parent-child" });
    links.push({ source: "ctl:fleet", target: "ctl:arc", kind: "parent-child" });
    doors.forEach((s, d) => {
      const state = s.up ? "ok" : "down";
      nodes.push({ id: `door:${d}`, title: doorName(s.label), cluster: "doors", status: STATUS_OF_HEALTH[state],
        createdAt: born(i++), meta: { kind: "door", index: d, health: state } });
      links.push({ source: `door:${d}`, target: "ctl:host", kind: s.up ? "related" : "blocks" });
    });
    // services
    const svc = (net && net.nodes) || [];
    const size = new Map();
    for (const n of svc) size.set(n.group, (size.get(n.group) || 0) + 1);
    const groupOf = (n) => (size.get(n.group) >= MIN_GROUP ? n.group : "other services");
    for (const n of svc) {
      const hot = now - (changedAt.get(n.id) || 0) < HOT_MS;
      nodes.push({ id: n.id, title: n.title, cluster: groupOf(n), status: hot ? "in_progress" : STATUS_OF_HEALTH[n.health.state],
        assignee: hot ? "Aither" : null, createdAt: born(i++), meta: { kind: "svc", health: n.health.state, reason: n.health.reason, group: n.group } });
      if (n.group === "Gpu") links.push({ source: "ctl:gpu", target: n.id, kind: "parent-child" });
      if (/(^|[:/_-])arc[-_]/i.test(n.id)) links.push({ source: "ctl:arc", target: n.id, kind: "parent-child" });
    }
    for (const l of (net && net.links) || []) {
      const target = svc.find((n) => n.id === l.target);
      const down = target && target.health.state === "down";
      links.push({ source: l.source, target: l.target, kind: l.rel === "traffic" ? "related" : down ? "blocks" : "parent-child" });
    }
    // aw* bricks: the package's adapter over the public registry
    if (eco && eco.ok && W.BeadSpace && typeof W.BeadSpace.fromEcosystem === "function") {
      const e = W.BeadSpace.fromEcosystem(eco.bricks, { clusterPrefix: "aw*" });
      for (const n of e.nodes) nodes.push({ ...n, meta: { ...(n.meta || {}), kind: "brick" } });
      // `includes` (containment) only. `pairs_with` is composition -- symmetric and dense (a
      // few hundred dashed lines) -- and drawn here it buried the services under a purple
      // hairball. The Space pane and the hub still show the full pairing graph.
      links.push(...e.links.filter((l) => l.kind === "parent-child"));
      const ids = new Set(e.nodes.map((n) => n.id));
      if (ids.has("aw:aitheros")) links.push({ source: "aw:aitheros", target: "ctl:fleet", kind: "parent-child" });
      if (ids.has("aw:awnix")) links.push({ source: "aw:awnix", target: "ctl:host", kind: "parent-child" });
    }
    const known = new Set(nodes.map((n) => n.id));
    return { nodes, links: links.filter((l) => known.has(l.source) && known.has(l.target)) };
  }

  function clusterLayout(data) {
    const counts = new Map();
    for (const n of data.nodes) counts.set(n.cluster, (counts.get(n.cluster) || 0) + 1);
    const services = [...counts.keys()].filter((c) => c !== "awnix" && c !== "doors" && !c.startsWith("aw*"))
      .sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
    const bricks = [...counts.keys()].filter((c) => c.startsWith("aw*")).sort((a, b) => counts.get(b) - counts.get(a));
    // AitherOS in the middle, its services in a ring around it, the aw* family outside
    // (the reading fromEcosystem's header describes: the public bricks around the interior).
    const anchors = { awnix: [0.5, 0.5], doors: [0.5, 0.34] };
    services.forEach((c, k) => {
      const a = (k / Math.max(1, services.length)) * Math.PI * 2 - Math.PI / 2;
      anchors[c] = [0.5 + Math.cos(a) * 0.27, 0.5 + Math.sin(a) * 0.3];
    });
    const corners = [[0.1, 0.12], [0.9, 0.12], [0.9, 0.88], [0.1, 0.88]];
    bricks.forEach((c, k) => { anchors[c] = corners[k % corners.length]; });
    return { order: ["awnix", "doors", ...services, ...bricks], anchors };
  }

  const BRICK_PALETTE = ["#7fb8e8", "#a99be8", "#8fd0c4", "#d7b6e6"];

  // ── the engine ─────────────────────────────────────────────────────────────
  let space = null;
  let lastSig = "";
  let lastData = null;
  let degree = new Map();

  function note(text) { const n = $("netnote"); if (n) n.textContent = text; }

  function netNote() {
    if (!W.BeadSpace) return "the bead-space engine did not load (vendor/bead-space) -- the verbs still work";
    const parts = [];
    const m = mapCounts();
    if (net && net.ok) {
      parts.push(`${m.total} services, ${(net.links || []).length} links (${OV.mapSource(net)})`);
    } else {
      parts.push(netError ? `services: ${short(netError, 90)}` : "services: reading the universe…");
    }
    const bricks = lastData ? lastData.nodes.filter((n) => n.meta && n.meta.kind === "brick").length : 0;
    if (bricks) parts.push(`${bricks} aw* bricks`);
    parts.push("select a node for its verbs · wheel to zoom");
    return parts.join(" · ");
  }

  function sigOf(data) {
    return data.nodes.map((n) => `${n.id}:${n.status}:${n.meta && n.meta.health}`).join(",")
      + "|" + data.links.map((l) => `${l.source}>${l.target}:${l.kind}`).join(",");
  }

  function redraw() {
    const data = buildData();
    lastData = data;
    degree = new Map();
    for (const l of data.links) {
      degree.set(l.source, (degree.get(l.source) || 0) + 1);
      degree.set(l.target, (degree.get(l.target) || 0) + 1);
    }
    // health changes: remembered for the pulse and the "lit" status
    const flips = [];
    for (const n of data.nodes) {
      const h = n.meta && n.meta.health;
      if (!h) continue;
      const was = healthSeen.get(n.id);
      if (was !== undefined && was !== h) { changedAt.set(n.id, Date.now()); flips.push([n.id, h]); }
      healthSeen.set(n.id, h);
    }
    note(netNote());
    renderOverview();
    // The engine runs only while the map is shown: hidden, it measured a 0x0 box, and
    // laying out 300 bodies nobody is looking at cost the window its frame rate.
    if (view !== "map") return;
    const engine = W.BeadSpace;
    if (!engine || typeof engine.createBeadSpace !== "function") return;
    const sig = sigOf(data);
    if (space && sig === lastSig) return;   // nothing drawn changed: leave the layout still
    lastSig = sig;
    const layout = clusterLayout(data);
    if (!space) {
      space = engine.createBeadSpace($("net"), data, {
        assetRoot: SPRITES,
        clusterOrder: layout.order,
        clusterAnchors: layout.anchors,
        clusterPalette: layout.order.map((c, k) => (c.startsWith("aw*") ? BRICK_PALETTE[k % BRICK_PALETTE.length] : "#6b7787")),
        ownerPalette: ["#9FD8FF"],
        nodeColor: (n) => (n.meta && n.meta.health ? HEALTH_COLOR[n.meta.health] || HEALTH_COLOR.unknown : null),
        nodeRadius: (n) => {
          const k = n.meta && n.meta.kind;
          if (k === "ctl") return CONTROL_R[n.meta.key];
          if (k === "door") return 6;
          if (k === "brick") return 4;
          return 4.5 + Math.min(6, (degree.get(n.id) || 0) * 0.45);
        },
        nodeClass: (n) => (n.meta && n.meta.health === "down" ? "bs-down" : null),
        // Labels only where they carry news: the four control nodes and any service that
        // is not ok. Two hundred always-on labels overlapped into an unreadable hairball
        // (owner screenshot 2026-11-18); every other name is on hover (tooltips).
        nodeLabel: (n) => mapLabel(n),
        labelCollision: true,
        labelsAlwaysBelow: 0,
        labelZoom: 0.01,
        wheelZoom: true,
        tooltips: true,
        fitToContent: true,
        parallax: false,
        onSelect: (n) => {
          if (!n) { if (selected) closeDock({ fromEngine: true }); return; }
          const k = n.meta && n.meta.kind;
          if (k === "ctl") select(n.meta.key, { fromEngine: true });
          else if (k === "door") select(`door:${n.meta.index}`, { fromEngine: true });
          else if (k === "svc") select(`svc:${n.id}`, { fromEngine: true });
          else if (k === "brick") select(`brick:${n.id}`, { fromEngine: true });
        },
      });
    } else {
      space.update(data);
    }
    for (const [id, h] of flips) { try { space.pulse(id, { color: HEALTH_COLOR[h] }); } catch { /* not drawn */ } }
  }

  // The network breathes: down nodes pulse red, real traffic moves as packets, a running
  // verb sends packets host -> fleet. Nothing here re-runs the layout.
  function heartbeat() {
    if (!space || !lastData) return;
    try {
      for (const n of lastData.nodes) if (n.meta && n.meta.health === "down") space.pulse(n.id, { color: HEALTH_COLOR.down, strength: 0.6 });
      const traffic = ((net && net.links) || []).filter((l) => l.rel === "traffic");
      for (let k = 0; k < Math.min(3, traffic.length); k++) {
        const l = traffic[Math.floor(Math.random() * traffic.length)];
        space.packet(l.source, l.target, { color: "#9FD8FF" });
      }
      if (busy) space.packet("ctl:host", "ctl:fleet", { color: "#5aa8ff" });
    } catch { /* the engine is between levels */ }
  }

  /** The map's label for a node: only the control nodes and the services that are not ok. */
  function mapLabel(n) {
    const k = n && n.meta && n.meta.kind;
    if (k === "ctl") return short(n.title, 24);
    const h = n && n.meta && n.meta.health;
    return k === "svc" && (h === "down" || h === "degraded") ? short(n.title, 20) : "";
  }

  // ── the overview: what needs you, then every group as one line ──────────────
  function dot(state) { return el("span", `dot s-${state}`); }

  function serviceButton(label, verb, row) {
    const b = el("button", verb === "restart" ? "down" : "quiet", label);
    b.dataset.verb = verb;
    b.dataset.unit = row.unit || "";
    if (!row.unit) { b.disabled = true; b.title = "no unit owns this service -- nothing to restart or read"; }
    b.addEventListener("click", () => void serviceVerb(b, verb, row));
    return b;
  }

  function renderAttention() {
    const box = $("attention-list");
    box.textContent = "";
    if (!net || !net.ok) {
      box.appendChild(el("div", "none", netError ? `service map unreadable: ${short(netError, 160)}` : "reading the service map…"));
      return;
    }
    const a = OV.attentionList(net.nodes);
    if (!a.total) { box.appendChild(el("div", "clear", `Nothing is down or degraded (${net.nodes.length} services).`)); return; }
    for (const r of a.rows) {
      const row = el("div", "att");
      row.dataset.id = r.id;
      row.appendChild(dot(r.state));
      const who = el("div", "who");
      who.appendChild(el("div", "name", r.title));
      const why = el("div", "why", `${r.state}${r.group ? ` · ${r.group}` : ""}${r.reason ? ` -- ${r.reason}` : ""}`);
      why.title = r.reason || r.state;
      who.appendChild(why);
      row.appendChild(who);
      const verbs = el("div", "verbs");
      verbs.appendChild(serviceButton("Restart", "restart", r));
      verbs.appendChild(serviceButton("Logs", "show", r));
      row.appendChild(verbs);
      box.appendChild(row);
    }
    if (a.more) box.appendChild(el("div", "none", `+${a.more} more -- see the groups below or the map`));
  }

  function renderGroups() {
    const box = $("group-list");
    box.textContent = "";
    if (!net || !net.ok) return;
    for (const g of OV.groupSummary(net.nodes)) {
      const worst = g.down ? "down" : g.degraded ? "degraded" : g.starting ? "starting" : g.ok ? "ok" : g.parked ? "parked" : "unknown";
      const head = el("button", "grp");
      head.dataset.group = g.group;
      setAttr(head, "aria-expanded", openGroups.has(g.group) ? "true" : "false");
      head.appendChild(dot(worst));
      head.appendChild(el("span", "gname", g.group));
      const bits = [`${g.ok}/${g.total} up`];
      if (g.down) bits.push(`${g.down} down`);
      if (g.degraded) bits.push(`${g.degraded} degraded`);
      if (g.parked) bits.push(`${g.parked} parked`);
      if (g.unknown) bits.push(`${g.unknown} unknown`);
      head.appendChild(el("span", "gcount", bits.join(" · ")));
      head.addEventListener("click", () => {
        if (openGroups.has(g.group)) openGroups.delete(g.group); else openGroups.add(g.group);
        renderGroups();
      });
      box.appendChild(head);
      if (!openGroups.has(g.group)) continue;
      const list = el("div", "members");
      for (const m of g.members) {
        const r = el("div", "mem");
        r.appendChild(dot(m.state));
        const t = el("span", "mt", `${m.title}${m.state === "ok" ? "" : ` -- ${m.state}${m.reason ? `: ${m.reason}` : ""}`}`);
        t.title = m.reason || m.state;
        r.appendChild(t);
        list.appendChild(r);
      }
      box.appendChild(list);
    }
  }

  function renderOverview() {
    if (!$("overview")) return;
    // a re-render (every refresh) must leave each list where the owner scrolled it
    const keep = ["attention", "groups"].map((id) => [id, $(id) ? $(id).scrollTop : 0]);
    renderAttention();
    renderGroups();
    paintStats();
    for (const [id, top] of keep) if ($(id)) $(id).scrollTop = top;
  }

  /** Restart (confirm: a second click within 6 s) or read the log of ONE service. */
  async function serviceVerb(button, verb, row) {
    if (!row.unit || typeof W.fleet.service !== "function") return;
    if (verb === "restart" && armedService !== button) {
      if (armedService) { armedService.textContent = "Restart"; armedService.classList.remove("confirm"); }
      armedService = button;
      button.textContent = "Confirm restart";
      button.classList.add("confirm");
      setTimeout(() => {
        if (armedService === button) { armedService = null; button.textContent = "Restart"; button.classList.remove("confirm"); }
      }, 6000);
      return;
    }
    armedService = null;
    button.classList.remove("confirm");
    button.disabled = true;
    button.textContent = verb === "restart" ? "Restarting…" : "Reading…";
    line(`> ${verb === "show" ? "logs" : verb} ${row.unit}`, "cmd");
    let v;
    try { v = await W.fleet.service(verb, row.unit); } catch (error) { v = { ok: false, error: (error && error.message) || String(error) }; }
    if (verb === "show") {
      if (v && v.ok && typeof v.log === "string") {
        for (const l of v.log.split(/\r?\n/).slice(-25)) if (l.trim()) line(l);
        line(`logs ${row.unit}: ${v.status || "read"}`, "ok");
      } else line(`logs ${row.unit}: ${(v && v.error) || "no log"}`, "err");
    } else {
      line(`restart ${row.unit}: ${v && v.ok ? (v.verified || "ok") : (v && v.error) || "failed"}`, v && v.ok ? "ok" : "err");
      void loadNetwork(true);
    }
    button.disabled = false;
    button.textContent = verb === "restart" ? "Restart" : "Logs";
  }

  function setView(next) {
    view = next === "map" ? "map" : "overview";
    $("overview").hidden = view !== "overview";
    $("net").hidden = view !== "map";
    $("netnote").hidden = view !== "map";
    const b = $("b-view");
    b.textContent = view === "map" ? "Show overview" : "Show map";
    setAttr(b, "aria-pressed", view === "map" ? "true" : "false");
    if (view === "overview" && selected) closeDock();
    lastSig = "";
    redraw();
  }

  async function loadNetwork(fresh) {
    if (typeof W.fleet.network !== "function") { netError = "this desk build has no network reader"; redraw(); return; }
    try {
      const answer = await W.fleet.network({ fresh: Boolean(fresh) });
      if (answer && answer.ok) { net = answer; netError = ""; } else { netError = (answer && answer.error) || "no universe"; }
    } catch (error) {
      netError = (error && error.message) || String(error);
    }
    paintHeader();
    redraw();
  }

  async function loadEcosystem() {
    if (typeof W.fleet.ecosystem !== "function") return;
    try { eco = await W.fleet.ecosystem(); } catch { eco = null; }
    redraw();
  }

  // ── the dock: one node's verbs ───────────────────────────────────────────
  const DOCK_TITLES = { host: "awnix host — the WSL distro", fleet: "Fleet — every aither unit", gpu: "GPU — the 5090", arc: "ARC — solver + world model" };
  const VERB_BUTTONS = [...buttons.filter((b) => b.dataset.bead !== "hero"), $("b-adopt"), $("b-open-door"), $("b-node-space")].filter(Boolean);
  const DETAILS = { fleet: "fleet-detail", gpu: "holders", arc: "arc-detail", host: "host", door: "door-detail", svc: "svc-detail", brick: "brick-detail" };
  let spaceOk = false;

  function nodeById(id) { return lastData ? lastData.nodes.find((n) => n.id === id) : null; }

  function svcDetail(id) {
    const box = $("svc-detail");
    const n = nodeById(id);
    const s = ((net && net.nodes) || []).find((x) => x.id === id);
    box.textContent = "";
    if (!s) { box.appendChild(el("div", "none", "no longer in the universe")); return n ? n.title : id; }
    box.appendChild(el("div", "k", s.group));
    box.appendChild(el("div", s.health.state === "ok" ? "ok" : "", `${s.health.state}${s.health.reason ? ` -- ${s.health.reason}` : ""}`));
    const name = (x) => { const t = ((net && net.nodes) || []).find((y) => y.id === x); return t ? t.title : x; };
    const deps = (net.links || []).filter((l) => l.source === id && l.rel === "depends").map((l) => name(l.target));
    const users = (net.links || []).filter((l) => l.target === id && l.rel === "depends").map((l) => name(l.source));
    const traffic = (net.links || []).filter((l) => l.rel === "traffic" && (l.source === id || l.target === id)).length;
    if (deps.length) box.appendChild(el("div", "", `depends on: ${deps.slice(0, 8).join(", ")}${deps.length > 8 ? ` +${deps.length - 8}` : ""}`));
    if (users.length) box.appendChild(el("div", "", `needed by: ${users.slice(0, 8).join(", ")}${users.length > 8 ? ` +${users.length - 8}` : ""}`));
    if (traffic) box.appendChild(el("div", "", `${traffic} live traffic link(s)`));
    if (!deps.length && !users.length && !traffic) box.appendChild(el("div", "none", "no recorded dependencies"));
    return s.title;
  }

  function brickDetail(id) {
    const box = $("brick-detail");
    const n = nodeById(id);
    box.textContent = "";
    if (!n) { box.appendChild(el("div", "none", "not in the registry")); return id; }
    const m = n.meta || {};
    box.appendChild(el("div", "k", `aw* ${m.kind || "brick"} · ${m.rawStatus || n.status}`));
    if (m.tagline) box.appendChild(el("div", "", m.tagline));
    if (m.adopt) box.appendChild(el("div", "none", `adopt: ${m.adopt}`));
    return n.title;
  }

  function select(which, opts = {}) {
    const kind = which.startsWith("door:") ? "door" : which.startsWith("svc:") ? "svc" : which.startsWith("brick:") ? "brick" : which;
    selected = which;
    $("dock").hidden = false;
    let title = DOCK_TITLES[kind] || which;
    let nodeId = kind === "door" || kind === "svc" || kind === "brick" ? null : `ctl:${kind}`;
    if (kind === "door") {
      const s = doors[Number(which.slice(5))];
      if (!s) { closeDock(); return; }
      title = s.label;
      $("door-detail").textContent = `${s.up ? `up · ${s.ms} ms` : "DOWN"} · ${s.detail || ""} · ${s.url}`;
      nodeId = which;
    } else if (kind === "svc") {
      nodeId = which.slice(4);
      title = svcDetail(nodeId);
    } else if (kind === "brick") {
      nodeId = which.slice(6);
      title = brickDetail(nodeId);
    }
    $("dock-title").textContent = title;
    for (const [k, id] of Object.entries(DETAILS)) { const n = $(id); if (n) n.hidden = k !== kind; }
    let first = null;
    for (const b of VERB_BUTTONS) {
      b.hidden = b.dataset.bead !== kind || (b.id === "b-node-space" && !spaceOk);
      if (!b.hidden && !first && !b.disabled) first = b;
    }
    if (armed && armed.hidden) disarm();
    if (space && !opts.fromEngine && nodeId) { try { space.select(nodeId); } catch { /* not drawn */ } }
    if (!opts.keepFocus && first && first.focus) first.focus();
  }

  function closeDock(opts = {}) {
    selected = null;
    $("dock").hidden = true;
    disarm();
    if (space && !opts.fromEngine) { try { space.select(null); } catch { /* not drawn */ } }
  }

  $("dock-close").addEventListener("click", () => closeDock());
  $("b-open-door").addEventListener("click", () => {
    const s = selected && selected.startsWith("door:") ? doors[Number(selected.slice(5))] : null;
    if (s) W.fleet.open(s.url);
  });
  $("b-node-space").addEventListener("click", () => {
    if (selected && selected.startsWith("svc:")) W.fleet.open(`aither://space/?at=${encodeURIComponent(selected.slice(4))}`);
  });
  const toSpace = $("b-space");
  toSpace.addEventListener("click", (event) => {
    if (event && event.preventDefault) event.preventDefault();
    W.fleet.open(toSpace.dataset.space || "aither://space/?at=galaxy:fleet");
  });
  if (typeof W.fleet.spaceAvailable === "function") {
    Promise.resolve(W.fleet.spaceAvailable())
      .then((yes) => { spaceOk = yes === true; toSpace.hidden = !spaceOk; })
      .catch(() => { toSpace.hidden = true; });
  }
  const help = $("b-help");
  help.addEventListener("click", () => {
    const f = $("cli-hints");
    f.hidden = !f.hidden;
    setAttr(help, "aria-expanded", f.hidden ? "false" : "true");
  });

  function setBusy(action) {
    busy = action;
    for (const b of buttons) b.disabled = !!action;
    $("b-refresh").disabled = !!action;
    $("b-adopt").disabled = !!action || !adoptable;
    $("hint").textContent = action ? `running "${action}"` : "auto-refresh every 30 s";
    if (!action) disarm();
    paintHeader();
    redraw();
  }

  function disarm() {
    if (armed) { armed.classList.remove("confirm"); armed.querySelector(".d").textContent = armed.dataset.desc; }
    armed = null;
    clearTimeout(armTimer);
  }

  const PROBE_DEADLINE_S = 90;

  async function doorsVerdict() {
    let rows;
    try { rows = (await W.fleet.doors()) || []; } catch { rows = []; }
    const fleetDoors = rows.filter((r) => r.scope === "fleet");
    const up = fleetDoors.filter((r) => r.up);
    if (!fleetDoors.length) return "the doors could not be probed from the host";
    if (up.length) return `the distro is up but slow (${up.length}/${fleetDoors.length} fleet doors answer) -- usually a build or a boot, not a dead fleet`;
    return `NO fleet door answers (0/${fleetDoors.length}) -- the WSL distro is DOWN or wedged, not busy. `
      + "The WSL watchdog recovers it on its own (3-10 min); nothing here can reach it until then";
  }

  async function refresh(force) {
    probing = true;
    if (!everProbed) render(null);
    else if (!busy) $("hint").textContent = "refreshing…";
    const startedAt = Date.now();
    let clockTimer;
    const tick = () => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      if (!everProbed) {
        pill.textContent = `PROBING ${secs}s`;
        if (secs === 15) {
          void doorsVerdict().then((why) => {
            if (probing && !everProbed) { const sl = $("statusline"); sl.textContent = `still probing -- ${why}`; sl.dataset.tone = /DOWN or wedged/.test(why) ? "bad" : "warn"; }
          });
        }
      } else if (!busy) {
        $("hint").textContent = `refreshing… ${secs}s`;
      }
      clockTimer = setTimeout(tick, 1000);
    };
    clockTimer = setTimeout(tick, 1000);
    let deadlineTimer = null;
    const deadline = new Promise((resolve) => {
      deadlineTimer = setTimeout(async () => resolve({
        ok: false, cannotJudge: true,
        error: `no answer from the fleet probe in ${PROBE_DEADLINE_S} s -- ${await doorsVerdict()}. `
          + "Nothing was changed; the actions still work once it answers.",
      }), PROBE_DEADLINE_S * 1000);
    });
    let st;
    try {
      st = await Promise.race([W.fleet.status(force ? { maxAgeMs: 0 } : {}), deadline]);
    } catch (error) {
      st = { ok: false, cannotJudge: true, error: (error && error.message) || String(error) };
    } finally {
      probing = false;
      clearTimeout(clockTimer);
      clearTimeout(deadlineTimer);
    }
    everProbed = true;
    if (!busy) $("hint").textContent = "auto-refresh every 30 s";
    if (st && st.busy && st.busy !== "status" && !busy) setBusy(st.busy);
    render(st);
    return st;
  }

  async function run(action) {
    localRun = true;
    setBusy(action);
    try {
      const v = await W.fleet.run(action);
      if (v.busy) { line(v.error, "err"); }
      else if (action === "host-status") {
        renderHost(v);
        line(`host-status: ${v.verdict || v.error || "no verdict"}`, v.ok ? "ok" : "err");
        for (const p of v.problems || []) line(`  ${p}`, "err");
      } else if (action.startsWith("host-")) {
        for (const c of v.commands || []) line(`  $ ${c}`, "cmd");
        for (const r of v.results || []) line(`  rc=${r.rc} ${r.tail || ""}`, r.rc === 0 ? "ok" : "err");
        line(`${action}: ${v.ok ? "ok" : (v.error || "failed")}`, v.ok ? "ok" : "err");
      } else if (action.startsWith("arc-") && !v.cannotJudge) {
        arcVerdict = v;
        const wm = v.world_model || {};
        const steps = wm.train_steps != null ? ` · train_steps ${wm.train_steps}` : "";
        const problems = (v.problems || []).length ? ` · ${v.problems.join("; ")}` : "";
        line(`${action}: ${v.verdict || (v.ok ? "ok" : "refused")}${steps}${problems}`, v.ok ? "ok" : "err");
      } else if (!v.ok) {
        if (action.startsWith("arc-")) arcVerdict = v;
        line(`${action}: ${v.error || "refused"}`, "err");
        for (const f of v.failed || []) line(`  FAILED ${f.name || f.unit}: ${f.error || f.reason || ""}`, "err");
      } else {
        const extra = v.fleet_running_after != null ? ` — ${v.fleet_running_after} container(s) still running`
          : v.fleet_running != null ? ` — ${v.fleet_running} container(s) running` : "";
        line(`${action}: ok${extra}`, "ok");
      }
    } finally {
      localRun = false;
      setBusy(null);
      await refresh(true);
      void loadNetwork(true);
    }
  }

  for (const b of buttons) {
    b.dataset.desc = b.querySelector(".d").textContent;
    b.addEventListener("click", () => {
      const action = b.dataset.action;
      if (DESTRUCTIVE.has(action)) {
        if (armed !== b) {
          disarm();
          armed = b;
          b.classList.add("confirm");
          b.querySelector(".d").textContent = "Click again within 6 s to confirm.";
          armTimer = setTimeout(disarm, 6000);
          return;
        }
        disarm();
      }
      void run(action);
    });
  }
  $("b-refresh").addEventListener("click", () => { void refresh(true); void loadNetwork(true); });
  $("b-view").addEventListener("click", () => setView(view === "map" ? "overview" : "map"));
  $("b-adopt").addEventListener("click", () => void run("adopt"));

  W.fleet.onProgress((p) => {
    if (!p || p.action === "status") return;
    if (p.phase === "start") { line(p.line, "cmd"); if (!busy) setBusy(p.action); }
    else if (p.phase === "run") line(p.line);
    else if (p.phase === "end" && !localRun) {
      line(`${p.action}: ${p.verdict && p.verdict.ok ? "ok" : (p.verdict && p.verdict.error) || "refused"}`,
        p.verdict && p.verdict.ok ? "ok" : "err");
      setBusy(null);
      void refresh(true);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (selected) { closeDock(); return; }
      W.fleet.close();
    }
  });

  // for the page test and the smoke: the dock's map and what the network was given, read-only
  W.fleetPane = Object.freeze({
    select, closeDock, verdict: () => verdict(lastStatus), data: () => lastData, setView, view: () => view, mapLabel,
    /** Select by NODE id ("svc:veil", "aw:awnix", "ctl:gpu"): the same path a click on that node takes. */
    selectNode: (id) => {
      const n = nodeById(id);
      const k = n && n.meta && n.meta.kind;
      if (k === "ctl") select(n.meta.key);
      else if (k === "door") select(`door:${n.meta.index}`);
      else if (k === "svc") select(`svc:${id}`);
      else if (k === "brick") select(`brick:${id}`);
    },
    verbsFor: (k) => VERB_BUTTONS.filter((b) => b.dataset.bead === k).map((b) => b.dataset.action || b.id),
  });

  redraw();
  void loadEcosystem();
  void loadNetwork(false);
  void refresh(true);
  setInterval(() => { if (!busy) void refresh(true); }, 30_000);
  setInterval(() => { if (!busy) void loadNetwork(false); }, 60_000);
  setInterval(heartbeat, 4_000);
})();
