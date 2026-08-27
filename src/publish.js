/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { log, debug, warning, ensureDir, rmrf, copyDir, exists, sleep, addMask, isWithin } = require('./util');

const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

/**
 * Git-based publishing to a branch (the classic GitHub Pages "deploy from a
 * branch" model). Two phases so the collector can read the previously
 * published history/reports in between:
 *
 *   const co = prepareCheckout({...});      // clone or init the branch
 *   … build the site into a temp dir …
 *   commitAndPush({ checkout: co, buildDir, targetDir, removedPaths, … });
 *
 * The token never appears on a command line: it is handed to git through the
 * GIT_CONFIG_* environment (an http.<origin>.extraheader), and every git error
 * is redacted before it can reach a log.
 */

/** Environment carrying the credential as an extra HTTP header (never on argv). */
function authEnv(serverUrl, token) {
  if (!token) return {};
  const basic = Buffer.from('x-access-token:' + token, 'utf8').toString('base64');
  addMask(basic);
  const origin = serverUrl.replace(/\/+$/, '') + '/';
  // An empty extraheader value resets the list first: actions/checkout persists
  // its own Authorization header in the workspace's .git/config, and GitHub
  // rejects a request carrying two of them ("Duplicate header").
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `http.${origin}.extraheader`,
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: `http.${origin}.extraheader`,
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
    __REDACT: basic,
  };
}

function git(args, opts) {
  const o = opts || {};
  const extra = Object.assign({}, o.env || {});
  const secret = extra.__REDACT;
  delete extra.__REDACT;
  const env = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }, extra);
  debug('git ' + args.join(' '));
  try {
    return execFileSync(o.git || 'git', args, {
      cwd: o.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    }).toString('utf8');
  } catch (e) {
    const err = new Error(`git ${args[0]} failed: ${redact(firstLine(e), secret)}`);
    err.stderr = redact(e && e.stderr ? e.stderr.toString() : '', secret);
    err.status = e && e.status;
    throw err;
  }
}

/** SHA of refs/heads/<branch> on the remote, matched on the exact ref name. */
function remoteRefSha(remoteUrl, branch, env, gitBin, cwd) {
  const ref = `refs/heads/${branch}`;
  const out = git(['ls-remote', '--heads', remoteUrl, ref], { env, git: gitBin, cwd });
  const line = out.split('\n').map(l => l.trim()).find(l => l.endsWith('\t' + ref));
  const m = line && /^([0-9a-f]{40})\t/.exec(line);
  return m ? m[1] : null;
}

/**
 * Clones `branch` (depth 1) into workDir, or initialises an orphan branch when
 * it does not exist yet.
 * @returns {{workDir, branch, exists, baseSha, remoteUrl, env, serverUrl}}
 */
