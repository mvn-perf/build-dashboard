/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readZip } = require('./zip');
const { extractModelFromHtml, summarizeModel } = require('./mvnlens');
const { findRun, upsertRun, reportDirFor, sortRuns } = require('./history');
const { log, debug, warning, parseIsoMs, isoNow, mapLimit, ensureDir, exists, sanitizeName } = require('./util');

const DEFAULTS = {
  workflows: [],
  excludeWorkflows: [],
  branches: [],
  events: [],
  maxRuns: 200,
  lookbackDays: 90,
  artifactPrefix: 'mvn-lens--',
  downloadReports: true,
  forceRefresh: false,
  concurrency: 4,
  runIds: [],
  /**
   * Runs whose head repository is a fork are skipped by default: a pull_request
   * workflow lets anyone upload artifacts, and reports are published as HTML on
   * the Pages origin. Opt in only for repositories that trust their contributors.
   */
  includeForkRuns: false,
};

/**
 * Pulls workflow runs, their jobs/steps and their mvn-lens artifacts into the
 * history, writing new report files under `<siteDir>/reports/…`.
 *
 * @param {object} p
 * @param {import('./github-api').GitHubApi} p.api
 * @param {string} p.repository "owner/repo"
 * @param {object} p.history   mutated in place
 * @param {string} p.siteDir   where NEW report files are written
 * @param {string[]} [p.existingSiteDirs] where previously collected reports may already live
 * @param {object} [p.options] see DEFAULTS
 * @returns stats, including `updatedRuns` (the run records upserted by this call)
 */
