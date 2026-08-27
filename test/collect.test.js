'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { GitHubApi } = require('../src/github-api');
const { collect, attribute, matchesWorkflow, buildRunRecord } = require('../src/collect');
const { emptyHistory, prune } = require('../src/history');
const { fakeGitHub, fakeRun, fakeArtifact, tmpDir } = require('./helpers');

const T0 = Date.parse('2026-06-01T10:00:00Z');
const WF = [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }, { id: 2, name: 'Nightly', path: '.github/workflows/nightly.yml', state: 'active' }, { id: 3, name: 'pages-build-deployment', path: 'dynamic/pages/pages-build-deployment', state: 'active' }];

function scenario() {
  const runs = [];
  for (let i = 1; i <= 5; i++) {
    const base = T0 + i * 3600000;
    runs.push(fakeRun({
      id: 100 + i, runNumber: i, baseMs: base, mavenSec: 60 + i * 5, conclusion: i === 3 ? 'failure' : 'success', branch: i === 4 ? 'feature' : 'main',
      artifacts: [fakeArtifact({ artifactId: 500 + i, runId: 100 + i, jobId: (100 + i) * 10, jobName: 'build', stepNumber: 3, stepName: 'Build with Maven', totalMs: (60 + i * 5) * 1000, startedAt: base + 7000 })],
    }));
  }
  // A nightly run without mvn-lens, and one still running.
  runs.push(fakeRun({ id: 200, runNumber: 1, workflowId: 2, workflowName: 'Nightly', workflowPath: '.github/workflows/nightly.yml', baseMs: T0 + 10 * 3600000, event: 'schedule' }));
  runs.push(fakeRun({ id: 300, runNumber: 6, baseMs: T0 + 11 * 3600000, status: 'in_progress' }));
  return { repository: 'acme/widgets', workflows: WF, runs };
}

test('collect builds run records, attributes mvn-lens artifacts to steps and writes the reports', async () => {
  const sc = scenario();
  const gh = fakeGitHub(sc);
  const api = new GitHubApi({ token: 't', fetch: gh.fetch });
  const history = emptyHistory('acme/widgets');
  const siteDir = tmpDir('site');
  const stats = await collect({ api, repository: 'acme/widgets', history, siteDir, options: { lookbackDays: 36500 } });

  assert.equal(stats.workflowsSelected, 2, 'dynamic/ workflows are ignored');
  assert.equal(stats.runsFetched, 7);
  assert.equal(stats.reportsCollected, 5);
  assert.equal(history.defaultBranch, 'main');
  assert.equal(history.runs.length, 7);
  assert.equal(history.runs[0].id, 300, 'newest first');

  const r3 = history.runs.find(r => r.id === 103);
  assert.equal(r3.conclusion, 'failure');
  assert.equal(r3.jobs.length, 1);
  assert.equal(r3.jobs[0].steps.length, 5);
  assert.equal(r3.jobs[0].steps[2].durationMs, 75000);
  assert.equal(r3.durationMs, Date.parse(r3.jobs[0].completedAt) - Date.parse(r3.startedAt));
  assert.equal(r3.mvnLens.length, 1);
  const e = r3.mvnLens[0];
  assert.equal(e.jobId, 1030);
  assert.equal(e.stepNumber, 3);
  assert.equal(e.stepName, 'Build with Maven');
  assert.equal(e.attribution, 'jobId');
  assert.equal(e.reports.length, 1);
  assert.equal(e.reports[0].path, 'reports/103/mvn-lens--j1030--s3/report.html');
  assert.equal(e.reports[0].summary.totalMs, 75000);
  assert.equal(e.reports[0].summarySource, 'meta');
  assert.ok(fs.existsSync(path.join(siteDir, e.reports[0].path)));

  const running = history.runs.find(r => r.id === 300);
  assert.equal(running.status, 'in_progress');
  assert.equal(running.durationMs, null);

  // The blob download must not carry the API Authorization header.
  const blob = gh.calls.filter(c => c.url.startsWith('https://blob.example.test/'));
  assert.equal(blob.length, 5);
  assert.ok(blob.every(c => !c.headers || !c.headers.Authorization));
});

