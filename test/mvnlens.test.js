'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractModelFromHtml, summarizeModel, readReportSummary } = require('../src/mvnlens');
const { fixtureModel, fakeReportHtml, tmpDir } = require('./helpers');

test('extractModelFromHtml reads the plain JSON data block', () => {
  const model = fixtureModel();
  const html = fakeReportHtml(model);
  const back = extractModelFromHtml(html);
  assert.equal(back.session.artifactId, model.session.artifactId);
  assert.equal(back.modules.length, model.modules.length);
});

test('extractModelFromHtml reads the gzip:base64 encoding and the legacy mvnflight id', () => {
  const model = fixtureModel();
  assert.equal(extractModelFromHtml(fakeReportHtml(model, { gzip: true })).session.totalMs, model.session.totalMs);
  assert.equal(extractModelFromHtml(fakeReportHtml(model, { id: 'mvnflight-data' })).session.totalMs, model.session.totalMs);
});

test('extractModelFromHtml survives an escaped </script> inside a string and returns null for non-reports', () => {
  const model = fixtureModel();
  model.session.artifactId = 'evil</script><script>alert(1)</script>';
  const html = fakeReportHtml(model);
  assert.ok(html.includes('<\\/script'));
  assert.equal(extractModelFromHtml(html).session.artifactId, model.session.artifactId);
  assert.equal(extractModelFromHtml('<html><body>hello</body></html>'), null);
});

test('summarizeModel computes the headline metrics', () => {
  const model = fixtureModel();
  const s = summarizeModel(model);
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.artifactId, 'it04-multi-module');
  assert.deepEqual(s.goals, ['clean', 'verify']);
  assert.equal(s.totalMs, model.session.totalMs);
  assert.equal(s.wallMs, model.session.wallMs);
  assert.equal(s.status, 'OK');
  assert.equal(s.moduleCount, model.modules.length);
  assert.equal(s.modules.length, model.modules.length);
  const c2 = model.jit.filter(e => e.level >= 4).reduce((a, e) => a + e.durationMs, 0);
  assert.equal(s.c2Ms, c2);
  assert.ok(s.jitMs >= s.c2Ms);
  assert.equal(s.mavenVersion, model.session.mavenVersion);
  assert.equal(s.environment.availableProcessors, model.environment.availableProcessors);
  assert.equal(typeof s.testCount, 'number');
  assert.ok(s.startedAt > 0 && s.endedAt > s.startedAt);
});

test('summarizeModel tolerates missing sections and falls back to wallMs', () => {
  const s = summarizeModel({ session: { wallMs: 1234, goals: null } });
  assert.equal(s.totalMs, 1234);
  assert.equal(s.moduleCount, 0);
  assert.equal(s.c2Ms, 0);
  assert.deepEqual(s.goals, []);
  assert.equal(s.environment, null);
  const empty = summarizeModel(null);
  assert.equal(empty.totalMs, 0);
});

test('readReportSummary prefers the HTML and falls back to model.json', () => {
  const dir = tmpDir('mvnlens');
  const model = fixtureModel();
  fs.writeFileSync(path.join(dir, 'report.html'), fakeReportHtml(model));
  const r1 = readReportSummary(path.join(dir, 'report.html'));
  assert.equal(r1.source, 'html');
  assert.equal(r1.summary.totalMs, model.session.totalMs);

  fs.writeFileSync(path.join(dir, 'report.html'), '<html>degraded report without data</html>');
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(model));
  const r2 = readReportSummary(path.join(dir, 'report.html'));
  assert.equal(r2.source, 'model.json');
  assert.equal(r2.summary.totalMs, model.session.totalMs);

  fs.unlinkSync(path.join(dir, 'model.json'));
  const r3 = readReportSummary(path.join(dir, 'report.html'));
  assert.equal(r3.summary, null);
  assert.match(r3.error, /no embedded mvn-lens model/);
});