async function collect(p) {
  const api = p.api;
  const repo = p.repository;
  const history = p.history;
  const o = Object.assign({}, DEFAULTS, p.options || {});
  const siteDirs = [p.siteDir].concat(p.existingSiteDirs || []).filter(Boolean);
  const stats = { workflowsSelected: 0, runsSeen: 0, runsFetched: 0, runsSkipped: 0, forkRunsSkipped: 0, artifactsDownloaded: 0, reportsCollected: 0, errors: 0, updatedRuns: [] };

  // Repository facts (default branch, URL) — best effort.
  try {
    const info = await api.get(`/repos/${repo}`);
    history.defaultBranch = info.default_branch || history.defaultBranch;
    history.repositoryUrl = info.html_url || history.repositoryUrl;
  } catch (e) {
    debug(`GET /repos/${repo} failed: ${e.message}`);
  }
  history.repository = repo;

  // ---- Workflows -----------------------------------------------------------
  const allWorkflows = await api.paginate(`/repos/${repo}/actions/workflows`, {}, 'workflows');
  const selected = allWorkflows.filter(wf => {
    if (!wf || !wf.path || wf.path.startsWith('dynamic/')) return false;
    if (o.workflows.length && !o.workflows.some(sel => matchesWorkflow(wf, sel))) return false;
    if (o.excludeWorkflows.some(sel => matchesWorkflow(wf, sel))) return false;
    return true;
  });
  stats.workflowsSelected = selected.length;
  for (const wf of selected) {
    history.workflows[String(wf.id)] = { id: wf.id, name: wf.name, path: wf.path, state: wf.state };
  }
  log(`Workflows: ${selected.map(w => `${w.name} (${w.path})`).join(', ') || '(none)'}`);

  // ---- Run summaries -------------------------------------------------------
  const since = new Date(Date.now() - o.lookbackDays * 86400000).toISOString().slice(0, 10);
  const summaries = new Map();
  for (const wf of selected) {
    const query = { created: '>=' + since };
    if (o.branches.length === 1) query.branch = o.branches[0];
    const runs = await api.paginate(`/repos/${repo}/actions/workflows/${wf.id}/runs`, query, 'workflow_runs', { max: o.maxRuns });
    for (const r of runs) {
      if (o.branches.length > 1 && !o.branches.includes(r.head_branch)) continue;
      if (o.events.length && !o.events.includes(r.event)) continue;
      summaries.set(r.id, r);
    }
    debug(`${wf.name}: ${runs.length} run(s) since ${since}`);
  }
  for (const id of o.runIds) {
    if (summaries.has(id)) continue;
    try {
      const r = await api.get(`/repos/${repo}/actions/runs/${id}`);
      if (r && selected.some(wf => wf.id === r.workflow_id)) summaries.set(r.id, r);
      else debug(`run ${id} belongs to a workflow that is not selected; ignored`);
    } catch (e) {
      warning(`run ${id} could not be fetched: ${e.message}`);
    }
  }
  if (!o.includeForkRuns) {
    for (const [id, s] of Array.from(summaries)) {
      if (isForkRun(s, repo)) { summaries.delete(id); stats.forkRunsSkipped++; }
    }
    if (stats.forkRunsSkipped) log(`Skipped ${stats.forkRunsSkipped} run(s) from forked repositories (include-fork-runs is false)`);
  }
  stats.runsSeen = summaries.size;

  // ---- Details for new / changed runs -------------------------------------
  const todo = [];
  for (const s of summaries.values()) {
    const existing = findRun(history, s.id);
    if (needsRefresh(existing, s, o)) todo.push(s);
    else stats.runsSkipped++;
  }
  log(`Runs: ${summaries.size} seen, ${todo.length} to fetch, ${stats.runsSkipped} unchanged`);

  const artifactPrefix = o.artifactPrefix;
  await mapLimit(todo, o.concurrency, async (s) => {
    try {
      const jobs = await api.paginate(`/repos/${repo}/actions/runs/${s.id}/jobs`, { filter: 'latest' }, 'jobs');
      const record = buildRunRecord(s, jobs);
      const existing = findRun(history, s.id);
      // Entries collected for an earlier attempt belong to jobs that no longer exist.
      record.mvnLens = existing && existing.attempt === record.attempt ? existing.mvnLens.slice() : [];
      if (artifactPrefix) {
        const artifacts = await api.paginate(`/repos/${repo}/actions/runs/${s.id}/artifacts`, {}, 'artifacts');
        for (const a of artifacts) {
          if (!a || typeof a.name !== 'string' || !a.name.startsWith(artifactPrefix)) continue;
          let entry = null;
          try {
            entry = await collectArtifact({ api, repo, run: record, artifact: a, siteDir: p.siteDir, siteDirs, options: o, stats });
          } catch (e) {
            stats.errors++;
            warning(`artifact ${a.name} (${a.id}) of run ${s.id} skipped: ${e.message}`);
          }
          if (entry) {
            const i = record.mvnLens.findIndex(e => e.artifactId === entry.artifactId);
            if (i >= 0) record.mvnLens[i] = entry; else record.mvnLens.push(entry);
          }
        }
      }
      record.mvnLens.sort((a, b) => (a.jobId || 0) - (b.jobId || 0) || (a.stepNumber || 0) - (b.stepNumber || 0) || a.artifactName.localeCompare(b.artifactName));
      upsertRun(history, record);
      stats.updatedRuns.push(record);
      stats.runsFetched++;
      log(`  #${record.runNumber} ${record.workflowName} (${record.branch}) ${record.status}/${record.conclusion || '-'} ${fmtMs(record.durationMs)} · ${record.jobs.length} job(s) · ${record.mvnLens.length} mvn-lens artifact(s)`);
    } catch (e) {
      stats.errors++;
      warning(`run ${s.id} skipped: ${e.message}`);
    }
  });

  sortRuns(history);
  history.generatedAt = isoNow();
  return stats;
}

/** A run whose head repository is not the repository being charted (pull request from a fork). */
function isForkRun(summary, repo) {
  const head = summary && summary.head_repository;
  if (!head || !head.full_name) return false;
  return String(head.full_name).toLowerCase() !== String(repo).toLowerCase();
}