test('collect skips unchanged completed runs and re-fetches in-progress ones', async () => {
  const sc = scenario();
  const gh = fakeGitHub(sc);
  const api = new GitHubApi({ token: 't', fetch: gh.fetch });
  const history = emptyHistory('acme/widgets');
  const siteDir = tmpDir('site');
  await collect({ api, repository: 'acme/widgets', history, siteDir, options: { lookbackDays: 36500 } });
  const before = gh.calls.length;

  // Second pass: the running run completes; everything else is unchanged.
  const r300 = sc.runs.find(r => r.id === 300);
  r300.status = 'completed'; r300.conclusion = 'success'; r300.jobs[0].status = 'completed'; r300.jobs[0].conclusion = 'success'; r300.jobs[0].completed_at = new Date(T0 + 11 * 3600000 + 90000).toISOString();
  const stats = await collect({ api, repository: 'acme/widgets', history, siteDir, options: { lookbackDays: 36500 } });
  assert.equal(stats.runsFetched, 1);
  assert.equal(stats.runsSkipped, 6);
  assert.equal(stats.artifactsDownloaded, 0, 'reports already on disk are not downloaded again');
  assert.equal(history.runs.find(r => r.id === 300).status, 'completed');
  const jobsCalls = gh.calls.slice(before).filter(c => /\/jobs/.test(c.url));
  assert.equal(jobsCalls.length, 1);

  // A run named in runIds is refreshed even when unchanged; force-refresh refreshes all.
  const s2 = await collect({ api, repository: 'acme/widgets', history, siteDir, options: { lookbackDays: 36500, runIds: [101] } });
  assert.equal(s2.runsFetched, 1);
  const s3 = await collect({ api, repository: 'acme/widgets', history, siteDir, options: { lookbackDays: 36500, forceRefresh: true } });
  assert.equal(s3.runsFetched, 7);
});

test('collect honours workflow/branch/event filters and the max-runs cap', async () => {
  const sc = scenario();
  const gh = fakeGitHub(sc);
  const api = new GitHubApi({ token: 't', fetch: gh.fetch });
  let history = emptyHistory('acme/widgets');
  await collect({ api, repository: 'acme/widgets', history, siteDir: tmpDir('site'), options: { lookbackDays: 36500, workflows: ['ci.yml'], branches: ['main'], maxRuns: 3, downloadReports: false } });
  assert.ok(history.runs.every(r => r.workflowId === 1 && r.branch === 'main'));
  assert.ok(history.runs.length <= 3);

  history = emptyHistory('acme/widgets');
  await collect({ api, repository: 'acme/widgets', history, siteDir: tmpDir('site'), options: { lookbackDays: 36500, excludeWorkflows: ['CI'], events: ['schedule'], downloadReports: false } });
  assert.deepEqual(history.runs.map(r => r.id), [200]);
});

test('collect with a report whose files were pruned re-downloads only when still available', async () => {
  const sc = scenario();
  const gh = fakeGitHub(sc);
  const api = new GitHubApi({ token: 't', fetch: gh.fetch });
  const history = emptyHistory('acme/widgets');
  const siteDir = tmpDir('site');
  await collect({ api, repository: 'acme/widgets', history, siteDir, options: { lookbackDays: 36500 } });
  const { removedReportPaths } = prune(history, { maxRunsPerWorkflow: 100, keepReports: 2 });
  assert.equal(removedReportPaths.length, 4, 'CI runs 300 (running, no report) and 105 keep theirs; 104..101 lose their files');
  for (const p of removedReportPaths) fs.rmSync(path.join(siteDir, p));
  // Pruned entries are marked removed → not re-downloaded on the next unchanged pass.
  const stats = await collect({ api, repository: 'acme/widgets', history, siteDir, options: { lookbackDays: 36500 } });
  assert.equal(stats.artifactsDownloaded, 0);
  assert.equal(history.runs.find(r => r.id === 101).mvnLens[0].reports[0].removed, true);
});

