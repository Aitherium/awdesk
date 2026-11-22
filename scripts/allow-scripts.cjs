"use strict";

/**
 * Which locked packages have an install script that package.json `allowScripts` does not cover.
 *
 * Why this exists: `.npmrc` sets strict-allow-scripts, and `npm ci` on CI (npm 12) refuses the
 * whole install with ESTRICTALLOWSCRIPTS when one install script is not covered. The npm on a
 * developer machine may be too old to know the setting, so a wrong key installs fine locally
 * and breaks every CI and release job. This check needs no npm and runs in `npm test`.
 *
 * The rules mirror npm's own matcher (@npmcli/arborist lib/script-allowed.js, read in 12.2.2):
 * - A registry package is matched by the name and version in its lockfile tarball URL. The key
 *   is `name`, `name@1.2.3` or `name@1.2.3 || 1.2.4`. Ranges and tags match nothing.
 * - A git package is matched by its repository plus a prefix of the resolved commit sha. The
 *   key is `github:owner/repo#<sha>` or a git URL. A tag after `#` matches nothing, because the
 *   lockfile holds the sha. A `name@version` key never matches a git package.
 * - `false` denies, and a deny wins.
 *
 * It also checks `allow-git` in `.npmrc`: npm 12 refuses to fetch any git dependency (EALLOWGIT)
 * unless that is `root` or `all`. Electron is a git dependency (castLabs), so both rules apply.
 */

const GIT_HOSTS = { github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org" };

/** `host/owner/repo` and committish of a git spec or lockfile `resolved`, or null if it is not git. */
function parseGit(spec) {
  const s = String(spec || "");
  const hash = s.indexOf("#");
  const committish = hash < 0 ? "" : s.slice(hash + 1);
  const body = hash < 0 ? s : s.slice(0, hash);
  const short = /^(github|gitlab|bitbucket):([^/\s]+)\/([^/\s]+)$/.exec(body);
  if (short) return { repo: `${GIT_HOSTS[short[1]]}/${short[2]}/${short[3].replace(/\.git$/, "")}`.toLowerCase(), committish };
  const url = /^git(?:\+(?:ssh|https|http))?:\/\/(?:[^@/]+@)?([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(body);
  if (url) return { repo: `${url[1]}/${url[2]}/${url[3]}`.toLowerCase(), committish };
  return null;
}

/** Name and version from a registry tarball URL: `<host>/<name>/-/<base>-<version>.tgz`. */
function parseRegistryTarball(resolved) {
  const m = /^https?:\/\/[^/]+\/(.+)\/-\/([^/]+)\.tgz$/.exec(String(resolved || ""));
  if (!m) return null;
  const name = decodeURIComponent(m[1]);
  const base = name.slice(name.lastIndexOf("/") + 1);
  if (!m[2].startsWith(`${base}-`)) return null;
  return { name, version: m[2].slice(base.length + 1) };
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** True when one allowScripts key names this locked package. */
function keyMatches(key, entry) {
  const resolved = String((entry && entry.resolved) || "");
  const keyGit = parseGit(key);
  if (keyGit) {
    const nodeGit = resolved.startsWith("git") ? parseGit(resolved) : null;
    if (!nodeGit || nodeGit.repo !== keyGit.repo) return false;
    if (!keyGit.committish) return true;
    // The locked full sha must START WITH the key's sha, never the reverse.
    return nodeGit.committish !== "" && nodeGit.committish.startsWith(keyGit.committish);
  }
  const trusted = parseRegistryTarball(resolved);
  if (!trusted) return false;
  const at = key.lastIndexOf("@");
  const name = at > 0 ? key.slice(0, at) : key;
  const want = at > 0 ? key.slice(at + 1).trim() : "";
  if (name !== trusted.name) return false;
  if (want === "" || want === "*") return true;
  const versions = want.split("||").map((v) => v.trim());
  if (!versions.every((v) => EXACT_VERSION.test(v))) return false;
  return versions.includes(trusted.version);
}

/** true = allowed, false = denied, null = no key names it (npm calls this unreviewed). */
function scriptAllowed(entry, policy) {
  let allow = false;
  for (const [key, value] of Object.entries(policy || {})) {
    if (!keyMatches(key, entry)) continue;
    if (value === false) return false;
    if (value === true) allow = true;
  }
  return allow ? true : null;
}

/** Locked packages with an install script that `npm ci` under strict-allow-scripts would refuse. */
function uncoveredInstallScripts(pkg, lock) {
  const policy = (pkg && pkg.allowScripts) || {};
  const out = [];
  for (const [where, entry] of Object.entries((lock && lock.packages) || {})) {
    if (!entry || !entry.hasInstallScript) continue;
    if (scriptAllowed(entry, policy) === true) continue;
    out.push({ where, version: entry.version || "", resolved: entry.resolved || "" });
  }
  return out;
}

/** allowScripts keys that name no locked package: a stale key left behind by an upgrade. */
function staleKeys(pkg, lock) {
  const entries = Object.values((lock && lock.packages) || {});
  return Object.keys((pkg && pkg.allowScripts) || {}).filter((key) => !entries.some((e) => keyMatches(key, e)));
}

/**
 * Git dependencies that npm 12 would refuse to fetch (EALLOWGIT). Its `allow-git` default is
 * `none`; `root` allows the git dependencies named in the project's own package.json, `all`
 * allows any.
 */
function blockedGitDependencies(npmrc, pkg, lock) {
  const m = /^\s*allow-git\s*=\s*(\S+)\s*$/m.exec(String(npmrc || ""));
  const mode = m ? m[1] : "none";
  const direct = { ...((pkg && pkg.dependencies) || {}), ...((pkg && pkg.devDependencies) || {}), ...((pkg && pkg.optionalDependencies) || {}) };
  const out = [];
  for (const [where, entry] of Object.entries((lock && lock.packages) || {})) {
    if (!entry || !String(entry.resolved || "").startsWith("git")) continue;
    if (mode === "all") continue;
    const name = where.slice(where.lastIndexOf("node_modules/") + "node_modules/".length);
    const isRoot = where === `node_modules/${name}` && parseGit(direct[name]) !== null;
    if (mode === "root" && isRoot) continue;
    out.push({ where, resolved: entry.resolved, mode });
  }
  return out;
}

module.exports = { blockedGitDependencies, parseGit,parseRegistryTarball, keyMatches, scriptAllowed, uncoveredInstallScripts, staleKeys };