function needsRefresh(existing, summary, o) {
  if (!existing || o.forceRefresh) return true;
  if (o.runIds.includes(summary.id)) return true;
  if (existing.status !== 'completed' || summary.status !== 'completed') return true;
  if (existing.updatedAt !== summary.updated_at) return true;
  if (existing.attempt !== summary.run_attempt) return true;
  return false;
}

function matchesWorkflow(wf, selector) {
  const sel = String(selector).trim();
  if (!sel) return false;
  const low = sel.toLowerCase();
  const base = path.posix.basename(wf.path || '');
  return String(wf.id) === sel
    || (wf.name || '').toLowerCase() === low
    || (wf.path || '').toLowerCase() === low
    || base.toLowerCase() === low
    || ('.github/workflows/' + low) === (wf.path || '').toLowerCase();
}

function buildRunRecord(s, jobs) {
  const jobRecs = (jobs || []).map(j => {
    const started = parseIsoMs(j.started_at);
    const completed = parseIsoMs(j.completed_at);
    return {
      id: j.id,
      name: j.name,
      status: j.status,
      conclusion: j.conclusion || null,
      startedAt: j.started_at || null,
      completedAt: j.completed_at || null,
      durationMs: started && completed ? Math.max(0, completed - started) : null,
      runnerName: j.runner_name || null,
      runnerGroup: j.runner_group_name || null,
      labels: Array.isArray(j.labels) ? j.labels : [],
      htmlUrl: j.html_url || null,
      steps: (j.steps || []).map(st => {
        const a = parseIsoMs(st.started_at);
        const b = parseIsoMs(st.completed_at);
        return {
          number: st.number,
          name: st.name,
          status: st.status,
          conclusion: st.conclusion || null,
          startedAt: st.started_at || null,
          completedAt: st.completed_at || null,
          durationMs: a && b ? Math.max(0, b - a) : null,
        };
      }),
    };
  });
  const createdMs = parseIsoMs(s.created_at);
  // run_started_at is the start of the LATEST attempt (created_at stays that of attempt 1).
  const startedAt = s.run_started_at || s.created_at;
  const startedMs = parseIsoMs(startedAt);
  const jobEnds = jobRecs.map(j => parseIsoMs(j.completedAt)).filter(Boolean);
  const jobStarts = jobRecs.map(j => parseIsoMs(j.startedAt)).filter(Boolean);
  let completedAt = null;
  if (s.status === 'completed') {
    completedAt = jobEnds.length ? new Date(Math.max(...jobEnds)).toISOString() : (s.updated_at || null);
  }
  const completedMs = parseIsoMs(completedAt);
  const queueBaseMs = startedMs || createdMs;
  return {
    id: s.id,
    workflowId: s.workflow_id,
    workflowName: s.name || null,
    workflowPath: s.path || null,
    runNumber: s.run_number,
    attempt: s.run_attempt || 1,
    event: s.event || null,
    status: s.status || null,
    conclusion: s.conclusion || null,
    branch: s.head_branch || null,
    sha: s.head_sha || null,
    headRepository: s.head_repository && s.head_repository.full_name ? s.head_repository.full_name : null,
    title: s.display_title || (s.head_commit && s.head_commit.message ? String(s.head_commit.message).split('\n')[0] : null),
    actor: (s.triggering_actor && s.triggering_actor.login) || (s.actor && s.actor.login) || null,
    htmlUrl: s.html_url || null,
    createdAt: s.created_at || null,
    startedAt: startedAt || null,
    completedAt,
    updatedAt: s.updated_at || null,
    durationMs: startedMs && completedMs ? Math.max(0, completedMs - startedMs) : null,
    queueMs: queueBaseMs && jobStarts.length ? Math.max(0, Math.min(...jobStarts) - queueBaseMs) : null,
    jobs: jobRecs,
    mvnLens: [],
  };
}

