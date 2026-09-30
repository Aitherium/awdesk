"use strict";

// Every file the app loads at runtime must match electron-builder's `build.files`,
// or the installed app opens a blank window. v0.1.1 shipped with only `*.cjs` listed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      re += "(" + glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|") + ")";
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\?]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

function isPackaged(rel, files = pkg.build.files) {
  let included = false;
  for (const pattern of files) {
    const negate = pattern.startsWith("!");
    if (globToRegExp(negate ? pattern.slice(1) : pattern).test(rel)) included = !negate;
  }
  return included;
}

function runtimeAssets() {
  const dir = __dirname;
  const names = fs.readdirSync(dir);
  const sources = names
    .filter((n) => /\.(cjs|html)$/.test(n) && !n.endsWith(".test.cjs"))
    .map((n) => fs.readFileSync(path.join(dir, n), "utf8"))
    .join("\n");
  return names.filter(
    (n) => /\.(html|css|json|js|svg|png)$/.test(n) && fs.statSync(path.join(dir, n)).isFile() && sources.includes(n),
  );
}

test("glob matcher honours ** , extension sets and negation", () => {
  const files = ["electron/**/*.{cjs,html}", "!electron/**/*.test.cjs"];
  assert.equal(isPackaged("electron/a.html", files), true);
  assert.equal(isPackaged("electron/a.test.cjs", files), false);
  assert.equal(isPackaged("electron/a.css", files), false);
});

test("every runtime asset the app references is packaged", () => {
  const assets = runtimeAssets();
  assert.ok(assets.includes("browser-chrome.html"), "scan found no HTML: the check itself is broken");
  const missing = assets.filter((n) => !isPackaged(`electron/${n}`));
  assert.deepEqual(missing, [], `not in package.json build.files: ${missing.join(", ")}`);
});
