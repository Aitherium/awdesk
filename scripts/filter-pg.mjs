#!/usr/bin/env node
/**
 * filter-pg.mjs — the PG (general-rated) gate for dist:pg-* builds.
 *
 * It JUDGES; it never deletes. The previous version read a `.pgignore` that
 * never existed in this tree, warned, applied no exclusions and exited 0, ran
 * a character-rating "filter" whose body was empty, and rmSync'd paths inside
 * the source tree itself. A PG artifact was therefore never checked at all.
 *
 * What it asserts (exit 1 on any violation, never 0 on silence):
 *   1. `.pgship` (the allowlist scripts/build_pg.py ships from) exists and is
 *      non-empty — a build that cannot name what it ships cannot be judged.
 *   2. electron-builder's `build.files` / `extraResources` do not pack the
 *      per-user `characters/` roster.
 *   3. No character directory reachable from a packaged tree (`public/`, which
 *      vite copies into `dist/`, and `dist/` itself with --dist) is rated
 *      r15/r18 or is unrated. An unrated character is UNJUDGED, not clean.
 *
 * Usage:
 *   node scripts/filter-pg.mjs            # before `npm run build`
 *   node scripts/filter-pg.mjs --dist     # after it, judges dist/ too
 *   node scripts/filter-pg.mjs --root DIR # judge another tree (tests)
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADULT_RATINGS = new Set(['r15', 'r18']);
// Character MODEL files. `.vrma` is an animation clip, not a character: a
// gitignored clip dropped into public/assets/animations/ must not be refused
// as an "unrated character".
const CHARACTER_ASSET = /\.(vrm|glb|gltf|fbx|pmx)$/i;

function parseArgs(argv) {
  const args = { root: resolve(dirname(fileURLToPath(import.meta.url)), '..'), dist: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) {
      args.root = resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--dist') {
      args.dist = true;
    }
  }
  return args;
}

function checkPgShip(root) {
  const file = join(root, '.pgship');
  if (!existsSync(file)) return [`.pgship not found at ${file} — the PG allowlist is missing`];
  const entries = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return entries.length ? [] : ['.pgship is empty — the PG allowlist names nothing'];
}

function checkBuilderConfig(root) {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return [`package.json not found at ${pkgPath}`];
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (error) {
    return [`package.json is unreadable: ${error.message}`];
  }
  const build = pkg.build || {};
  const patterns = [...(build.files || [])];
  for (const platform of ['win', 'mac', 'linux']) {
    for (const res of (build[platform] && build[platform].extraResources) || []) {
      patterns.push(typeof res === 'string' ? res : res.from || '');
    }
  }
  for (const res of build.extraResources || []) {
    patterns.push(typeof res === 'string' ? res : res.from || '');
  }
  return patterns
    .filter((p) => typeof p === 'string' && !p.startsWith('!'))
    .filter((p) => /^(\.\/)?characters(\/|$)/.test(p) || /^\*\*/.test(p))
    .map((p) => `electron-builder packs "${p}", which reaches the per-user characters/ roster`);
}

/** Every directory under `dir` that holds a character.json or a model file. */
function characterDirs(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  if (entries.some((e) => e.isFile() && (e.name === 'character.json' || CHARACTER_ASSET.test(e.name)))) {
    out.push(dir);
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'node_modules') characterDirs(join(dir, e.name), out);
  }
  return out;
}

function ratingOf(dir) {
  const file = join(dir, 'character.json');
  if (!existsSync(file)) return null;
  try {
    const rating = JSON.parse(readFileSync(file, 'utf8')).rating;
    return rating ? String(rating).toLowerCase() : null;
  } catch {
    return null;
  }
}

function checkPackagedCharacters(root, trees) {
  const problems = [];
  for (const tree of trees) {
    for (const dir of characterDirs(join(root, tree))) {
      const rel = relative(root, dir).split('\\').join('/');
      const rating = ratingOf(dir);
      if (rating === null) {
        problems.push(`${rel}: character is unrated (unjudged is not PG)`);
      } else if (ADULT_RATINGS.has(rating)) {
        problems.push(`${rel}: character is rated ${rating}`);
      }
    }
  }
  return problems;
}

function judge(root, { dist = false } = {}) {
  const shipProblems = checkPgShip(root);
  const trees = dist ? ['public', 'dist'] : ['public'];
  return [
    ...shipProblems,
    ...checkBuilderConfig(root),
    ...checkPackagedCharacters(root, trees),
  ];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const problems = judge(args.root, { dist: args.dist });
  if (problems.length) {
    console.error(`[FILTER-PG] PG build REFUSED — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`[FILTER-PG] PG gate clean (${args.dist ? 'public/ + dist/' : 'public/'}).`);
}

// Run unconditionally. An `argv[1] === import.meta.url` "am I the entry point"
// guard fails OPEN: Node derives import.meta.url from the realpath while argv[1]
// keeps the path as typed, so through a junction/symlink (the D:\desk copies,
// macOS /var -> /private/var) main() was skipped and the gate exited 0 having
// judged nothing. This file is a CLI; nothing imports it.
main();