/**
 * Downloads one mvn-lens artifact (unless it was collected before and its files
 * still exist), unpacks its HTML report(s) and meta.json, and attributes it to a
 * job/step of the run. Only files that carry a real mvn-lens model are published:
 * artifacts are user-controlled content and the reports land on the site origin.
 */
async function collectArtifact(p) {
  const { api, repo, run, artifact, siteDir, siteDirs, options, stats } = p;
  const previous = run.mvnLens.find(e => e.artifactId === artifact.id);
  if (previous && previous.reports.every(r => r.removed || (r.path && siteDirs.some(d => exists(path.join(d, r.path)))))) {
    return previous;
  }
  // Artifacts of an earlier attempt name jobs that no longer exist in the latest attempt.
  const named = /--j(\d+)/.exec(artifact.name || '');
  if (named && !run.jobs.some(j => j.id === Number(named[1]))) {
    debug(`artifact ${artifact.name} of run ${run.id} belongs to a job of an earlier attempt; skipped`);
    return null;
  }
  if (artifact.expired) {
    if (previous) return previous;
    debug(`artifact ${artifact.name} of run ${run.id} has expired; nothing to collect`);
    return null;
  }
  if (!options.downloadReports) return previous || null;

  let entries;
  try {
    const zip = await api.downloadArtifact(repo, artifact.id);
    stats.artifactsDownloaded++;
    entries = readZip(zip).filter(e => !e.isDirectory);
  } catch (e) {
    stats.errors++;
    warning(`artifact ${artifact.name} (${artifact.id}) of run ${run.id} could not be downloaded: ${e.message}`);
    return previous || null;
  }

  let meta = null;
  const metaEntry = entries.find(e => path.posix.basename(e.name) === 'meta.json');
  if (metaEntry) {
    try { meta = JSON.parse(metaEntry.data().toString('utf8')); } catch (e) { warning(`artifact ${artifact.name}: meta.json unreadable: ${e.message}`); }
    if (meta && typeof meta !== 'object') meta = null;
  }
  const metaAttempt = meta && Number(meta.runAttempt);
  if (metaAttempt && metaAttempt !== (run.attempt || 1)) {
    debug(`artifact ${artifact.name} of run ${run.id} was produced by attempt ${metaAttempt}; the run is at attempt ${run.attempt}; skipped`);
    return null;
  }
  const attribution = attribute(run, meta, artifact);
  if (attribution.how === 'stale-job') {
    debug(`artifact ${artifact.name} of run ${run.id} names job ${meta.jobId}, which is not part of the latest attempt; skipped`);
    return null;
  }

  const htmlEntries = entries.filter(e => /\.html?$/i.test(e.name));
  if (!htmlEntries.length) {
    warning(`artifact ${artifact.name} of run ${run.id} contains no HTML report`);
    return null;
  }
  // Primary report first (report.html or the file meta names), then the rest.
  const primaryName = (meta && Array.isArray(meta.reports) && meta.reports[0] && meta.reports[0].file) || 'report.html';
  htmlEntries.sort((a, b) => (path.posix.basename(a.name) === primaryName ? -1 : 0) - (path.posix.basename(b.name) === primaryName ? -1 : 0) || a.name.localeCompare(b.name));

  const dir = reportDirFor(run.id, artifact.name);
  const used = new Set();
  const reports = [];
  for (const e of htmlEntries) {
    let data;
    let model;
    try {
      data = e.data();
      model = extractModelFromHtml(data.toString('utf8'));
    } catch (err) {
      stats.errors++;
      warning(`artifact ${artifact.name}/${e.name} unreadable: ${err.message}`);
      continue;
    }
    if (!model) {
      warning(`artifact ${artifact.name}/${e.name} of run ${run.id} is not an mvn-lens report (no embedded model); not published`);
      continue;
    }
    let base = sanitizeName(path.posix.basename(e.name), 80);
    if (used.has(base)) base = `${path.parse(base).name}-${reports.length + 1}${path.parse(base).ext}`;
    used.add(base);
    ensureDir(path.join(siteDir, dir));
    fs.writeFileSync(path.join(siteDir, dir, base), data);
    const metaReport = meta && Array.isArray(meta.reports) ? meta.reports.find(r => r && r.file === path.posix.basename(e.name)) : null;
    let summary = metaReport && metaReport.summary && typeof metaReport.summary === 'object' ? metaReport.summary : null;
    let summarySource = summary ? 'meta' : null;
    if (!summary) {
      try { summary = summarizeModel(model); summarySource = 'html'; } catch (err) { debug(`artifact ${artifact.name}/${e.name}: model unusable: ${err.message}`); }
    }
    reports.push({ name: base, label: metaReport && metaReport.label ? String(metaReport.label) : null, path: `${dir}/${base}`, removed: false, summary, summarySource });
    stats.reportsCollected++;
  }
  if (!reports.length) return previous || null;

  return {
    artifactId: artifact.id,
    artifactName: artifact.name,
    label: meta && meta.label ? String(meta.label) : null,
    jobId: attribution.job ? attribution.job.id : null,
    jobName: attribution.job ? attribution.job.name : (meta && (meta.jobName || meta.jobKey) ? String(meta.jobName || meta.jobKey) : null),
    stepNumber: attribution.step ? attribution.step.number : null,
    stepName: attribution.step ? attribution.step.name : (meta && meta.stepName ? String(meta.stepName) : null),
    attribution: attribution.how,
    attempt: run.attempt || 1,
    collectedAt: isoNow(),
    source: meta ? 'meta' : 'artifact',
    sizeBytes: artifact.size_in_bytes || null,
    reports,
  };
}

