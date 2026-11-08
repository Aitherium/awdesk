"use strict";

// This computer at a glance: CPU, memory, uptime. Node's own `os` (no PowerShell
// worker): the full process/network view is the System window (system-monitor.cjs).
let last = null;

function cpuBusy(os) {
  const now = os.cpus().reduce((acc, c) => {
    const t = c.times;
    acc.idle += t.idle;
    acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return acc;
  }, { idle: 0, total: 0 });
  const prev = last;
  last = now;
  if (!prev || now.total <= prev.total) return null;
  return 1 - (now.idle - prev.idle) / (now.total - prev.total);
}

const pct = (x) => `${Math.round(x * 100)}%`;
const gb = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;

module.exports = {
  id: "system",
  label: "System",
  hint: "CPU, memory and uptime of this computer",
  view: "list",
  size: { w: 256, h: 192 },
  refreshMs: 3000,
  async read(ctx) {
    const os = (ctx && ctx.os) || require("node:os");
    const busy = cpuBusy(os);
    const total = os.totalmem();
    const used = total - os.freemem();
    const up = os.uptime();
    return {
      sub: os.hostname(),
      rows: [
        { label: "CPU", value: busy == null ? "measuring" : pct(busy), tone: busy > 0.9 ? "bad" : busy > 0.7 ? "warn" : "ok" },
        { label: "Memory", value: `${gb(used)} / ${gb(total)}`, tone: used / total > 0.9 ? "bad" : used / total > 0.8 ? "warn" : "ok" },
        { label: "Cores", value: String(os.cpus().length) },
        { label: "Up", value: `${Math.floor(up / 86400)}d ${Math.floor((up % 86400) / 3600)}h` },
      ],
    };
  },
  /** For tests: forget the previous CPU sample. */
  reset() { last = null; },
};
