'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { GitHubApi } = require('../src/github-api');
const { collect, isForkRun } = require('../src/collect');
const { emptyHistory, normalizeHistory, isValidReportPath } = require('../src/history');
const { writeZip } = require('../src/zip');
const { fakeGitHub, fakeRun, fakeArtifact, tmpDir } = require('./helpers');

const T0 = Date.parse('2026-06-01T10:00:00Z');
const WF = [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }];

function api(sc) { const gh = fakeGitHub(sc); return { api: new GitHubApi({ token: 't', fetch: gh.fetch }), gh }; }

test('runs from forked repositories are skipped unless include-fork-runs is set', async () => {
  const own = fakeRun({ id: 1, runNumber: 1, baseMs: T0 });
  own.head_repository = { full_name: 'Acme/Widgets' };           // case differs, same repo
  const fork = fakeRun({ id: 2, runNumber: 2, baseMs: T0 + 3600000, event: 'pull_request', artifacts: [fakeArtifact({ artifactId: 9, runId: 2, jobId: 20, stepNumber: 3 })] });
  fork.head_repository = { full_name: 'mallory/widgets' };
  const sc = { repository: 'acme/widgets', workflows: WF, runs: [own, fork] };
  assert.equal(isForkRun(own, 'acme/widgets'), false);
  assert.equal(isForkRun(fork, 'acme/widgets'), true);
  assert.equal(isForkRun({ head_repository: null }, 'acme/widgets'), false);

  let h = emptyHistory('acme/widgets');
  let stats = await collect({ api: api(sc).api, repository: 'acme/widgets', history: h, siteDir: tmpDir('site'), options: { lookbackDays: 36500, runIds: [2] } });
  assert.deepEqual(h.runs.map(r => r.id), [1], 'even an explicit run-id does not pull a fork run in');
  assert.equal(stats.forkRunsSkipped, 1);
  assert.equal(stats.reportsCollected, 0);

  h = emptyHistory('acme/widgets');
  await collect({ api: api(sc).api, repository: 'acme/widgets', history: h, siteDir: tmpDir('site'), options: { lookbackDays: 36500, includeForkRuns: true } });
  assert.deepEqual(h.runs.map(r => r.id).sort(), [1, 2]);
  assert.equal(h.runs.find(r => r.id === 2).headRepository, 'mallory/widgets');
});

test('only files carrying a real mvn-lens model are published from an artifact', async () => {
  const zip = writeZip([
    { name: 'report.html', data: '<html><script>alert(document.cookie)</script></html>' },
    { name: 'meta.json', data: JSON.stringify({ schemaVersion: 1, jobId: 10, stepNumber: 3, reports: [{ file: 'report.html' }] }) },
  ]);
  const run = fakeRun({ id: 1, runNumber: 1, baseMs: T0, artifacts: [{ id: 5, name: 'mvn-lens--j10--s3', expired: false, zip }] });
  const sc = { repository: 'acme/widgets', workflows: WF, runs: [run] };
  const h = emptyHistory('acme/widgets');
  const siteDir = tmpDir('site');
  const stats = await collect({ api: api(sc).api, repository: 'acme/widgets', history: h, siteDir, options: { lookbackDays: 36500 } });
  assert.equal(stats.reportsCollected, 0);
  assert.equal(h.runs[0].mvnLens.length, 0);
  assert.ok(!fs.existsSync(path.join(siteDir, 'reports')), 'nothing written to the site');
});

