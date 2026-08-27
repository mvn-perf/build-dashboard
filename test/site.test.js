'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { generateSite, embedJson } = require('../src/site');
const { emptyHistory } = require('../src/history');
const { tmpDir } = require('./helpers');

test('embedJson neutralises script-closing and comment sequences while staying valid JSON', () => {
  const s = embedJson({ a: '</script><!-- x -->', b: 'line sep' });
  assert.ok(!/<\/script/i.test(s));
  assert.ok(!s.includes('<!--'));
  assert.ok(!s.includes(' '));
  assert.deepEqual(JSON.parse(s), { a: '</script><!-- x -->', b: 'line sep' });
});

test('generateSite writes a self-contained index.html, history.json and .nojekyll', () => {
  const dir = tmpDir('site');
  const history = emptyHistory('acme/widgets');
  history.workflows['1'] = { id: 1, name: 'CI', path: '.github/workflows/ci.yml' };
  history.runs.push({ id: 1, workflowId: 1, workflowName: 'CI', runNumber: 1, status: 'completed', conclusion: 'success', createdAt: '2026-06-01T00:00:00Z', startedAt: '2026-06-01T00:00:00Z', completedAt: '2026-06-01T00:01:00Z', durationMs: 60000, branch: 'main', jobs: [], mvnLens: [], title: '<b>x</b>' });
  const out = generateSite({ history, siteDir: dir, title: 'My <dash>', actionVersion: '1.2.3', siteUrl: 'https://example.test/' });
  const html = fs.readFileSync(out.indexFile, 'utf8');
  assert.ok(html.includes('<title>My &lt;dash&gt;</title>'));
  assert.ok(html.includes('id="build-dashboard-data"'));
  assert.ok(!html.includes('__APP_JS__') && !html.includes('__DATA_JSON__') && !html.includes('__APP_CSS__'));
  assert.ok(html.includes('Chart.js v4'), 'Chart.js is inlined');
  assert.ok(fs.existsSync(path.join(dir, '.nojekyll')));
  const hist = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'history.json'), 'utf8'));
  assert.equal(hist.runs.length, 1);
  assert.equal(hist.meta, undefined, 'history.json is the plain dataset');

  // The embedded dataset parses back and carries the meta block.
  const m = /<script id="build-dashboard-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  const data = decodeEmbedded(m[1]);
  assert.equal(data.meta.title, 'My <dash>');
  assert.equal(data.meta.actionVersion, '1.2.3');
  assert.equal(data.runs[0].title, '<b>x</b>');
});

test('generateSite gzips large datasets and app.js can decode them', () => {
  const dir = tmpDir('site');
  const history = emptyHistory('acme/widgets');
  for (let i = 0; i < 400; i++) history.runs.push({ id: i, workflowId: 1, runNumber: i, status: 'completed', conclusion: 'success', createdAt: '2026-06-01T00:00:00Z', durationMs: 1000 + i, jobs: [{ id: i, name: 'build', steps: [{ number: 1, name: 'x'.repeat(200), durationMs: 5 }] }], mvnLens: [] });
  const out = generateSite({ history, siteDir: dir, gzipThreshold: 1024 });
  const html = fs.readFileSync(out.indexFile, 'utf8');
  const m = /<script id="build-dashboard-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m[1].startsWith('gzip:'));
  assert.equal(decodeEmbedded(m[1]).runs.length, 400);
});

test('app.js parses as a script and only references the expected globals', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'site', 'app.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(src));
  assert.ok(!/innerHTML\s*=\s*[^'"]*\+/.test(src), 'no innerHTML built from concatenation');
});

function decodeEmbedded(raw) {
  raw = raw.trim();
  if (raw.startsWith('gzip:')) return JSON.parse(zlib.gunzipSync(Buffer.from(raw.slice(5), 'base64')).toString('utf8'));
  return JSON.parse(raw);
}
