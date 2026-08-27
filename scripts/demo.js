#!/usr/bin/env node
/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Generates a synthetic-but-realistic dashboard so the site can be previewed
 * without a GitHub repository: two workflows over ~70 days, matrix jobs with
 * steps, mvn-lens reports attached to the Maven step (real report HTML when an
 * mvn-lens checkout with built ITs is available, otherwise a small stand-in).
 *
 *   node scripts/demo.js [outDir]        (default .tmp/demo-site)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { emptyHistory, reportDirFor } = require('../src/history');
const { generateSite } = require('../src/site');
const { summarizeModel } = require('../src/mvnlens');
const { ensureDir, rmrf } = require('../src/util');

const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', '.tmp', 'demo-site'));
rmrf(outDir);
ensureDir(outDir);

// Deterministic pseudo-random so the demo is reproducible.
let seed = 42;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function jitter(base, pct) { return Math.round(base * (1 + (rnd() * 2 - 1) * pct)); }
function iso(ms) { return new Date(ms).toISOString(); }

const model = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'model-small.json'), 'utf8'));
const realReports = findRealReports();
const MAX_REAL_COPIES = Number(process.env.DEMO_MAX_REPORTS || 24);
let copiedReports = 0;

const history = emptyHistory('acme/widgets');
history.repositoryUrl = 'https://github.com/acme/widgets';
history.defaultBranch = 'main';
history.workflows = {
  '1': { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
  '2': { id: 2, name: 'Nightly perf', path: '.github/workflows/nightly.yml', state: 'active' },
};

const DAY = 86400000;
const now = Date.now();
let runId = 5000000000;
let jobId = 90000000000;
let artifactId = 7000000000;
let ciNumber = 300;
let nightlyNumber = 60;
const branches = ['main', 'main', 'main', 'feature/faster-tests', 'renovate/junit', 'main'];
const actors = ['octocat', 'hubot', 'monalisa'];
const titles = ['Bump surefire to 3.5.2', 'Parallelise the reactor with -T4', 'Fix flaky LibATest', 'Cache the Maven repository', 'Merge pull request #42 from feature/faster-tests', 'Update dependencies', 'Refactor GreeterTest', 'Enable mvnd on CI'];

// A slow regression around day 40, fixed on day 52, to make the trend interesting.
function mavenBaseMs(dayIdx) { return dayIdx > 40 && dayIdx < 52 ? 165000 : 105000 - Math.min(20000, dayIdx * 300); }

for (let day = 70; day >= 0; day--) {
  const runsToday = day % 7 >= 5 ? (rnd() < 0.4 ? 1 : 0) : 1 + Math.floor(rnd() * 3);
  for (let k = 0; k < runsToday; k++) {
    const created = now - day * DAY - Math.floor(rnd() * 12 * 3600000) - 3600000;
    const branch = branches[Math.floor(rnd() * branches.length)];
    const failing = rnd() < 0.12;
    const running = day === 0 && k === runsToday - 1;
    history.runs.push(ciRun({ created, branch, failing, running, dayIdx: 70 - day }));
  }
  if (day % 1 === 0 && rnd() < 0.7) history.runs.push(nightlyRun({ created: now - day * DAY - 2 * 3600000, dayIdx: 70 - day }));
}
history.runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
history.generatedAt = iso(now);
const out = generateSite({ history, siteDir: outDir, title: process.env.DEMO_TITLE || 'Build dashboard · acme/widgets (demo)', actionVersion: 'demo' });
console.log(`Demo site: ${out.indexFile} (${(out.bytes / 1024).toFixed(0)} KiB, ${history.runs.length} runs, ${countReports()} mvn-lens reports, ${realReports.length} real report files)`);

// ---------------------------------------------------------------------------

function ciRun(p) {
  const id = runId++;
  const number = ciNumber++;
  const started = p.created + jitter(15000, 0.8);
  const matrix = [
    { name: 'JDK 17 · ubuntu-latest', labels: ['ubuntu-latest'], maven: mavenBaseMs(p.dayIdx), lens: false },
    { name: 'JDK 21 · ubuntu-latest', labels: ['ubuntu-latest'], maven: mavenBaseMs(p.dayIdx) * 0.92, lens: true, its: true },
    { name: 'JDK 21 · windows-latest', labels: ['windows-latest'], maven: mavenBaseMs(p.dayIdx) * 1.6, lens: true },
  ];
  const jobs = [];
  const mvnLens = [];
  let runEnd = started;
  matrix.forEach((m, i) => {
    const jid = jobId++;
    const jobStart = started + jitter(3000, 0.5) + i * 800;
    let t = jobStart;
    const steps = [];
    function step(number, name, ms, conclusion) {
      const s = { number, name, status: 'completed', conclusion: conclusion || 'success', startedAt: iso(t), completedAt: iso(t + ms), durationMs: ms };
      steps.push(s); t += ms; return s;
    }
    step(1, 'Set up job', jitter(2500, 0.4));
    step(2, 'Run actions/checkout@v4', jitter(m.labels[0] === 'windows-latest' ? 9000 : 2000, 0.4));
    step(3, 'Set up JDK', jitter(4000, 0.5));
    const mavenMs = jitter(m.maven, 0.12);
    const failedHere = p.failing && i === (p.failing ? Math.floor(rnd() * 3) : -1);
    const build = step(4, 'Build with Maven', failedHere ? Math.round(mavenMs * 0.6) : mavenMs, failedHere ? 'failure' : 'success');
    if (m.lens) {
      const mavenStart = Date.parse(build.startedAt) + jitter(1500, 0.3);
      const mavenTotal = build.durationMs - jitter(2500, 0.3);
      const summary = mavenSummary({ startedAt: mavenStart, totalMs: mavenTotal, status: failedHere ? 'FAILED' : 'OK', threads: p.dayIdx > 30 ? 4 : 1, dayIdx: p.dayIdx });
      mvnLens.push(entry({ runId: id, jobId: jid, jobName: m.name, step: build, summary, label: null, recent: p.dayIdx >= 64 }));
      step(5, 'Attach mvn-lens report', jitter(1800, 0.3), failedHere ? 'success' : 'success');
    }
    if (m.its) {
      const its = step(6, 'Integration tests', failedHere ? 0 : jitter(140000, 0.15), failedHere ? 'skipped' : 'success');
      if (!failedHere) {
        const summary = mavenSummary({ startedAt: Date.parse(its.startedAt) + 800, totalMs: its.durationMs - 1500, status: 'OK', threads: 1, dayIdx: p.dayIdx, goals: ['-Prun-its', 'install'] });
        mvnLens.push(entry({ runId: id, jobId: jid, jobName: m.name, step: its, summary, label: 'integration tests', recent: p.dayIdx >= 64 }));
        step(7, 'Attach mvn-lens report (ITs)', jitter(1800, 0.3));
      }
    }
    step(12, 'Post Set up JDK', jitter(1200, 0.4));
    step(13, 'Post Run actions/checkout@v4', 400);
    step(14, 'Complete job', 300);
    const jobEnd = t;
    runEnd = Math.max(runEnd, jobEnd);
    jobs.push({ id: jid, name: m.name, status: 'completed', conclusion: failedHere ? 'failure' : 'success', startedAt: iso(jobStart), completedAt: iso(jobEnd), durationMs: jobEnd - jobStart, runnerName: 'GitHub Actions ' + (1000 + i), runnerGroup: 'GitHub Actions', labels: m.labels, htmlUrl: `https://github.com/acme/widgets/actions/runs/${id}/job/${jid}`, steps });
  });
  let status = 'completed';
  let conclusion = p.failing ? 'failure' : 'success';
  if (p.running) {
    status = 'in_progress'; conclusion = null;
    jobs[2].status = 'in_progress'; jobs[2].conclusion = null; jobs[2].completedAt = null; jobs[2].durationMs = null;
    jobs[2].steps = jobs[2].steps.slice(0, 4); jobs[2].steps[3].status = 'in_progress'; jobs[2].steps[3].conclusion = null; jobs[2].steps[3].completedAt = null; jobs[2].steps[3].durationMs = null;
    mvnLens.splice(mvnLens.findIndex(e => e.jobId === jobs[2].id), 1);
  }
  return {
    id, workflowId: 1, workflowName: 'CI', workflowPath: '.github/workflows/ci.yml', runNumber: number, attempt: rnd() < 0.05 ? 2 : 1, event: p.branch === 'main' ? 'push' : 'pull_request',
    status, conclusion, branch: p.branch, sha: sha(), title: titles[Math.floor(rnd() * titles.length)], actor: actors[Math.floor(rnd() * actors.length)],
    htmlUrl: `https://github.com/acme/widgets/actions/runs/${id}`, createdAt: iso(p.created), startedAt: iso(started), completedAt: p.running ? null : iso(runEnd), updatedAt: iso(runEnd + 3000),
    durationMs: p.running ? null : runEnd - started, queueMs: started - p.created, jobs, mvnLens,
  };
}

function nightlyRun(p) {
  const id = runId++;
  const number = nightlyNumber++;
  const started = p.created + jitter(20000, 0.5);
  const jobs = [];
  const mvnLens = [];
  let runEnd = started;
  const scenarios = [['default · T1', 1, 1.0], ['default · T4', 4, 0.55], ['smart · T4', 4, 0.48], ['mvnd', 4, 0.42]];
  scenarios.forEach((sc, i) => {
    const jid = jobId++;
    const jobStart = started + i * 5000;
    let t = jobStart;
    const steps = [];
    function step(number, name, ms, conclusion) { const s = { number, name, status: 'completed', conclusion: conclusion || 'success', startedAt: iso(t), completedAt: iso(t + ms), durationMs: ms }; steps.push(s); t += ms; return s; }
    step(1, 'Set up job', jitter(2500, 0.4));
    step(2, 'Run actions/checkout@v4', jitter(2000, 0.4));
    step(3, 'Warm the local repository (untimed)', jitter(25000, 0.2));
    const mavenMs = jitter(380000 * sc[2], 0.08);
    const build = step(4, 'Run profiled build', mavenMs);
    const summary = mavenSummary({ startedAt: Date.parse(build.startedAt) + 1200, totalMs: mavenMs - 2500, status: 'OK', threads: sc[1], dayIdx: p.dayIdx, mvnd: sc[0] === 'mvnd' });
    mvnLens.push(entry({ runId: id, jobId: jid, jobName: sc[0], step: build, summary, label: null, recent: p.dayIdx >= 66 }));
    step(5, 'Attach mvn-lens report', jitter(1800, 0.3));
    step(9, 'Complete job', 300);
    runEnd = Math.max(runEnd, t);
    jobs.push({ id: jid, name: sc[0], status: 'completed', conclusion: 'success', startedAt: iso(jobStart), completedAt: iso(t), durationMs: t - jobStart, runnerName: 'GitHub Actions ' + (2000 + i), runnerGroup: 'GitHub Actions', labels: ['ubuntu-latest'], htmlUrl: `https://github.com/acme/widgets/actions/runs/${id}/job/${jid}`, steps });
  });
  return {
    id, workflowId: 2, workflowName: 'Nightly perf', workflowPath: '.github/workflows/nightly.yml', runNumber: number, attempt: 1, event: 'schedule', status: 'completed', conclusion: 'success',
    branch: 'main', sha: sha(), title: 'Nightly perf', actor: 'github-actions', htmlUrl: `https://github.com/acme/widgets/actions/runs/${id}`,
    createdAt: iso(p.created), startedAt: iso(started), completedAt: iso(runEnd), updatedAt: iso(runEnd + 3000), durationMs: runEnd - started, queueMs: started - p.created, jobs, mvnLens,
  };
}

function mavenSummary(p) {
  const m = JSON.parse(JSON.stringify(model));
  m.session.startedAt = p.startedAt;
  m.session.endedAt = p.startedAt + p.totalMs;
  m.session.totalMs = p.totalMs;
  m.session.wallMs = Math.round(p.totalMs * 0.96);
  m.session.cpuMs = Math.round(p.totalMs * (p.threads > 1 ? 1.9 : 0.85));
  m.session.gcMs = jitter(p.totalMs * 0.03, 0.4);
  m.session.status = p.status;
  m.session.threads = p.threads;
  m.session.builderId = p.threads > 1 ? 'multithreaded' : 'singlethreaded';
  m.session.goals = p.goals || ['clean', 'verify'];
  const jitScale = p.totalMs / 8000;
  m.jit = m.jit.map(e => Object.assign({}, e, { durationMs: Math.round(e.durationMs * jitScale * 0.6) }));
  m.repoTransferSummary.millisDownloadedThisBuild = p.dayIdx % 9 === 0 ? jitter(45000, 0.3) : jitter(1200, 0.5);
  m.repoTransferSummary.bytesDownloadedThisBuild = p.dayIdx % 9 === 0 ? jitter(90e6, 0.3) : jitter(300000, 0.5);
  m.repoTransferSummary.artifactDownloadsCount = p.dayIdx % 9 === 0 ? 312 : 3;
  m.environment.mvnd = !!p.mvnd;
  m.environment.githubActions = true;
  m.modules = m.modules.map(mod => Object.assign({}, mod, { wallMs: jitter(mod.wallMs * jitScale, 0.2) }));
  return summarizeModel(m);
}

function entry(p) {
  const aid = artifactId++;
  const name = `mvn-lens--j${p.jobId}--s${p.step.number}` + (p.label ? '--' + p.label.replace(/[^A-Za-z0-9._-]+/g, '-') : '');
  const dir = reportDirFor(p.runId, name);
  // Real report files are 1–2 MB each: keep them for the most recent runs only, like keep-reports would.
  const keep = realReports.length && copiedReports < MAX_REAL_COPIES && p.recent;
  let file = null;
  if (keep) {
    copiedReports++;
    ensureDir(path.join(outDir, dir));
    fs.copyFileSync(realReports[Math.floor(rnd() * realReports.length)], path.join(outDir, dir, 'report.html'));
    file = `${dir}/report.html`;
  }
  return {
    artifactId: aid, artifactName: name, label: p.label, jobId: p.jobId, jobName: p.jobName, stepNumber: p.step.number, stepName: p.step.name, attribution: 'jobId',
    collectedAt: iso(now), source: 'meta', sizeBytes: 1500000,
    reports: [{ name: 'report.html', label: null, path: file, removed: !file, summary: p.summary, summarySource: 'meta' }],
  };
}

function sha() { let s = ''; for (let i = 0; i < 40; i++) s += '0123456789abcdef'[Math.floor(rnd() * 16)]; return s; }
function countReports() { let n = 0; history.runs.forEach(r => r.mvnLens.forEach(e => { n += e.reports.length; })); return n; }

/** Real mvn-lens reports (from a sibling mvn-lens checkout with built ITs), capped to keep the demo small. */
function findRealReports() {
  const candidates = [
    path.join(__dirname, '..', '..', 'mvn-lens', 'mvn-lens-it', 'target', 'it'),
    process.env.MVN_LENS_IT_DIR || '',
  ].filter(Boolean);
  const found = [];
  for (const root of candidates) {
    if (!fs.existsSync(root)) continue;
    for (const it of fs.readdirSync(root)) {
      const f = path.join(root, it, 'target', 'mvnlens', 'report.html');
      if (fs.existsSync(f)) found.push(f);
    }
  }
  return found.slice(0, 6);
}
