'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('../src/history');
const { tmpDir } = require('./helpers');

function run(id, wf, createdAt, reports) {
  return { id, workflowId: wf, createdAt, jobs: [], mvnLens: reports ? [{ artifactId: id, artifactName: 'a', reports: reports.map(p => ({ name: 'report.html', path: p, removed: false, summary: { totalMs: 1 } })) }] : [] };
}

test('load/save round-trip and normalisation', () => {
  const dir = tmpDir('hist');
  const file = path.join(dir, 'data', 'history.json');
  assert.equal(H.loadHistory(file, 'a/b').runs.length, 0);
  const h = H.emptyHistory('a/b');
  h.runs.push(run(1, 1, '2026-01-01T00:00:00Z'), run(2, 1, '2026-01-02T00:00:00Z'));
  H.saveHistory(file, h);
  const back = H.loadHistory(file, 'a/b');
  assert.deepEqual(back.runs.map(r => r.id), [2, 1], 'newest first');
  assert.equal(back.repository, 'a/b');
});

test('loadHistory refuses a history of another repository or a newer schema', () => {
  const dir = tmpDir('hist');
  const file = path.join(dir, 'history.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, repository: 'x/y', runs: [] }));
  assert.throws(() => H.loadHistory(file, 'a/b'), /belongs to x\/y/);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, repository: 'a/b', runs: [] }));
  assert.throws(() => H.loadHistory(file, 'a/b'), /newer than this action/);
  fs.writeFileSync(file, JSON.stringify({ repository: 'A/B', runs: [{ id: 1, createdAt: '2026-01-01T00:00:00Z' }, { bogus: true }] }));
  const h = H.loadHistory(file, 'a/b');
  assert.equal(h.runs.length, 1, 'entries without a numeric id are dropped');
  assert.deepEqual(h.runs[0].jobs, []);
});

test('prune keeps max-runs per workflow and only keep-reports report files', () => {
  const h = H.emptyHistory('a/b');
  for (let i = 1; i <= 6; i++) h.runs.push(run(i, 1, `2026-01-0${i}T00:00:00Z`, [`reports/${i}/a/report.html`]));
  for (let i = 11; i <= 13; i++) h.runs.push(run(i, 2, `2026-02-${i}T00:00:00Z`, [`reports/${i}/a/report.html`]));
  const { removedRuns, removedReportPaths } = H.prune(h, { maxRunsPerWorkflow: 4, keepReports: 2 });
  assert.deepEqual(removedRuns.map(r => r.id).sort(), [1, 2], 'oldest runs of workflow 1 dropped');
  assert.deepEqual(h.runs.filter(r => r.workflowId === 1).map(r => r.id), [6, 5, 4, 3]);
  assert.deepEqual(h.runs.filter(r => r.workflowId === 2).map(r => r.id), [13, 12, 11]);
  // Reports: runs 6,5 (wf1) and 13,12 (wf2) keep files; 4,3 and 11 lose them but keep summaries; 1,2 files removed with the runs.
  assert.deepEqual(removedReportPaths.sort(), ['reports/1/a/report.html', 'reports/11/a/report.html', 'reports/2/a/report.html', 'reports/3/a/report.html', 'reports/4/a/report.html']);
  const r4 = h.runs.find(r => r.id === 4);
  assert.equal(r4.mvnLens[0].reports[0].path, null);
  assert.equal(r4.mvnLens[0].reports[0].removed, true);
  assert.equal(r4.mvnLens[0].reports[0].summary.totalMs, 1, 'summary survives for the trend');
  assert.equal(h.runs.find(r => r.id === 6).mvnLens[0].reports[0].path, 'reports/6/a/report.html');
});

test('upsertRun replaces by id; reportDirFor sanitises names', () => {
  const h = H.emptyHistory('a/b');
  H.upsertRun(h, run(1, 1, '2026-01-01T00:00:00Z'));
  H.upsertRun(h, Object.assign(run(1, 1, '2026-01-01T00:00:00Z'), { status: 'completed' }));
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].status, 'completed');
  assert.equal(H.reportDirFor(42, 'mvn-lens--j1--s3 weird/name'), 'reports/42/mvn-lens--j1--s3-weird-name');
  assert.equal(H.mavenSeriesKey('.github/workflows/ci.yml', 'build (17)', 'Build', null), '.github/workflows/ci.yml build (17) Build ');
});
