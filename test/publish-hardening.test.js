'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { prepareCheckout, commitAndPush, redact, syncFiles } = require('../src/publish');
const { tmpDir } = require('./helpers');

function git(args, cwd) { return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
function hasGit() { try { git(['--version']); return true; } catch (e) { return false; } }
function bareRemote() {
  const root = tmpDir('remote');
  const bare = path.join(root, 'acme', 'widgets.git');
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(['init', '--quiet', '--bare', bare]);
  return { root, bare, serverUrl: 'file://' + root.replace(/\\/g, '/') };
}
function seedBranch(remote, branch, files) {
  const seed = tmpDir('seed');
  git(['init', '--quiet', '-b', branch, seed]);
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.join(seed, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(seed, f), c); }
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], seed);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed'], seed);
  git(['push', '-q', remote.bare, branch], seed);
  return seed;
}

test('the credential never appears on a git command line and is redacted from errors', { skip: !hasGit() && 'git not installed' }, () => {
  const remote = bareRemote();
  const token = 'ghs_supersecrettoken1234567890';
  const b64 = Buffer.from('x-access-token:' + token).toString('base64');
  // An unreachable repository makes ls-remote fail; the error must not leak the header value.
  let err;
  try { prepareCheckout({ repository: 'acme/nope', token, branch: 'gh-pages', workDir: tmpDir('work'), serverUrl: remote.serverUrl }); } catch (e) { err = e; }
  assert.ok(err, 'expected a failure');
  assert.ok(!err.message.includes(b64), err.message);
  assert.ok(!err.message.includes(token), err.message);
  assert.match(err.message, /cannot reach/);
  assert.equal(redact('AUTHORIZATION: basic ' + b64 + ' and ' + b64, b64), 'AUTHORIZATION: basic *** and ***');

  // Where it works, the env carries the header (GIT_CONFIG_*), not argv.
  const co = prepareCheckout({ repository: 'acme/widgets', token, branch: 'gh-pages', workDir: tmpDir('work'), serverUrl: remote.serverUrl });
  assert.equal(co.env.GIT_CONFIG_KEY_0, `http.${remote.serverUrl}/.extraheader`);
  assert.equal(co.env.GIT_CONFIG_VALUE_0, '', 'resets any header persisted by actions/checkout');
  assert.equal(co.env.GIT_CONFIG_KEY_1, `http.${remote.serverUrl}/.extraheader`);
  assert.ok(co.env.GIT_CONFIG_VALUE_1.endsWith(b64));
});

test('force-orphan refuses the default branch and warns on a foreign branch; ls-remote matches the exact ref', { skip: !hasGit() && 'git not installed' }, async () => {
  const remote = bareRemote();
  seedBranch(remote, 'main', { 'README.md': 'x' });
  seedBranch(remote, 'feature/gh-pages', { 'other.txt': 'x' });     // a ref that merely ENDS with gh-pages
  assert.throws(() => prepareCheckout({ repository: 'acme/widgets', token: '', branch: 'main', workDir: tmpDir('work'), serverUrl: remote.serverUrl, defaultBranch: 'main', forceOrphan: true }), /default branch/);
  // gh-pages itself does not exist yet: must not be confused with feature/gh-pages.
  const co = prepareCheckout({ repository: 'acme/widgets', token: '', branch: 'gh-pages', workDir: tmpDir('work'), serverUrl: remote.serverUrl, defaultBranch: 'main', forceOrphan: true });
  assert.equal(co.exists, false);
  const build = tmpDir('build'); fs.writeFileSync(path.join(build, 'index.html'), 'v1');
  const res = await commitAndPush({ checkout: co, buildDir: build, targetDir: '', message: 'first' });
  assert.equal(res.pushed, true);
  assert.equal(git(['show', 'gh-pages:index.html'], remote.bare), 'v1');
  assert.equal(git(['show', 'feature/gh-pages:other.txt'], remote.bare), 'x', 'the look-alike branch is untouched');
});

test('after a concurrent publish the onRefresh callback rebuilds on top of the new history before the retry', { skip: !hasGit() && 'git not installed' }, async () => {
  const remote = bareRemote();
  seedBranch(remote, 'gh-pages', { 'index.html': 'v0', 'data/history.json': JSON.stringify({ runs: [0] }) });
  const build = tmpDir('build');
  fs.writeFileSync(path.join(build, 'index.html'), 'mine');
  fs.mkdirSync(path.join(build, 'data')); fs.writeFileSync(path.join(build, 'data', 'history.json'), JSON.stringify({ runs: [0, 1] }));
  const co = prepareCheckout({ repository: 'acme/widgets', token: '', branch: 'gh-pages', workDir: tmpDir('work'), serverUrl: remote.serverUrl });
  // Somebody publishes runs {0, 2} in between.
  const seed = tmpDir('other');
  git(['clone', '-q', '--branch', 'gh-pages', remote.bare, seed]);
  fs.writeFileSync(path.join(seed, 'data', 'history.json'), JSON.stringify({ runs: [0, 2] }));
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], seed); git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'theirs'], seed);
  git(['push', '-q', 'origin', 'gh-pages'], seed);

  let refreshed = 0;
  const res = await commitAndPush({
    checkout: co, buildDir: build, targetDir: '', message: 'mine', forceOrphan: true,
    onRefresh: async (c) => {
      refreshed++;
      const theirs = JSON.parse(fs.readFileSync(path.join(c.workDir, 'data', 'history.json'), 'utf8'));
      assert.deepEqual(theirs.runs, [0, 2], 'the checkout now holds the concurrent publish');
      fs.writeFileSync(path.join(build, 'data', 'history.json'), JSON.stringify({ runs: theirs.runs.concat([1]) }));
      return { buildDir: build, removedPaths: [] };
    },
  });
  assert.equal(res.pushed, true);
  assert.equal(refreshed, 1);
  assert.deepEqual(JSON.parse(git(['show', 'gh-pages:data/history.json'], remote.bare)).runs, [0, 2, 1], 'both publishers\' runs survive');
});

test('syncFiles never deletes outside the target directory', () => {
  const work = tmpDir('work');
  fs.mkdirSync(path.join(work, 'site2')); fs.writeFileSync(path.join(work, 'site2', 'keep.txt'), 'x');
  fs.mkdirSync(path.join(work, 'site', 'reports', '1'), { recursive: true }); fs.writeFileSync(path.join(work, 'site', 'reports', '1', 'r.html'), 'x');
  const build = tmpDir('build'); fs.writeFileSync(path.join(build, 'index.html'), 'i');
  syncFiles(work, 'site', build, ['../site2/keep.txt', '../../etc', 'reports/1/r.html', 'C:\\Windows\\x']);
  assert.ok(fs.existsSync(path.join(work, 'site2', 'keep.txt')));
  assert.ok(!fs.existsSync(path.join(work, 'site', 'reports')), 'the legitimate report and its empty parents are gone');
  assert.ok(fs.existsSync(path.join(work, 'site', 'index.html')));
});
