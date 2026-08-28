'use strict';

// The bundles in dist/ are what actually runs on the runner: check they exist,
// are self-contained (nothing required from node_modules at run time) and
// behave like the sources they were built from.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('./helpers');

const DIST = path.join(__dirname, '..', 'dist');

/** Runs a bundle in a child process with a clean runner environment (no INPUT_/GITHUB_ leaking in from the host). */
function run(script, env, cwd) {
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(INPUT_|GITHUB_|RUNNER_|ACTIONS_)/.test(k)) base[k] = v;
  const r = spawnSync(process.execPath, [path.join(DIST, script)], { cwd: cwd || tmpDir('dist-cwd'), env: Object.assign(base, env), encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('dist/ is built, self-contained and carries the third-party notices', () => {
  for (const f of ['index.js', 'attach.js', 'licenses.txt']) assert.ok(fs.existsSync(path.join(DIST, f)), `dist/${f} missing — run npm run build`);
  for (const f of ['index.js', 'attach.js']) {
    const bundle = fs.readFileSync(path.join(DIST, f), 'utf8');
    assert.doesNotMatch(bundle, /require\(["']@actions\/[a-z-]+["']\)/, `${f}: dependencies are bundled, not required at run time`);
    assert.doesNotMatch(bundle, /require\(["']\.\.?\/[^"']*["']\)/, `${f}: no relative requires survive bundling`);
  }
  assert.match(fs.readFileSync(path.join(DIST, 'licenses.txt'), 'utf8'), /@actions\/core@\d[^\n]*MIT/);
});

test('dist/index.js starts and reports input errors as workflow commands', () => {
  const r = run('index.js', { INPUT_REPOSITORY: 'not-a-repo' });
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /Cannot find module/);
  assert.match(r.out, /::error::.*repository must be "owner\/name"/);
});

test('dist/attach.js runs the mvn-lens step end to end', () => {
  const dir = tmpDir('dist-attach');
  const outFile = path.join(dir, 'output');
  fs.writeFileSync(outFile, '');
  const r = run('attach.js', { INPUT_REPORT: 'does/not/exist.html', INPUT_IF_NO_FILES_FOUND: 'ignore', GITHUB_OUTPUT: outFile }, dir);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /Cannot find module/);
  assert.match(fs.readFileSync(outFile, 'utf8'), /^found<<ghadelimiter_[\w-]+\r?\nfalse/m);
});