/** Resolves the job and step an mvn-lens artifact belongs to, most reliable signal first. */
function attribute(run, meta, artifact) {
  const jobs = run.jobs || [];
  let job = null;
  let how = 'none';
  if (meta) {
    if (meta.jobId) {
      job = jobs.find(j => j.id === Number(meta.jobId)) || null;
      if (!job) return { job: null, step: null, how: 'stale-job' };
      how = 'jobId';
    }
    if (!job && meta.runnerName) {
      const cands = jobs.filter(j => j.runnerName === meta.runnerName);
      if (cands.length === 1) { job = cands[0]; how = 'runnerName'; }
    }
    if (!job && meta.jobName) {
      const cands = jobs.filter(j => j.name === meta.jobName);
      if (cands.length === 1) { job = cands[0]; how = 'jobName'; }
    }
    if (!job && meta.jobKey) {
      const cands = jobs.filter(j => j.name === meta.jobKey || j.name.startsWith(meta.jobKey + ' ('));
      if (cands.length === 1) { job = cands[0]; how = 'jobKey'; }
    }
  }
  if (!job) {
    // Artifact name convention: mvn-lens--j<jobId>--s<step>[--…]
    const m = /--j(\d+)(?:--s(\d+))?/.exec(artifact.name || '');
    if (m) {
      job = jobs.find(j => j.id === Number(m[1])) || null;
      if (job) {
        how = 'artifactName';
        if (m[2]) {
          const st = job.steps.find(s => s.number === Number(m[2]));
          if (st) return { job, step: st, how };
        }
      }
    }
  }
  if (!job) return { job: null, step: null, how };
  let step = null;
  if (meta && meta.stepNumber) step = job.steps.find(s => s.number === Number(meta.stepNumber)) || null;
  if (!step && meta && meta.stepName) {
    const cands = job.steps.filter(s => s.name === meta.stepName);
    step = cands.length ? cands[cands.length - 1] : null;
  }
  return { job, step, how: step ? how : how + '/job-only' };
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return '(running)';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

module.exports = { collect, buildRunRecord, attribute, matchesWorkflow, needsRefresh, isForkRun, DEFAULTS };
