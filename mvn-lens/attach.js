#!/usr/bin/env node
/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Runs inside the build job, right after the Maven step: locates the mvn-lens
 * report(s), works out which job/step of the current run it is attached to,
 * extracts the Maven session summary and stages everything (report.html…,
 * meta.json) in a directory that action.yml then uploads as an artifact named
 * "mvn-lens--j<jobId>--s<step>…". The main action attributes the artifact back
 * to that exact step through meta.json (falling back to the artifact name).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('../src/util');
const { GitHubApi } = require('../src/github-api');
const { readReportSummary } = require('../src/mvnlens');

const { log, warning, getInput, getBooleanInput, parseList, setOutput, appendSummary, ensureDir, sanitizeName, sleep } = util;

async function main() {
  const reportPatterns = parseList(getInput('report', { default: 'target/mvnlens/report.html' }));
  const stepNameInput = getInput('step-name');
  const jobNameInput = getInput('job-name');
  const label = getInput('label');
  const token = getInput('github-token', { default: process.env.GITHUB_TOKEN || '' });
  const includeModel = getBooleanInput('include-model', false);
  const ifNoFiles = (getInput('if-no-files-found', { default: 'warn' }) || 'warn').toLowerCase();
  const prefix = getInput('artifact-prefix', { default: 'mvn-lens--' });

  // ---- 1. Report files -------------------------------------------------------
  const files = [];
  for (const pat of reportPatterns) for (const f of util.glob(pat)) if (!files.includes(f)) files.push(f);
  if (!files.length) {
    const msg = `No mvn-lens report found for: ${reportPatterns.join(', ')} (is the mvn-lens extension declared in .mvn/extensions.xml?)`;
    if (ifNoFiles === 'error') throw new Error(msg);
    if (ifNoFiles === 'warn') warning(msg); else log(msg);
    setOutput('found', 'false');
    setOutput('artifact-name', '');
    setOutput('path', '');
    return;
  }
  // When the primary report was written tells which step produced it.
  let reportWrittenAt = null;
  try { reportWrittenAt = fs.statSync(files[0]).mtimeMs; } catch (e) { /* ignore */ }

  // ---- 2. Which job / step are we? ----------------------------------------
  const ctx = {
    repository: process.env.GITHUB_REPOSITORY || '',
    runId: Number(process.env.GITHUB_RUN_ID) || null,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) || 1,
    jobKey: process.env.GITHUB_JOB || null,
    jobName: jobNameInput || null,
    runnerName: process.env.RUNNER_NAME || null,
    workflowRef: process.env.GITHUB_WORKFLOW_REF || null,
    reportWrittenAt,
  };
  const located = await locateJobAndStep(ctx, token, stepNameInput);

  // ---- 3. Summaries ----------------------------------------------------------
  const staging = ensureDir(path.join(process.env.RUNNER_TEMP || os.tmpdir(), `mvn-lens-attach-${Date.now().toString(36)}`));
  const reports = [];
  files.forEach((file, i) => {
    const base = i === 0 ? 'report.html' : `report-${i + 1}.html`;
    fs.copyFileSync(file, path.join(staging, base));
    const { summary, source, error } = readReportSummary(file);
    if (error) warning(`${file}: ${error}`);
    reports.push({ file: base, originalPath: util.toPosix(path.relative(process.cwd(), file)), label: files.length > 1 ? path.basename(path.dirname(path.dirname(file))) : null, summary, summarySource: source });
    if (includeModel) {
      const sidecar = path.join(path.dirname(file), 'model.json');
      if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, path.join(staging, i === 0 ? 'model.json' : `model-${i + 1}.json`));
    }
  });

  // ---- 4. meta.json ----------------------------------------------------------
  const meta = {
    schemaVersion: 1,
    repository: ctx.repository,
    runId: ctx.runId,
    runAttempt: ctx.runAttempt,
    workflowRef: ctx.workflowRef,
    jobKey: ctx.jobKey,
    jobId: located.job ? located.job.id : null,
    jobName: located.job ? located.job.name : (ctx.jobName || null),
    runnerName: ctx.runnerName,
    stepNumber: located.step ? located.step.number : null,
    stepName: located.step ? located.step.name : (stepNameInput || null),
    stepResolution: located.how,
    label: label || null,
    collectedAt: new Date().toISOString(),
    reports,
  };
  fs.writeFileSync(path.join(staging, 'meta.json'), JSON.stringify(meta, null, 2));

  // ---- 5. Artifact name (unique per run, safe characters only) --------------
  const parts = [prefix.replace(/-+$/, '')];
  if (located.job) parts.push(`j${located.job.id}`);
  else parts.push(sanitizeName(ctx.jobKey || 'job', 40), Math.random().toString(36).slice(2, 8));
  if (located.step) parts.push(`s${located.step.number}`);
  if (label) parts.push(sanitizeName(label, 40));
  const artifactName = parts.join('--').slice(0, 200);

  setOutput('found', 'true');
  setOutput('artifact-name', artifactName);
  setOutput('path', staging);
  setOutput('job-id', located.job ? located.job.id : '');
  setOutput('step-name', meta.stepName || '');
  const primary = reports[0].summary;
  setOutput('maven-total-ms', primary ? primary.totalMs : '');

  const where = located.job ? `${located.job.name}${located.step ? ' › ' + located.step.name : ''}` : (ctx.jobName || ctx.jobKey || 'unknown job');
  log(`mvn-lens: ${files.length} report(s) staged as artifact "${artifactName}" for ${where} (${located.how})`);
  if (primary) log(`mvn-lens: Maven ${primary.goals.join(' ')} — total ${fmt(primary.totalMs)}, wall ${fmt(primary.wallMs)}, cpu ${fmt(primary.cpuMs)}, ${primary.moduleCount} module(s), status ${primary.status}`);
  await appendSummary([
    `#### mvn-lens report${files.length > 1 ? 's' : ''} — ${escapeMd(where)}`,
    primary ? `Maven \`${primary.goals.join(' ')}\` · **${fmt(primary.totalMs)}** total · wall ${fmt(primary.wallMs)} · CPU ${fmt(primary.cpuMs)} · GC ${fmt(primary.gcMs)} · ${primary.moduleCount} module(s) · ${primary.status}` : '(no embedded model)',
    `Uploaded as artifact \`${artifactName}\` for the build dashboard.`,
  ].join('\n\n'));
}