function prepareCheckout(p) {
  const serverUrl = (p.serverUrl || process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  const remoteUrl = `${serverUrl}/${p.repository}.git`;
  const env = authEnv(serverUrl, p.token);
  const workDir = p.workDir;
  rmrf(workDir);
  // Run from the temp dir, never from the caller's checkout (whose .git/config may carry credentials).
  const outside = ensureDir(path.dirname(workDir));

  let remoteSha;
  try {
    remoteSha = remoteRefSha(remoteUrl, p.branch, env, p.git, outside);
  } catch (e) {
    throw new Error(`cannot reach ${remoteUrl}: ${e.message}`);
  }

  if (remoteSha) {
    if (p.forceOrphan !== false && p.defaultBranch && p.branch === p.defaultBranch) {
      throw new Error(`publish-branch "${p.branch}" is the repository's default branch; refusing to rewrite it (use another branch, or force-orphan: false)`);
    }
    git(['clone', '--quiet', '--depth', '1', '--branch', p.branch, '--single-branch', remoteUrl, workDir], { env, git: p.git, cwd: outside });
    log(`Checked out ${p.repository}@${p.branch} (${remoteSha.slice(0, 7)}) into ${workDir}`);
    const target = p.targetDir ? path.join(workDir, normalizeTarget(p.targetDir)) : workDir;
    if (p.forceOrphan !== false && !exists(path.join(target, 'data', 'history.json')) && fs.readdirSync(workDir).some(n => n !== '.git')) {
      warning(`Branch ${p.branch} already has content but no dashboard history under ${p.targetDir || '/'}; its files are kept, but force-orphan squashes the branch history into a single commit. Set force-orphan: false to append commits instead.`);
    }
    return { workDir, branch: p.branch, exists: true, baseSha: remoteSha, remoteUrl, env, serverUrl };
  }
  git(['init', '--quiet', workDir], { git: p.git, cwd: outside });
  git(['checkout', '--quiet', '--orphan', p.branch], { cwd: workDir, git: p.git });
  git(['remote', 'add', 'origin', remoteUrl], { cwd: workDir, git: p.git });
  log(`Branch ${p.branch} does not exist yet on ${p.repository}; it will be created`);
  return { workDir, branch: p.branch, exists: false, baseSha: null, remoteUrl, env, serverUrl };
}

/**
 * Copies buildDir over `<workDir>/<targetDir>`, deletes `removedPaths` (relative
 * to targetDir), commits and pushes. `forceOrphan` replaces the branch history
 * with a single commit each time (keeps the repository small — old reports are
 * not kept in history); the push is `--force-with-lease` on the tip we cloned,
 * so a concurrent publish is never silently overwritten. When the remote moved,
 * the checkout is refreshed and `onRefresh(checkout)` — if given — rebuilds the
 * site on top of the new history before the retry.
 * @returns {{pushed: boolean, sha: string|null, changed: boolean}}
 */
async function commitAndPush(p) {
  const co = p.checkout;
  const targetRel = normalizeTarget(p.targetDir);
  const attempts = p.attempts || 3;
  const forceOrphan = p.forceOrphan !== false;
  const userName = p.userName || BOT_NAME;
  const userEmail = p.userEmail || BOT_EMAIL;
  const identity = ['-c', `user.name=${userName}`, '-c', `user.email=${userEmail}`];
  const message = p.message || 'Update build dashboard';
  let buildDir = p.buildDir;
  let removedPaths = p.removedPaths || [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    syncFiles(co.workDir, targetRel, buildDir, removedPaths);
    git(['add', '--all', '--', targetRel || '.'], { cwd: co.workDir, git: p.git });
    const status = git(['status', '--porcelain', '--untracked-files=all', '--', targetRel || '.'], { cwd: co.workDir, git: p.git }).trim();
    if (!status) {
      log('Site unchanged; nothing to publish');
      return { pushed: false, changed: false, sha: co.baseSha };
    }
    if (p.dryRun) {
      log(`[dry-run] would commit ${status.split('\n').length} change(s) to ${co.branch}`);
      return { pushed: false, changed: true, sha: null };
    }

    let sha;
    if (forceOrphan) {
      const tree = git(['write-tree'], { cwd: co.workDir, git: p.git }).trim();
      sha = git(identity.concat(['commit-tree', tree, '-m', message]), { cwd: co.workDir, git: p.git }).trim();
      git(['update-ref', `refs/heads/${co.branch}`, sha], { cwd: co.workDir, git: p.git });
    } else {
      git(identity.concat(['commit', '--quiet', '-m', message]), { cwd: co.workDir, git: p.git });
      sha = git(['rev-parse', 'HEAD'], { cwd: co.workDir, git: p.git }).trim();
    }

    try {
      if (forceOrphan) {
        // The lease makes "only over the tip we started from" atomic on the server.
        git(['push', '--quiet', `--force-with-lease=refs/heads/${co.branch}:${co.baseSha || ''}`, 'origin', `${sha}:refs/heads/${co.branch}`], { cwd: co.workDir, env: co.env, git: p.git });
      } else {
        git(['push', '--quiet', 'origin', `HEAD:refs/heads/${co.branch}`], { cwd: co.workDir, env: co.env, git: p.git });
      }
      log(`Published ${short(sha)} to ${co.branch}${targetRel ? '/' + targetRel : ''}`);
      return { pushed: true, changed: true, sha };
    } catch (e) {
      if (attempt >= attempts) throw new Error(`push to ${co.branch} failed after ${attempts} attempts: ${e.message}`);
      log(`Push rejected (${e.message}); re-syncing on top of the remote branch (attempt ${attempt + 1}/${attempts})`);
      await sleep(1000 * attempt);
      refreshFromRemote(co, p.git);
      if (p.onRefresh) {
        const r = await p.onRefresh(co);
        if (r && r.buildDir) buildDir = r.buildDir;
        if (r && Array.isArray(r.removedPaths)) removedPaths = r.removedPaths;
      }
    }
  }
  return { pushed: false, changed: true, sha: null };
}

function refreshFromRemote(co, gitBin) {
  const remote = remoteRefSha(co.remoteUrl, co.branch, co.env, gitBin, co.workDir);
  if (!remote) { co.baseSha = null; return; }
  git(['fetch', '--quiet', '--depth', '1', 'origin', co.branch], { cwd: co.workDir, env: co.env, git: gitBin });
  git(['reset', '--quiet', '--hard', 'FETCH_HEAD'], { cwd: co.workDir, git: gitBin });
  git(['update-ref', `refs/heads/${co.branch}`, 'FETCH_HEAD'], { cwd: co.workDir, git: gitBin });
  co.baseSha = remote;
  co.exists = true;
}

function syncFiles(workDir, targetRel, buildDir, removedPaths) {
  const target = targetRel ? path.join(workDir, targetRel) : workDir;
  ensureDir(target);
  for (const rel of removedPaths) {
    const abs = path.resolve(target, rel);
    if (!isWithin(target, abs)) { warning(`refusing to delete ${rel}: outside the site directory`); continue; }
    rmrf(abs);
    // Drop now-empty parent directories, staying inside the site directory.
    let dir = path.dirname(abs);
    while (isWithin(target, dir) && exists(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    }
  }
  copyDir(buildDir, target);
}

function normalizeTarget(t) {
  const s = String(t || '').replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '');
  if (s === '.' || s === '') return '';
  if (s.split('/').some(seg => seg === '..')) throw new Error(`publish-dir must stay inside the branch: ${t}`);
  return s;
}

function firstLine(e) {
  const stderr = e && e.stderr ? e.stderr.toString() : '';
  return (stderr.trim() || (e && e.message) || String(e)).split('\n').find(Boolean) || '';
}
function redact(s, secret) {
  let out = String(s || '').replace(/AUTHORIZATION: basic \S+/g, 'AUTHORIZATION: basic ***');
  if (secret) out = out.split(secret).join('***');
  return out;
}
function short(sha) { return sha ? sha.slice(0, 7) : '(none)'; }

module.exports = { prepareCheckout, commitAndPush, syncFiles, normalizeTarget, remoteRefSha, redact, BOT_NAME, BOT_EMAIL };
