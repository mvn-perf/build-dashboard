'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeZip } = require('../src/zip');

const FIXTURES = path.join(__dirname, 'fixtures');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), (prefix || 'bd-') + '-'));
}

/** A small but real-shaped mvn-lens report: the template markup around a fixture model. */
function fakeReportHtml(model, opts) {
  const o = opts || {};
  const json = JSON.stringify(model).replace(/<\/script/gi, '<\\/script');
  const payload = o.gzip ? 'gzip:' + require('zlib').gzipSync(Buffer.from(json, 'utf8')).toString('base64') : json;
  return `<!doctype html><html><head><meta charset="utf-8"><title>mvn-lens</title></head><body>
<div id="app"></div>
<script id="${o.id || 'mvnlens-data'}" type="application/json">${payload}</script>
<script>console.log("dashboard")</script>
</body></html>`;
}

function fixtureModel() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'model-small.json'), 'utf8'));
}

/** Builds the response set of a fake GitHub API from a scenario description. */
function fakeGitHub(scenario) {
  const calls = [];
  const routes = [];
  function on(method, pattern, handler) { routes.push({ method, pattern, handler }); }
  const repo = scenario.repository || 'acme/widgets';

  on('GET', `/repos/${repo}`, () => ({ default_branch: scenario.defaultBranch || 'main', html_url: `https://github.com/${repo}` }));
  on('GET', `/repos/${repo}/actions/workflows`, () => ({ total_count: scenario.workflows.length, workflows: scenario.workflows }));
  for (const wf of scenario.workflows) {
    on('GET', `/repos/${repo}/actions/workflows/${wf.id}/runs`, (url) => {
      const branch = url.searchParams.get('branch');
      const runs = scenario.runs.filter(r => r.workflow_id === wf.id && (!branch || r.head_branch === branch)).sort((a, b) => b.id - a.id);
      const perPage = Number(url.searchParams.get('per_page') || 30);
      const page = Number(url.searchParams.get('page') || 1);
      const slice = runs.slice((page - 1) * perPage, page * perPage);
      const headers = {};
      if (page * perPage < runs.length) {
        const next = new URL(url); next.searchParams.set('page', String(page + 1));
        headers.link = `<${next}>; rel="next"`;
      }
      return { body: { total_count: runs.length, workflow_runs: slice }, headers };
    });
  }
  for (const r of scenario.runs) {
    on('GET', `/repos/${repo}/actions/runs/${r.id}`, () => r);
    on('GET', `/repos/${repo}/actions/runs/${r.id}/jobs`, () => ({ total_count: (r.jobs || []).length, jobs: r.jobs || [] }));
    on('GET', `/repos/${repo}/actions/runs/${r.id}/artifacts`, () => ({ total_count: (r.artifacts || []).length, artifacts: (r.artifacts || []).map(a => ({ id: a.id, name: a.name, size_in_bytes: a.zip ? a.zip.length : 0, expired: !!a.expired, archive_download_url: `https://api.github.com/repos/${repo}/actions/artifacts/${a.id}/zip` })) }));
    for (const a of r.artifacts || []) {
      on('GET', `/repos/${repo}/actions/artifacts/${a.id}/zip`, () => ({ status: 302, headers: { location: `https://blob.example.test/${a.id}.zip` } }));
      on('GET', `https://blob.example.test/${a.id}.zip`, (url, init) => {
        if (init.headers && init.headers.Authorization) return { status: 400, body: 'auth header forwarded to blob host' };
        return { status: 200, buffer: a.zip };
      });
    }
  }
  if (scenario.extraRoutes) scenario.extraRoutes(on);

  async function fetchImpl(url, init) {
    const u = new URL(url);
    const key = u.origin === 'https://api.github.com' ? u.pathname : u.origin + u.pathname;
    calls.push({ method: (init && init.method) || 'GET', url: String(url), headers: init && init.headers });
    const route = routes.find(rt => rt.pattern === key && rt.method === ((init && init.method) || 'GET'));
    if (!route) return response(404, JSON.stringify({ message: 'Not Found: ' + key }));
    let res = route.handler(u, init || {});
    if (res && res.buffer) return response(res.status || 200, res.buffer, res.headers);
    if (res && res.status !== undefined) return response(res.status, res.body === undefined ? '' : (typeof res.body === 'string' ? res.body : JSON.stringify(res.body)), res.headers);
    if (res && res.body !== undefined && res.headers) return response(200, JSON.stringify(res.body), res.headers);
    return response(200, JSON.stringify(res));
  }
  return { fetch: fetchImpl, calls };
}