test('artifacts without meta.json are attributed through the artifact name, or left unattributed', async () => {
  const sc = scenario();
  const base = T0 + 20 * 3600000;
  sc.runs.push(fakeRun({ id: 400, runNumber: 40, baseMs: base, artifacts: [
    fakeArtifact({ artifactId: 900, runId: 400, jobId: 4000, stepNumber: 3, noMeta: true, name: 'mvn-lens--j4000--s3' }),
    fakeArtifact({ artifactId: 901, runId: 400, jobId: 4000, stepNumber: 3, noMeta: true, name: 'mvn-lens--custom-upload' }),
    fakeArtifact({ artifactId: 902, runId: 400, jobId: 4000, stepNumber: 3, expired: true, name: 'mvn-lens--j4000--s3--expired' }),
  ] }));
  const gh = fakeGitHub(sc);
  const api = new GitHubApi({ token: 't', fetch: gh.fetch });
  const history = emptyHistory('acme/widgets');
  const stats = await collect({ api, repository: 'acme/widgets', history, siteDir: tmpDir('site'), options: { lookbackDays: 36500, runIds: [400] } });
  const r = history.runs.find(x => x.id === 400);
  assert.equal(r.mvnLens.length, 2, 'the expired artifact is skipped');
  const byName = r.mvnLens.find(e => e.artifactId === 900);
  assert.equal(byName.attribution, 'artifactName');
  assert.equal(byName.stepNumber, 3);
  assert.equal(byName.reports[0].summarySource, 'html', 'summary computed from the HTML when meta.json is absent');
  const unattributed = r.mvnLens.find(e => e.artifactId === 901);
  assert.equal(unattributed.jobId, null);
  assert.equal(unattributed.stepNumber, null);
  assert.equal(r.mvnLens.reduce((n, e) => n + e.reports.length, 0), 2);
  assert.equal(stats.reportsCollected, 7, 'the 5 scenario reports plus these 2');
});

test('attribute() falls back from jobId to runnerName, jobName, jobKey and stepName', () => {
  const run = buildRunRecord(fakeRun({ id: 1, baseMs: T0 }), fakeRun({ id: 1, baseMs: T0 }).jobs);
  const job = run.jobs[0];
  assert.equal(attribute(run, { jobId: job.id, stepNumber: 3 }, { name: 'x' }).step.number, 3);
  assert.equal(attribute(run, { runnerName: job.runnerName, stepName: 'Build with Maven' }, { name: 'x' }).how, 'runnerName');
  assert.equal(attribute(run, { jobName: 'build', stepName: 'nope' }, { name: 'x' }).how, 'jobName/job-only');
  assert.equal(attribute(run, { jobKey: 'build' }, { name: 'x' }).job.id, job.id);
  assert.equal(attribute(run, { jobKey: 'other' }, { name: 'x' }).job, null);
  assert.equal(attribute(run, null, { name: 'mvn-lens--j999--s1' }).job, null);
});

test('matchesWorkflow accepts id, name, path and file name', () => {
  const wf = { id: 12, name: 'CI Build', path: '.github/workflows/ci.yml' };
  for (const sel of ['12', 'ci build', 'CI Build', 'ci.yml', '.github/workflows/ci.yml', 'CI.YML']) assert.ok(matchesWorkflow(wf, sel), sel);
  assert.ok(!matchesWorkflow(wf, 'ci'));
  assert.ok(!matchesWorkflow(wf, ''));
});

test('buildRunRecord derives duration and queue time from the jobs', () => {
  const s = fakeRun({ id: 7, baseMs: T0, mavenSec: 100 });
  const rec = buildRunRecord(s, s.jobs);
  assert.equal(rec.queueMs, 1000, 'measured from run_started_at (the latest attempt), not created_at');
  const rerun = Object.assign({}, s, { run_attempt: 2, run_started_at: new Date(T0 + 3 * 86400000).toISOString() });
  rerun.jobs = s.jobs.map(j => Object.assign({}, j, { started_at: new Date(T0 + 3 * 86400000 + 5000).toISOString(), completed_at: new Date(T0 + 3 * 86400000 + 65000).toISOString() }));
  const rec2 = buildRunRecord(rerun, rerun.jobs);
  assert.equal(rec2.queueMs, 5000, 'a re-run three days later does not report a three-day queue');
  assert.equal(rec2.durationMs, 65000);
  assert.equal(rec.durationMs, Date.parse(s.jobs[0].completed_at) - Date.parse(s.run_started_at));
  assert.equal(rec.jobs[0].durationMs, Date.parse(s.jobs[0].completed_at) - Date.parse(s.jobs[0].started_at));
  const nojobs = buildRunRecord(Object.assign({}, s, { jobs: [] }), []);
  assert.equal(nojobs.completedAt, s.updated_at, 'falls back to updated_at without jobs');
  assert.equal(nojobs.queueMs, null);
});
