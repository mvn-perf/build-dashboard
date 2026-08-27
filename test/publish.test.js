'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { prepareCheckout, commitAndPush, normalizeTarget } = require('../src/publish');
const { tmpDir } = require('./helpers');

function git(args, cwd) { return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
function hasGit() { try { git(['--version']); return true; } catch (e) { return false; } }

/** A local bare repository standing in for github.com/<repo>.git; serverUrl points at its parent dir. */
function bareRemote() {
  const root = tmpDir('remote');
  const bare = path.join(root, 'acme', 'widgets.git');
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(['init', '--quiet', '--bare', bare]);
  return { root, bare, serverUrl: 'file://' + root.replace(/\\/g, '/') };
}
function lsTree(bare, branch) { return git(['ls-tree', '-r', '--name-only', branch], bare).trim().split('\n').filter(Boolean).sort(); }
function commitCount(bare, branch) { return Number(git(['rev-list', '--count', branch], bare).trim()); }

test('publish creates the branch, then updates it as a single orphan commit with removed paths dropped', { skip: !hasGit() && 'git not installed' }, async () => {
  const remote = bareRemote();
  const build1 = tmpDir('build');
  fs.writeFileSync(path.join(build1, 'index.html'), 'v1');
  fs.mkdirSync(path.join(build1, 'reports', '1', 'a'), { recursive: true });
  fs.writeFileSync(path.join(build1, 'reports', '1', 'a', 'report.html'), 'r1');

  const co1 = prepareCheckout({ repository: 'acme/widgets', token: '', branch: 'gh-pages', workDir: tmpDir('work'), serverUrl: remote.serverUrl });
  assert.equal(co1.exists, false);
  const res1 = await commitAndPush({ checkout: co1, buildDir: build1, targetDir: '', message: 'first' });
  assert.equal(res1.pushed, true);
  assert.deepEqual(lsTree(remote.bare, 'gh-pages'), ['index.html', 'reports/1/a/report.html']);

  // Second publish: new report, old one pruned, orphan history → still one commit.
  const build2 = tmpDir('build');
  fs.writeFileSync(path.join(build2, 'index.html'), 'v2');
  fs.mkdirSync(path.join(build2, 'reports', '2', 'b'), { recursive: true });
  fs.writeFileSync(path.join(build2, 'reports', '2', 'b', 'report.html'), 'r2');
  const co2 = prepareCheckout({ repository: 'acme/widgets', token: '', branch: 'gh-pages', workDir: tmpDir('work'), serverUrl: remote.serverUrl });
  assert.equal(co2.exists, true);
  assert.ok(fs.existsSync(path.join(co2.workDir, 'reports', '1', 'a', 'report.html')), 'previous site is checked out');
  const res2 = await commitAndPush({ checkout: co2, buildDir: build2, targetDir: '', removedPaths: ['reports/1/a/report.html'], message: 'second', forceOrphan: true });
  assert.equal(res2.pushed, true);
  assert.deepEqual(lsTree(remote.bare, 'gh-pages'), ['index.html', 'reports/2/b/report.html']);
  assert.equal(commitCount(remote.bare, 'gh-pages'), 1);
  assert.equal(git(['show', 'gh-pages:index.html'], remote.bare), 'v2');

  // Nothing changed → no push.
  const co3 = prepareCheckout({ repository: 'acme/widgets', token: '', branch: 'gh-pages', workDir: tmpDir('work'), serverUrl: remote.serverUrl });
  const res3 = await commitAndPush({ checkout: co3, buildDir: build2, targetDir: '', message: 'noop' });
  assert.equal(res3.pushed, false);
  assert.equal(res3.changed, false);
});

test('publish into a sub-directory appends commits and survives a concurrent push', { skip: !hasGit() && 'git not installed' }, async () => {
  const remote = bareRemote();
  // Seed the branch with unrelated content that must survive.
  const seed = tmpDir('seed');
  git(['init', '--quiet', '-b', 'gh-pages', seed]);
  fs.writeFileSync(path.join(seed, 'other.html'), 'keep me');
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], seed);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed'], seed);
  git(['push', '-q', remote.bare, 'gh-pages'], seed);

  const build = tmpDir('build');
  fs.writeFileSync(path.join(build, 'index.html'), 'dash');
  const co = prepareCheckout({ repository: 'acme/widgets', token: '', branch: 'gh-pages', workDir: tmpDir('work'), serverUrl: remote.serverUrl });

  // Somebody else pushes in between.
  fs.writeFileSync(path.join(seed, 'other2.html'), 'also keep');
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], seed);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'race'], seed);
  git(['push', '-q', remote.bare, 'gh-pages'], seed);

  const res = await commitAndPush({ checkout: co, buildDir: build, targetDir: 'dashboard', message: 'dash', forceOrphan: false });
  assert.equal(res.pushed, true);
  assert.deepEqual(lsTree(remote.bare, 'gh-pages'), ['dashboard/index.html', 'other.html', 'other2.html']);
  assert.equal(commitCount(remote.bare, 'gh-pages'), 3);

  // Orphan mode also detects the race and re-syncs on top of the newest tip.
  const co2 = prepareCheckout({ repository: 'acme/widgets', token: '', branch: 'gh-pages', workDir: tmpDir('work'), serverUrl: remote.serverUrl });
  fs.writeFileSync(path.join(seed, 'other3.html'), 'x');
  git(['pull', '-q', '--rebase', remote.bare, 'gh-pages'], seed);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], seed);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'race2'], seed);
  git(['push', '-q', remote.bare, 'gh-pages'], seed);
  fs.writeFileSync(path.join(build, 'index.html'), 'dash2');
  const res2 = await commitAndPush({ checkout: co2, buildDir: build, targetDir: 'dashboard', message: 'dash2', forceOrphan: true });
  assert.equal(res2.pushed, true);
  assert.deepEqual(lsTree(remote.bare, 'gh-pages'), ['dashboard/index.html', 'other.html', 'other2.html', 'other3.html']);
  assert.equal(commitCount(remote.bare, 'gh-pages'), 1);
});

test('normalizeTarget', () => {
  assert.equal(normalizeTarget(''), '');
  assert.equal(normalizeTarget('.'), '');
  assert.equal(normalizeTarget('/dash/'), 'dash');
  assert.equal(normalizeTarget('a\\b'), 'a/b');
  assert.throws(() => normalizeTarget('../x'), /inside the branch/);
});