function response(status, body, headers) {
  const h = new Map(Object.entries(Object.assign({ 'x-ratelimit-remaining': '999' }, headers || {})).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || '', 'utf8');
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null },
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

function isoAt(baseMs, offsetSec) { return new Date(baseMs + offsetSec * 1000).toISOString(); }

/** Fabricates a run with one job and a few steps starting at baseMs. */
function fakeRun(p) {
  const base = p.baseMs;
  const jobId = p.jobId || p.id * 10;
  const steps = p.steps || [
    { number: 1, name: 'Set up job', start: 2, end: 4 },
    { number: 2, name: 'Run actions/checkout@v4', start: 4, end: 6 },
    { number: 3, name: 'Build with Maven', start: 6, end: 6 + (p.mavenSec || 60) },
    { number: 4, name: 'Attach mvn-lens report', start: 6 + (p.mavenSec || 60), end: 8 + (p.mavenSec || 60) },
    { number: 9, name: 'Complete job', start: 8 + (p.mavenSec || 60), end: 9 + (p.mavenSec || 60) },
  ];
  const end = Math.max(...steps.map(s => s.end)) + 1;
  const conclusion = p.conclusion || 'success';
  return {
    id: p.id, name: p.workflowName || 'CI', workflow_id: p.workflowId || 1, path: p.workflowPath || '.github/workflows/ci.yml',
    run_number: p.runNumber || p.id, run_attempt: p.attempt || 1, event: p.event || 'push', status: p.status || 'completed', conclusion: p.status === 'in_progress' ? null : conclusion,
    head_branch: p.branch || 'main', head_sha: p.sha || ('deadbeef' + p.id).padEnd(40, '0'), display_title: p.title || `commit ${p.id}`,
    actor: { login: 'octocat' }, triggering_actor: { login: 'octocat' },
    html_url: `https://github.com/acme/widgets/actions/runs/${p.id}`,
    created_at: isoAt(base, 0), updated_at: isoAt(base, end + 5), run_started_at: isoAt(base, 1),
    jobs: [{
      id: jobId, run_id: p.id, run_attempt: p.attempt || 1, name: p.jobName || 'build', status: p.status || 'completed', conclusion: p.status === 'in_progress' ? null : conclusion,
      created_at: isoAt(base, 0), started_at: isoAt(base, 2), completed_at: p.status === 'in_progress' ? null : isoAt(base, end),
      runner_name: p.runnerName || `GitHub Actions ${1000 + p.id}`, runner_group_name: 'GitHub Actions', labels: ['ubuntu-latest'],
      html_url: `https://github.com/acme/widgets/actions/runs/${p.id}/job/${jobId}`, workflow_name: p.workflowName || 'CI', head_branch: p.branch || 'main',
      steps: steps.map(s => ({ number: s.number, name: s.name, status: 'completed', conclusion: s.conclusion || 'success', started_at: isoAt(base, s.start), completed_at: isoAt(base, s.end) })),
    }],
    artifacts: p.artifacts || [],
  };
}

/** An mvn-lens artifact zip (report.html + meta.json) for the given run/job/step. */
function fakeArtifact(p) {
  const model = p.model || fixtureModel();
  if (p.totalMs) { model.session.totalMs = p.totalMs; model.session.wallMs = Math.round(p.totalMs * 0.95); }
  if (p.startedAt) { model.session.startedAt = p.startedAt; model.session.endedAt = p.startedAt + (model.session.totalMs || 5000); }
  const html = fakeReportHtml(model);
  const { summarizeModel } = require('../src/mvnlens');
  const meta = p.noMeta ? null : Object.assign({
    schemaVersion: 1, runId: p.runId, runAttempt: 1, jobKey: 'build', jobId: p.jobId || null, jobName: p.jobName || null, runnerName: p.runnerName || null,
    stepNumber: p.stepNumber || null, stepName: p.stepName || null, label: p.label || null, collectedAt: new Date(0).toISOString(),
    reports: [{ file: 'report.html', label: null, summary: summarizeModel(model), summarySource: 'html' }],
  }, p.metaOverride || {});
  const files = [{ name: 'report.html', data: html }];
  if (meta) files.push({ name: 'meta.json', data: JSON.stringify(meta) });
  return { id: p.artifactId, name: p.name || `mvn-lens--j${p.jobId}--s${p.stepNumber}`, expired: !!p.expired, zip: writeZip(files) };
}

module.exports = { FIXTURES, tmpDir, fakeReportHtml, fixtureModel, fakeGitHub, fakeRun, fakeArtifact, isoAt };
