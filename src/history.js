/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir, sanitizeName } = require('./util');

const SCHEMA_VERSION = 1;

/**
 * history.json — the dashboard's persistent dataset.
 *
 * {
 *   schemaVersion: 1,
 *   repository: "owner/repo", repositoryUrl, defaultBranch,
 *   generatedAt: ISO,
 *   workflows: { "<id>": { id, name, path, state } },
 *   runs: [ RunRecord … ]           // newest first
 * }
 *
 * RunRecord {
 *   id, workflowId, workflowName, workflowPath, runNumber, attempt, event,
 *   status, conclusion, branch, sha, title, actor, htmlUrl,
 *   createdAt, startedAt, completedAt, updatedAt   (ISO strings)
 *   durationMs, queueMs,
 *   jobs: [ { id, name, status, conclusion, startedAt, completedAt, durationMs,
 *             runnerName, labels, htmlUrl,
 *             steps: [ { number, name, status, conclusion, startedAt, completedAt, durationMs } ] } ],
 *   mvnLens: [ MvnLensEntry … ]
 * }
 *
 * MvnLensEntry {
 *   artifactId, artifactName, label, jobId, jobName, stepNumber, stepName,
 *   collectedAt, source ("meta" | "artifact"),
 *   reports: [ { name, path (site-relative) | null, removed: bool, summary } ]
 * }
 */

function emptyHistory(repository) {
  return { schemaVersion: SCHEMA_VERSION, repository: repository || null, repositoryUrl: null, defaultBranch: null, generatedAt: null, workflows: {}, runs: [] };
}

function loadHistory(file, repository) {
  if (!file || !fs.existsSync(file)) return emptyHistory(repository);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return normalizeHistory(raw, repository);
}

function normalizeHistory(raw, repository) {
  const h = emptyHistory(repository);
  if (!raw || typeof raw !== 'object') return h;
  if (raw.schemaVersion && raw.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`history.json schema ${raw.schemaVersion} is newer than this action supports (${SCHEMA_VERSION}); upgrade the action`);
  }
  if (raw.repository && repository && raw.repository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(`history.json belongs to ${raw.repository}, not ${repository}; use a different publish-dir/history-file`);
  }
  h.repository = raw.repository || repository || null;
  h.repositoryUrl = raw.repositoryUrl || null;
  h.defaultBranch = raw.defaultBranch || null;
  h.generatedAt = raw.generatedAt || null;
  h.workflows = raw.workflows && typeof raw.workflows === 'object' ? raw.workflows : {};
  h.runs = Array.isArray(raw.runs) ? raw.runs.filter(r => r && typeof r.id === 'number') : [];
  for (const r of h.runs) {
    if (!Array.isArray(r.jobs)) r.jobs = [];
    r.mvnLens = Array.isArray(r.mvnLens) ? r.mvnLens.filter(e => e && typeof e === 'object') : [];
    for (const e of r.mvnLens) {
      e.reports = Array.isArray(e.reports) ? e.reports.filter(x => x && typeof x === 'object') : [];
      for (const rep of e.reports) {
        // history.json may come from a branch or a seed URL: report paths are the
        // only values that reach the file system, so they must look exactly like
        // what reportDirFor() produces.
        if (rep.path !== null && rep.path !== undefined && !isValidReportPath(rep.path)) {
          rep.path = null;
          rep.removed = true;
        }
      }
    }
  }
  sortRuns(h);
  return h;
}

const REPORT_PATH_RE = /^reports\/\d{1,20}\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

/** `reports/<runId>/<artifact>/<file>` with safe characters only — no `..`, no absolute paths, no separators inside names. */
function isValidReportPath(p) {
  return typeof p === 'string' && REPORT_PATH_RE.test(p) && !p.split('/').some(seg => seg === '..' || seg === '.');
}

function saveHistory(file, history) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(history) + '\n');
}

function sortRuns(history) {
  history.runs.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || b.id - a.id);
}

function findRun(history, id) { return history.runs.find(r => r.id === id) || null; }

function upsertRun(history, run) {
  const i = history.runs.findIndex(r => r.id === run.id);
  if (i >= 0) history.runs[i] = run; else history.runs.push(run);
}

/**
 * Keeps at most `maxRunsPerWorkflow` runs per workflow (newest first) and, of
 * those, only the `keepReports` most recent runs per workflow keep their report
 * files — older entries keep their summaries (for the trend charts) but lose the
 * HTML. Returns { removedRuns, removedReportPaths }.
 */
function prune(history, opts) {
  const o = opts || {};
  const maxRuns = o.maxRunsPerWorkflow || Infinity;
  const keepReports = o.keepReports === undefined ? Infinity : o.keepReports;
  sortRuns(history);
  const perWorkflow = new Map();
  const removedRuns = [];
  const removedReportPaths = [];
  const kept = [];
  for (const run of history.runs) {
    const key = String(run.workflowId);
    const n = (perWorkflow.get(key) || 0) + 1;
    perWorkflow.set(key, n);
    if (n > maxRuns) {
      removedRuns.push(run);
      for (const e of run.mvnLens) for (const rep of e.reports || []) if (rep.path) removedReportPaths.push(rep.path);
      continue;
    }
    if (n > keepReports) {
      for (const e of run.mvnLens) {
        for (const rep of e.reports || []) {
          if (rep.path) { removedReportPaths.push(rep.path); rep.path = null; rep.removed = true; }
        }
      }
    }
    kept.push(run);
  }
  history.runs = kept;
  return { removedRuns, removedReportPaths };
}

/** Stable identity of a Maven build across runs: workflow + job + step + label. */
function mavenSeriesKey(workflowPath, jobName, stepName, label) {
  return [workflowPath || '', jobName || '', stepName || '', label || ''].map(s => String(s)).join(' ');
}

/** Site-relative directory for a run's artifact reports. */
function reportDirFor(runId, artifactName) {
  return `reports/${runId}/${sanitizeName(artifactName, 100)}`;
}

module.exports = {
  SCHEMA_VERSION, emptyHistory, loadHistory, normalizeHistory, saveHistory, sortRuns,
  findRun, upsertRun, prune, mavenSeriesKey, reportDirFor, isValidReportPath,
};