test('artifacts of an earlier attempt are dropped when the run is re-run', async () => {
  const sc = { repository: 'acme/widgets', workflows: WF, runs: [fakeRun({ id: 1, runNumber: 1, baseMs: T0, artifacts: [fakeArtifact({ artifactId: 5, runId: 1, jobId: 10, stepNumber: 3, totalMs: 50000 })] })] };
  const { api: a } = api(sc);
  const h = emptyHistory('acme/widgets');
  const siteDir = tmpDir('site');
  await collect({ api: a, repository: 'acme/widgets', history: h, siteDir, options: { lookbackDays: 36500 } });
  assert.equal(h.runs[0].mvnLens.length, 1);
  assert.equal(h.runs[0].mvnLens[0].attempt, 1);

  // Attempt 2: new job id, the old artifact is still listed by the API, plus a new one with meta.runAttempt 2.
  const r = sc.runs[0];
  r.run_attempt = 2; r.updated_at = new Date(T0 + 7200000).toISOString(); r.run_started_at = new Date(T0 + 3600000).toISOString();
  r.jobs[0].id = 11; r.jobs[0].run_attempt = 2;
  r.artifacts.push(fakeArtifact({ artifactId: 6, runId: 1, jobId: 11, stepNumber: 3, totalMs: 60000, metaOverride: { runAttempt: 2 } }));
  r.artifacts.push(fakeArtifact({ artifactId: 7, runId: 1, jobId: 11, stepNumber: 3, totalMs: 70000, name: 'mvn-lens--stale', metaOverride: { runAttempt: 1, jobId: 10, jobName: 'build' } }));
  // The fake API registers artifact routes at creation time: rebuild it for the mutated scenario.
  const stats = await collect({ api: api(sc).api, repository: 'acme/widgets', history: h, siteDir, options: { lookbackDays: 36500 } });
  assert.equal(stats.runsFetched, 1);
  const run = h.runs[0];
  assert.equal(run.attempt, 2);
  assert.deepEqual(run.mvnLens.map(e => e.artifactId), [6], 'attempt-1 artifacts (by name and by meta) are not re-attributed to the new job');
  assert.equal(run.mvnLens[0].reports[0].summary.totalMs, 60000);
});

test('a corrupt artifact does not prevent the run itself from being recorded', async () => {
  const zip = writeZip([{ name: 'report.html', data: 'x' }]);
  zip[zip.length - 22 + 16] ^= 0xff;                               // corrupt the central directory offset
  const sc = { repository: 'acme/widgets', workflows: WF, runs: [fakeRun({ id: 1, runNumber: 1, baseMs: T0, artifacts: [{ id: 5, name: 'mvn-lens--j10--s3', expired: false, zip }] })] };
  const h = emptyHistory('acme/widgets');
  const stats = await collect({ api: api(sc).api, repository: 'acme/widgets', history: h, siteDir: tmpDir('site'), options: { lookbackDays: 36500 } });
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].jobs[0].steps.length, 5);
  assert.ok(stats.errors >= 1);
});

test('normalizeHistory neutralises report paths that could escape the site directory', () => {
  const bad = ['../../etc/passwd', 'reports/1/a/../../x', '/reports/1/a/report.html', 'reports/1/a\\b/report.html', 'reports/x/a/report.html', 'reports/1/a/.hidden', 'reports/1/a/sub/report.html', 'C:\\x'];
  for (const p of bad) assert.equal(isValidReportPath(p), false, p);
  assert.equal(isValidReportPath('reports/33111412264/mvn-lens--j98654904104--s4/report.html'), true);
  assert.equal(isValidReportPath('reports/1/mvn-lens--j1--s2--it04-T4/report-2.html'), true);
  const h = normalizeHistory({ repository: 'a/b', runs: [{ id: 1, createdAt: '2026-01-01T00:00:00Z', mvnLens: [{ artifactId: 1, reports: [{ name: 'r', path: '../../../evil', summary: { totalMs: 5 } }, { name: 'ok', path: 'reports/1/a/report.html' }, 'junk'] }, null] }] }, 'a/b');
  const reps = h.runs[0].mvnLens[0].reports;
  assert.equal(reps.length, 2);
  assert.equal(reps[0].path, null);
  assert.equal(reps[0].removed, true);
  assert.equal(reps[0].summary.totalMs, 5, 'the summary is kept for the trend');
  assert.equal(reps[1].path, 'reports/1/a/report.html');
  assert.equal(h.runs[0].mvnLens.length, 1);
});