/**
 * Finds the current job and the Maven step. Never throws — the artifact is
 * still useful without attribution.
 *
 * Job: the explicit `job-name`, else the single in-progress job on this runner
 * (disambiguated by step timing when hosted runner names collide), else the job
 * whose name is the job key / a matrix expansion of it.
 *
 * Step: the explicit `step-name`, else the step that was running when the
 * report was written. The Jobs API lags the runner by a few seconds, so the
 * Maven step may still show as in_progress: a step whose window contains the
 * report's mtime wins over "the last completed step"; when the snapshot is too
 * old to decide, it is re-fetched a couple of times.
 */
async function locateJobAndStep(ctx, token, stepName) {
  const none = { job: null, step: null, how: 'no-api' };
  if (!ctx.repository || !ctx.runId) return none;
  if (!token) { warning('mvn-lens: no github-token; the report will be attached to the job by name only'); return none; }
  const api = new GitHubApi({ token, maxAttempts: 2 });
  const fetchJobs = () => api.paginate(`/repos/${ctx.repository}/actions/runs/${ctx.runId}/attempts/${ctx.runAttempt}/jobs`, {}, 'jobs', { timeoutMs: 20000 });

  let jobs;
  try {
    jobs = await fetchJobs();
  } catch (e) {
    warning(`mvn-lens: could not list this run's jobs (${e.message}); does the job grant "actions: read"? Attaching by job name only.`);
    return none;
  }

  let job = null;
  let how = '';
  for (let round = 0; round < 3 && !job; round++) {
    if (round) { await sleep(2000 * round); try { jobs = await fetchJobs(); } catch (e) { break; } }
    const running = jobs.filter(j => j.status === 'in_progress');
    if (ctx.jobName) {
      const cands = running.filter(j => j.name === ctx.jobName);
      if (cands.length === 1) { job = cands[0]; how = 'job-name'; break; }
      if (cands.length > 1) warning(`mvn-lens: ${cands.length} in-progress jobs are named "${ctx.jobName}"`);
    }
    if (ctx.runnerName) {
      let cands = running.filter(j => j.runner_name === ctx.runnerName);
      if (cands.length > 1 && ctx.reportWrittenAt) {
        // Hosted runner names are reused: keep the jobs that were already running when the report was written.
        cands = cands.filter(j => j.started_at && Date.parse(j.started_at) <= ctx.reportWrittenAt + 1000);
      }
      if (cands.length === 1) { job = cands[0]; how = 'runner'; break; }
    }
    if (ctx.jobKey) {
      const cands = running.filter(j => j.name === ctx.jobKey || j.name.startsWith(ctx.jobKey + ' ('));
      if (cands.length === 1) { job = cands[0]; how = 'job-key'; break; }
    }
    if (!running.length) continue;   // the API has not caught up with this job yet
    break;
  }
  if (!job) {
    const running = jobs.filter(j => j.status === 'in_progress').map(j => `"${j.name}"`).join(', ') || '(none)';
    warning(`mvn-lens: could not identify this job among the in-progress jobs of run ${ctx.runId} (${running}); pass job-name: <the job's display name> (matrix expressions are fine) so the report is attributed to the right job and step`);
    return { job: null, step: null, how: 'job-not-found' };
  }

  let steps = (job.steps || []).slice().sort((a, b) => a.number - b.number);
  let step = null;
  if (stepName) {
    const cands = steps.filter(s => s.name === stepName);
    step = cands.length ? cands[cands.length - 1] : null;
    if (!step) warning(`mvn-lens: no step named "${stepName}" in job "${job.name}"; falling back to the step that produced the report`);
    else how += '/step-name';
  }
  for (let round = 0; round < 3 && !step; round++) {
    if (round) {
      await sleep(2000 * round);
      try { jobs = await fetchJobs(); } catch (e) { break; }
      const fresh = jobs.find(j => j.id === job.id);
      if (fresh) steps = (fresh.steps || []).slice().sort((a, b) => a.number - b.number);
    }
    const at = ctx.reportWrittenAt;
    const completed = steps.filter(s => s.status === 'completed' && s.conclusion !== 'skipped');
    if (at) {
      // The step whose window contains the report's mtime produced it (lag-safe).
      const containing = steps.filter(s => s.started_at && Date.parse(s.started_at) <= at + 1000 && (!s.completed_at || Date.parse(s.completed_at) >= at - 1000) && s.conclusion !== 'skipped');
      if (containing.length) { step = containing[containing.length - 1]; how += '/report-time'; break; }
      const before = completed.filter(s => s.completed_at && Date.parse(s.completed_at) <= at + 1000);
      const snapshotStale = !steps.some(s => s.status === 'in_progress') && before.length && Date.parse(before[before.length - 1].completed_at) < at - 1000;
      if (snapshotStale && round < 2) continue;   // the API is behind: retry
      if (before.length) { step = before[before.length - 1]; how += '/previous-step'; break; }
    }
    const current = steps.find(s => s.status === 'in_progress');
    const before = completed.filter(s => !current || s.number < current.number);
    if (before.length) { step = before[before.length - 1]; how += '/previous-step'; break; }
    if (round === 2) how += '/no-step';
  }
  return { job: { id: job.id, name: job.name }, step: step ? { number: step.number, name: step.name } : null, how };
}

function fmt(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const total = Math.round(s);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}
function escapeMd(s) { return String(s).replace(/[*_`|]/g, '\\$&'); }

if (require.main === module) {
  main().catch(e => {
    util.error(e && e.stack ? e.stack : String(e));
    process.exitCode = 1;
  });
}

module.exports = { main, locateJobAndStep };
