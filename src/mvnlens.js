/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * Reads the model an mvn-lens report embeds.
 *
 * report.html carries the whole TimelineModel inline in
 *   <script id="mvnlens-data" type="application/json">…</script>
 * (older builds used id="mvnflight-data"). The payload is either plain JSON or
 * "gzip:" + base64(gzip(json)). The renderer neutralises any inner "</script"
 * as "<\/script", so the first literal "</script>" closes the block.
 *
 * @returns {object|null} the parsed model, or null when the file is not an mvn-lens report
 */
function extractModelFromHtml(html) {
  const m = /<script\s+id="(?:mvnlens|mvnflight)-data"\s+type="application\/json"\s*>/i.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = html.indexOf('</script>', start);
  if (end < 0) return null;
  let raw = html.slice(start, end).trim();
  if (!raw) return null;
  if (raw.startsWith('gzip:')) {
    const bytes = Buffer.from(raw.slice(5), 'base64');
    raw = zlib.gunzipSync(bytes).toString('utf8');
  }
  return JSON.parse(raw);
}

/**
 * Condenses a TimelineModel into the headline numbers the dashboard trends and
 * lists. Every field is optional on the model, so everything here is defensive.
 */
function summarizeModel(model) {
  const s = (model && model.session) || {};
  const env = (model && model.environment) || null;
  const jit = Array.isArray(model && model.jit) ? model.jit : [];
  const modules = Array.isArray(model && model.modules) ? model.modules : [];
  const issues = Array.isArray(model && model.issues) ? model.issues : [];
  const transfer = (model && model.repoTransferSummary) || null;
  const tests = (model && model.tests && typeof model.tests === 'object') ? model.tests : {};

  const wallMs = num(s.wallMs);
  const totalMs = num(s.totalMs) || wallMs;
  const c2Ms = sumBy(jit.filter(e => e && num(e.level) >= 4), 'durationMs');
  const jitMs = sumBy(jit, 'durationMs');
  let testCount = 0;
  let testMs = 0;
  for (const list of Object.values(tests)) {
    if (!Array.isArray(list)) continue;
    testCount += list.length;
    testMs += sumBy(list, 'durationMs');
  }
  const severities = {};
  for (const i of issues) {
    const sev = String((i && (i.severity || i.level)) || 'unknown').toLowerCase();
    severities[sev] = (severities[sev] || 0) + 1;
  }

  return {
    schemaVersion: 1,
    groupId: str(s.groupId),
    artifactId: str(s.artifactId),
    version: str(s.version),
    goals: Array.isArray(s.goals) ? s.goals.map(String) : [],
    threads: num(s.threads),
    builderId: str(s.builderId),
    mavenVersion: str(s.mavenVersion || s.maven),
    jdkVersion: str(s.jdkVersion || s.jdk),
    status: str(s.status),
    startedAt: num(s.startedAt) || null,
    endedAt: num(s.endedAt) || null,
    totalMs, wallMs,
    cpuMs: num(s.cpuMs),
    gcMs: num(s.gcMs),
    gcCount: num(s.gcCount),
    jitMs, c2Ms,
    downloadMs: transfer ? num(transfer.millisDownloadedThisBuild) : 0,
    downloadBytes: transfer ? num(transfer.bytesDownloadedThisBuild) : 0,
    downloadCount: transfer ? num(transfer.artifactDownloadsCount) + num(transfer.metadataDownloadsCount) : 0,
    moduleCount: modules.length,
    modules: modules.slice(0, 500).map(m => ({
      artifactId: str(m.artifactId), name: str(m.name), wallMs: num(m.wallMs),
      startMs: num(m.startMs) || null, endMs: num(m.endMs) || null, forkCount: num(m.forkCount),
    })),
    slowestMojo: model && model.slowestMojo ? pick(model.slowestMojo, ['plugin', 'goal', 'phase', 'executionId', 'moduleKey', 'durationMs']) : null,
    slowestTest: model && model.slowestTest ? pick(model.slowestTest, ['className', 'methodName', 'displayName', 'framework', 'moduleKey', 'durationMs']) : null,
    testCount, testMs,
    issueCount: issues.length,
    issueSeverities: severities,
    environment: env ? {
      availableProcessors: num(env.availableProcessors),
      cpuModel: str(env.cpuModel), cpuCores: num(env.cpuCores), cpuThreads: num(env.cpuThreads),
      memoryBytes: num(env.memoryBytes), osName: str(env.osName),
      jvmName: str(env.jvmName), jvmVendor: str(env.jvmVendor),
      mvnd: !!env.mvnd, githubActions: !!env.githubActions,
      containerType: str(env.containerType), c2DisabledBy: str(env.c2DisabledBy),
      virtualization: str(env.virtualization),
    } : null,
  };
}

/**
 * Reads an mvn-lens report from disk and returns its summary. Prefers the HTML
 * (the file that gets published) and falls back to a sibling model.json.
 * @returns {{summary: object|null, source: string|null, error: string|null}}
 */
function readReportSummary(htmlFile) {
  try {
    const html = fs.readFileSync(htmlFile, 'utf8');
    const model = extractModelFromHtml(html);
    if (model) return { summary: summarizeModel(model), source: 'html', error: null };
  } catch (e) {
    const sidecar = path.join(path.dirname(htmlFile), 'model.json');
    if (fs.existsSync(sidecar)) {
      try {
        return { summary: summarizeModel(JSON.parse(fs.readFileSync(sidecar, 'utf8'))), source: 'model.json', error: null };
      } catch (e2) {
        return { summary: null, source: null, error: `report unreadable (${e.message}); model.json unreadable (${e2.message})` };
      }
    }
    return { summary: null, source: null, error: e.message };
  }
  const sidecar = path.join(path.dirname(htmlFile), 'model.json');
  if (fs.existsSync(sidecar)) {
    try { return { summary: summarizeModel(JSON.parse(fs.readFileSync(sidecar, 'utf8'))), source: 'model.json', error: null }; } catch (e) { /* fall through */ }
  }
  return { summary: null, source: null, error: 'no embedded mvn-lens model found' };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function str(v) { return v === undefined || v === null ? null : String(v); }
function sumBy(list, key) { let t = 0; for (const e of list) t += num(e && e[key]); return t; }
function pick(obj, keys) { const o = {}; for (const k of keys) if (obj[k] !== undefined) o[k] = obj[k]; return o; }

module.exports = { extractModelFromHtml, summarizeModel, readReportSummary };
