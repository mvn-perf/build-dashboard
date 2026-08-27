'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { fixtureModel, fakeReportHtml, tmpDir } = require('./helpers');

const ATTACH = path.join(__dirname, '..', 'mvn-lens', 'attach.js');

/** Runs attach.js in a child process with a scripted GITHUB_* environment and a stubbed jobs API served by a tiny HTTP server. */
async function runAttach(opts) {
  const http = require('http');
  const server = http.createServer((req, res) => {
    if (/\/actions\/runs\/777\/attempts\/1\/jobs/.test(req.url)) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ total_count: 2, jobs: opts.jobs }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const outFile = path.join(opts.cwd, 'out.txt');
  const summaryFile = path.join(opts.cwd, 'summary.md');
  fs.writeFileSync(outFile, ''); fs.writeFileSync(summaryFile, '');
  const env = Object.assign({}, process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${port}`, GITHUB_REPOSITORY: 'acme/widgets', GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'build',
    RUNNER_NAME: opts.runnerName || 'GitHub Actions 42', RUNNER_TEMP: opts.cwd, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: summaryFile,
    INPUT_GITHUB_TOKEN: opts.token === undefined ? 'tok' : opts.token,
  }, opts.env || {});
  // Asynchronous spawn: a synchronous exec would block this process' event loop and starve the stub server.
  const { code, stdout } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [ATTACH], { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', c => resolve({ code: c, stdout: out }));
  });
  server.close();
  const outputs = {};
  const raw = fs.readFileSync(outFile, 'utf8');
  raw.replace(/^(\S+)<<(\S+)\r?\n([\s\S]*?)\r?\n\2/gm, (m, k, d, v) => { outputs[k] = v; return ''; });
  return { code, stdout, outputs, summary: fs.readFileSync(summaryFile, 'utf8') };
}

function jobs(extra) {
  return [
    { id: 11, name: 'build (17)', status: 'in_progress', runner_name: 'GitHub Actions 42', steps: [
      { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
      { number: 2, name: 'Run actions/checkout@v4', status: 'completed', conclusion: 'success' },
      { number: 3, name: 'Build with Maven', status: 'completed', conclusion: 'success' },
      { number: 4, name: 'Skipped thing', status: 'completed', conclusion: 'skipped' },
      { number: 5, name: 'Run mvn-perf/build-dashboard/mvn-lens@v1', status: 'in_progress', conclusion: null },
    ] },
    { id: 12, name: 'build (21)', status: 'in_progress', runner_name: 'GitHub Actions 43', steps: [] },
  ].concat(extra || []);
}

test('attach.js stages report + meta.json and names the artifact after the resolved job/step', async () => {
  const cwd = tmpDir('attach');
  fs.mkdirSync(path.join(cwd, 'target', 'mvnlens'), { recursive: true });
  const model = fixtureModel();
  fs.writeFileSync(path.join(cwd, 'target', 'mvnlens', 'report.html'), fakeReportHtml(model));
  fs.writeFileSync(path.join(cwd, 'target', 'mvnlens', 'model.json'), JSON.stringify(model));
  const r = await runAttach({ cwd, jobs: jobs(), env: { INPUT_INCLUDE_MODEL: 'true', INPUT_LABEL: 'it04 · T4' } });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.outputs.found, 'true');
  assert.equal(r.outputs['artifact-name'], 'mvn-lens--j11--s3--it04-T4');
  assert.equal(r.outputs['job-id'], '11');
  assert.equal(r.outputs['step-name'], 'Build with Maven');
  assert.equal(r.outputs['maven-total-ms'], String(model.session.totalMs));
  const staging = r.outputs.path;
  assert.ok(fs.existsSync(path.join(staging, 'report.html')));
  assert.ok(fs.existsSync(path.join(staging, 'model.json')));
  const meta = JSON.parse(fs.readFileSync(path.join(staging, 'meta.json'), 'utf8'));
  assert.equal(meta.jobId, 11);
  assert.equal(meta.jobName, 'build (17)');
  assert.equal(meta.stepNumber, 3);
  assert.match(meta.stepResolution, /^runner\/(report-time|previous-step)$/);
  assert.equal(meta.label, 'it04 · T4');
  assert.equal(meta.reports[0].summary.totalMs, model.session.totalMs);
  assert.match(r.summary, /mvn-lens report/);
});

test('attach.js honours step-name, multiple report globs and the missing-report policy', async () => {
  const cwd = tmpDir('attach');
  for (const m of ['lib-a', 'lib-b']) {
    fs.mkdirSync(path.join(cwd, m, 'target', 'mvnlens'), { recursive: true });
    fs.writeFileSync(path.join(cwd, m, 'target', 'mvnlens', 'report.html'), fakeReportHtml(fixtureModel()));
  }
  const r = await runAttach({ cwd, jobs: jobs(), env: { INPUT_REPORT: '**/target/mvnlens/report.html', INPUT_STEP_NAME: 'Run actions/checkout@v4' } });
  assert.equal(r.code, 0, r.stdout);
  const meta = JSON.parse(fs.readFileSync(path.join(r.outputs.path, 'meta.json'), 'utf8'));
  assert.equal(meta.reports.length, 2);
  assert.deepEqual(meta.reports.map(x => x.file), ['report.html', 'report-2.html']);
  assert.equal(meta.stepNumber, 2);
  assert.equal(r.outputs['artifact-name'], 'mvn-lens--j11--s2');

  const empty = tmpDir('attach');
  const warn = await runAttach({ cwd: empty, jobs: jobs() });
  assert.equal(warn.code, 0);
  assert.equal(warn.outputs.found, 'false');
  assert.match(warn.stdout, /::warning::No mvn-lens report found/);
  const err = await runAttach({ cwd: empty, jobs: jobs(), env: { INPUT_IF_NO_FILES_FOUND: 'error' } });
  assert.notEqual(err.code, 0);
});

test('attach.js resolves custom-named matrix jobs through job-name and picks the step that was running when the report was written', async () => {
  const cwd = tmpDir('attach');
  fs.mkdirSync(path.join(cwd, 'target', 'mvnlens'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'target', 'mvnlens', 'report.html'), fakeReportHtml(fixtureModel()));
  const written = fs.statSync(path.join(cwd, 'target', 'mvnlens', 'report.html')).mtimeMs;
  const iso = (ms) => new Date(ms).toISOString();
  // Two matrix legs share the hosted runner name; the Jobs API still shows the Maven step as running (lag).
  const lagging = [
    { id: 21, name: 'JDK 17 · ubuntu-latest', status: 'in_progress', runner_name: 'GitHub Actions 2', started_at: iso(written - 120000), steps: [
      { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', started_at: iso(written - 120000), completed_at: iso(written - 118000) },
      { number: 2, name: 'Set up JDK 17', status: 'completed', conclusion: 'success', started_at: iso(written - 118000), completed_at: iso(written - 110000) },
      { number: 3, name: 'Build with Maven', status: 'in_progress', conclusion: null, started_at: iso(written - 110000), completed_at: null },
    ] },
    { id: 22, name: 'JDK 21 · ubuntu-latest', status: 'in_progress', runner_name: 'GitHub Actions 2', started_at: iso(written + 5000), steps: [] },
  ];
  const r = await runAttach({ cwd, jobs: lagging, runnerName: 'GitHub Actions 2', env: { INPUT_JOB_NAME: 'JDK 17 · ubuntu-latest' } });
  assert.equal(r.code, 0, r.stdout);
  const meta = JSON.parse(fs.readFileSync(path.join(r.outputs.path, 'meta.json'), 'utf8'));
  assert.equal(meta.jobId, 21);
  assert.equal(meta.stepNumber, 3, 'the step whose window contains the report mtime, even though the API still shows it running');
  assert.equal(meta.stepResolution, 'job-name/report-time');

  // Without job-name: the runner-name collision is resolved by "already running when the report was written".
  const r2 = await runAttach({ cwd, jobs: lagging, runnerName: 'GitHub Actions 2' });
  assert.equal(r2.code, 0, r2.stdout);
  const meta2 = JSON.parse(fs.readFileSync(path.join(r2.outputs.path, 'meta.json'), 'utf8'));
  assert.equal(meta2.jobId, 21);
  assert.equal(meta2.stepResolution, 'runner/report-time');
});

test('attach.js degrades gracefully without a token or when the job cannot be identified', async () => {
  const cwd = tmpDir('attach');
  fs.mkdirSync(path.join(cwd, 'target', 'mvnlens'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'target', 'mvnlens', 'report.html'), fakeReportHtml(fixtureModel()));
  const r = await runAttach({ cwd, jobs: jobs(), token: '' });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.outputs['artifact-name'], /^mvn-lens--build--[a-z0-9]+$/);
  const meta = JSON.parse(fs.readFileSync(path.join(r.outputs.path, 'meta.json'), 'utf8'));
  assert.equal(meta.jobId, null);
  assert.equal(meta.jobKey, 'build');
  assert.equal(meta.runnerName, 'GitHub Actions 42');

  const r2 = await runAttach({ cwd, jobs: jobs(), runnerName: 'unknown runner' });
  assert.equal(r2.code, 0, r2.stdout);
  const meta2 = JSON.parse(fs.readFileSync(path.join(r2.outputs.path, 'meta.json'), 'utf8'));
  assert.equal(meta2.jobId, null, 'two in-progress "build (…)" jobs are ambiguous for the job-key fallback');
  assert.equal(meta2.stepResolution, 'job-not-found');
  assert.match(r2.stdout, /job-name/, 'hints at the job-name input');
});
