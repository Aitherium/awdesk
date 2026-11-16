/* global window, document */
"use strict";

/* phone-panel.html: renders describePhone() (phone-panel.cjs) with textContent only. */
const BADGE = {
  ready: "works now", "in-app": "in the Aither app", "after-link": "after linking", "needs-cable": "needs the cable",
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function render(s) {
  const app = document.getElementById("app");
  app.dataset.status = s.status;
  app.replaceChildren();
  const h = el("h1");
  h.append(el("span", "dot"), document.createTextNode(s.headline));
  app.append(h, el("p", "next", s.next));
  if (s.error) app.append(el("p", "err", s.error));
  const acts = el("div", "acts");
  for (const v of s.verbs) {
    const b = el("button", v.primary ? "primary" : "", s.busy === v.verb ? "Working..." : v.label);
    b.disabled = Boolean(s.busy);
    b.dataset.verb = v.verb;
    b.addEventListener("click", () => window.aitherPhone.act(v.verb));
    acts.append(b);
  }
  app.append(acts, el("h2", "", "What this phone can do for Aither"));
  const list = el("ul");
  for (const c of s.capabilities) {
    const li = el("li");
    li.dataset.cap = c.id;
    const t = el("div", "t");
    t.append(el("div", "n", c.label), el("div", "d", c.detail));
    if (c.action === "capture" && c.state === "ready") {
      const b = el("button", "", s.busy === "capture" ? "Capturing..." : "Capture its screen");
      b.disabled = Boolean(s.busy);
      b.dataset.verb = "capture";
      b.addEventListener("click", () => window.aitherPhone.act("capture"));
      t.append(b);
    }
    li.append(t, el("span", `badge ${c.state}`, BADGE[c.state] || c.state));
    list.append(li);
  }
  app.append(list);
  if (s.lastCapture) app.append(el("p", "file", `Saved: ${s.lastCapture}`));
}

window.aitherPhone.state().then(render);
window.aitherPhone.onChange(render);
