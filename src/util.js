/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const core = require('@actions/core');

// ---------------------------------------------------------------------------
// Action inputs / outputs / logging: thin wrappers over @actions/core (GitHub's
// toolkit, bundled into dist/ by `npm run build`; the runner executes the
// bundle, nothing is installed at run time).
// ---------------------------------------------------------------------------

/**
 * Reads an action input via @actions/core. The runner uppercases the input name
 * and replaces spaces with underscores; hyphens are kept ("github-token" ->
 * INPUT_GITHUB-TOKEN). Composite actions must forward inputs explicitly through
 * `env:`, and there a hyphen is awkward, so the underscore spelling
 * (INPUT_GITHUB_TOKEN) is accepted as an alias — @actions/core alone does not.
 * Supports `required`, `default` and `trimWhitespace`.
 */
function getInput(name, opts) {
  const o = opts || {};
  const coreOpts = { required: false, trimWhitespace: o.trimWhitespace !== false };
  let raw = core.getInput(name, coreOpts);
  if (raw === '' && name.includes('-')) raw = core.getInput(name.replace(/-/g, '_'), coreOpts);
  if (raw === '') {
    if (o.required) throw new Error(`Input required and not supplied: ${name}`);
    return o.default === undefined ? '' : o.default;
  }
  return raw;
}

/** Lenient boolean (true/yes/1/on, false/no/0/off); core.getBooleanInput only accepts true/false. */
function getBooleanInput(name, def) {
  const v = getInput(name, { default: def === undefined ? '' : String(def) }).toLowerCase();
  if (v === '') return !!def;
  if (['true', 'yes', '1', 'on'].includes(v)) return true;
  if (['false', 'no', '0', 'off'].includes(v)) return false;
  throw new Error(`Input "${name}" is not a boolean: ${v}`);
}

function getIntInput(name, def, min, max) {
  const v = getInput(name, { default: String(def) });
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Input "${name}" is not an integer: ${v}`);
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/** Splits a newline- or comma-separated list input. */
function parseList(value) {
  if (!value) return [];
  return String(value).split(/[\n,]/).map(s => s.trim()).filter(Boolean);
}

/** Sets a step output ($GITHUB_OUTPUT; outside a runner core prints a `::set-output` line). */
function setOutput(name, value) {
  core.setOutput(name, value === undefined || value === null ? '' : String(value));
}

/** Appends Markdown to the job summary ($GITHUB_STEP_SUMMARY); a no-op outside a runner. */
async function appendSummary(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await core.summary.addRaw(markdown, true).write();
}

// ---------------------------------------------------------------------------
// Logging (workflow commands; @actions/core escapes them)
// ---------------------------------------------------------------------------

function log(msg) { core.info(String(msg)); }
/** `::debug::` lines (shown by "Re-run with debug logging" / RUNNER_DEBUG=1); BUILD_DASHBOARD_DEBUG prints them plainly for local runs. */
function debug(msg) { if (process.env.BUILD_DASHBOARD_DEBUG) core.info('[debug] ' + msg); else core.debug(String(msg)); }
function warning(msg) { core.warning(String(msg)); }
function notice(msg) { core.notice(String(msg)); }
function error(msg) { core.error(String(msg)); }
function group(title) { core.startGroup(String(title)); }
function endGroup() { core.endGroup(); }

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function exists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, obj, pretty) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, pretty ? JSON.stringify(obj, null, 2) + '\n' : JSON.stringify(obj));
}

/** Recursively copies src into dest (files are overwritten, extra dest files kept). `opts.skip(name)` excludes entries. */
function copyDir(src, dest, opts) {
  const skip = opts && opts.skip;
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip && skip(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d, opts);
    else fs.copyFileSync(s, d);
  }
}

/** True when `target` is `base` itself or a path strictly inside it (no `..` escape, same drive). */
function isWithin(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Asks the runner to mask a value in the job log (GitHub only masks the literal secret it knows). */
function addMask(value) {
  if (value && process.env.GITHUB_ACTIONS) core.setSecret(String(value));
}

/** Lists files under dir (relative POSIX paths). */
function listFiles(dir, base) {
  const out = [];
  if (!exists(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Minimal glob (supports `**`, `*`, `?`), relative to cwd or absolute.
 * Node 20 has no fs.glob, and the action carries no dependencies.
 */
function glob(pattern, cwd) {
  const root = cwd || process.cwd();
  const norm = pattern.replace(/\\/g, '/');
  if (!/[*?]/.test(norm)) {
    const p = path.isAbsolute(norm) ? norm : path.join(root, norm);
    return exists(p) && fs.statSync(p).isFile() ? [p] : [];
  }
  const abs = path.isAbsolute(norm);
  const parts = norm.split('/').filter((s, i) => s !== '' || i === 0);
  // Split into a literal prefix directory and the wildcard remainder.
  let i = 0;
  const prefix = [];
  while (i < parts.length && !/[*?]/.test(parts[i])) { prefix.push(parts[i]); i++; }
  const startDir = abs ? (prefix.join('/') || '/') : path.join(root, ...prefix);
  const rest = parts.slice(i);
  const re = new RegExp('^' + rest.map(seg => {
    if (seg === '**') return '(?:.*/)?';
    return seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '/';
  }).join('').replace(/\/$/, '') + '$');
  const results = [];
  for (const rel of listFiles(startDir)) {
    if (re.test(rel)) results.push(path.join(startDir, rel));
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Artifact- and path-safe name: keeps [A-Za-z0-9._-] (existing dashes included), collapses each run of other characters to one '-'. */
function sanitizeName(s, max) {
  const out = String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const lim = max || 120;
  return (out || 'unnamed').slice(0, lim);
}

function parseIsoMs(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function isoNow() { return new Date().toISOString(); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Runs `fn(item)` over items with at most `limit` in flight; results in order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.max(1, Math.min(limit, items.length)); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function toPosix(p) { return p.replace(/\\/g, '/'); }

module.exports = {
  getInput, getBooleanInput, getIntInput, parseList, setOutput, appendSummary,
  log, debug, warning, notice, error, group, endGroup,
  ensureDir, rmrf, exists, readJson, writeJson, copyDir, listFiles, glob, isWithin, addMask,
  sanitizeName, parseIsoMs, isoNow, sleep, mapLimit, toPosix,
};
