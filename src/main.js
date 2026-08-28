#!/usr/bin/env node
/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 *
 * Entry point of the "Build dashboard" action.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('./util');
const { GitHubApi } = require('./github-api');
const { loadHistory, normalizeHistory, prune, upsertRun, isValidReportPath } = require('./history');
const { collect } = require('./collect');
const { generateSite } = require('./site');
const { prepareCheckout, commitAndPush, normalizeTarget, redact } = require('./publish');

const { log, warning, getInput, getBooleanInput, getIntInput, parseList, setOutput, appendSummary, ensureDir, rmrf, exists, isWithin } = util;

function readInputs() {
  const repository = getInput('repository', { default: process.env.GITHUB_REPOSITORY || '' });
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error(`repository must be "owner/name", got "${repository}"`);
  const token = getInput('github-token', { default: process.env.GITHUB_TOKEN || '' });
  if (!token) throw new Error('github-token is required (default: ${{ github.token }})');

  const publish = getBooleanInput('publish', true);
  const publishBranch = getInput('publish-branch', { default: 'gh-pages' });
  if (publish && !publishBranch) throw new Error('publish-branch must name a branch (or set publish: false)');
  const outputDirInput = getInput('output-dir');
  const outputDir = path.resolve(outputDirInput || 'build-dashboard-site');

  const excludeWorkflows = parseList(getInput('exclude-workflows'));
  if (!getBooleanInput('include-self', false)) {
    const self = selfWorkflowPath();
    if (self) excludeWorkflows.push(self);
  }

  const runIds = parseList(getInput('run-id')).map(Number).filter(Number.isFinite);
  if (!runIds.length) {
    const triggering = triggeringRunId();
    if (triggering) runIds.push(triggering);
  }

  return {
    repository, token,
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    serverUrl: process.env.GITHUB_SERVER_URL || 'https://github.com',
    workflows: parseList(getInput('workflows')),
    excludeWorkflows,
    branches: parseList(getInput('branches')),
    events: parseList(getInput('events')),
    maxRuns: getIntInput('max-runs', 200, 1, 5000),
    lookbackDays: getIntInput('lookback-days', 90, 1, 3650),
    keepReports: getIntInput('keep-reports', 50, 0, 100000),
    artifactPrefix: getInput('mvn-lens-artifact-prefix', { default: 'mvn-lens--' }),
    downloadReports: getBooleanInput('download-reports', true),
    includeForkRuns: getBooleanInput('include-fork-runs', false),
    forceRefresh: getBooleanInput('force-refresh', false),
    concurrency: getIntInput('concurrency', 4, 1, 16),
    runIds,
    publish, publishBranch,
    publishDir: normalizeTarget(getInput('publish-dir', { default: '' })),
    forceOrphan: getBooleanInput('force-orphan', true),
    commitMessage: getInput('commit-message', { default: 'Update build dashboard' }),
    commitUserName: getInput('commit-user-name'),
    commitUserEmail: getInput('commit-user-email'),
    outputDir,
    outputDirGiven: !!outputDirInput,
    historyFile: getInput('history-file'),
    seedUrl: getInput('seed-url').replace(/\/+$/, ''),
    title: getInput('title'),
    siteUrl: getInput('site-url').replace(/\/+$/, ''),
    dryRun: getBooleanInput('dry-run', false),
  };
}

/** ".github/workflows/x.yml" of the workflow this action runs in (from GITHUB_WORKFLOW_REF). */
function selfWorkflowPath() {
  const ref = process.env.GITHUB_WORKFLOW_REF || '';
  const m = /^[^/]+\/[^/]+\/(.+?)@/.exec(ref);
  return m ? m[1] : null;
}

/** The run that triggered a `workflow_run` event, if any. */
function triggeringRunId() {
  try {
    if (process.env.GITHUB_EVENT_NAME !== 'workflow_run' || !process.env.GITHUB_EVENT_PATH) return null;
    const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    return ev && ev.workflow_run && Number.isFinite(ev.workflow_run.id) ? ev.workflow_run.id : null;
  } catch (e) {
    return null;
  }
}

function actionVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; } catch (e) { return null; }
}

/** Deletes `<base>/<rel>` only when it stays inside base (rel comes from history.json). */
function removeWithin(base, rel) {
  const abs = path.resolve(base, rel);
  if (!isWithin(base, abs) || abs === path.resolve(base)) { warning(`refusing to delete ${rel}: outside ${base}`); return; }
  rmrf(abs);
}

async function seedFromUrl(api, seedUrl, siteDir, repository) {
  const historyFile = path.join(siteDir, 'data', 'history.json');
  if (exists(historyFile)) return;
  log(`Seeding history from ${seedUrl}/data/history.json`);
  let fetched;
  try {
    fetched = await api.get(`${seedUrl}/data/history.json`, null, { noAuth: true, headers: { Accept: 'application/json' } });
  } catch (e) {
    warning(`seed-url: could not fetch ${seedUrl}/data/history.json (${e.message}); starting with an empty history`);
    return;
  }
  let history;
  try {
    history = normalizeHistory(fetched, repository);   // validates every report path before anything touches the disk
  } catch (e) {
    warning(`seed-url: history.json rejected (${e.message}); starting with an empty history`);
    return;
  }
  util.writeJson(historyFile, history);
  // Best-effort: mirror the report files the seeded history still links to.
  const paths = [];
  for (const run of history.runs) for (const e of run.mvnLens || []) for (const r of e.reports || []) if (r.path && !r.removed && isValidReportPath(r.path)) paths.push(r.path);
  let ok = 0;
  await util.mapLimit(paths, 4, async (rel) => {
    try {
      const r = await api.raw(`${seedUrl}/${rel}`, { noAuth: true, raw: true, headers: { Accept: '*/*' } });
      const file = path.resolve(siteDir, rel);
      if (!isWithin(siteDir, file)) return;
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, r.buffer);
      ok++;
    } catch (e) {
      util.debug(`seed-url: ${rel}: ${e.message}`);
    }
  });
  log(`Seeded ${history.runs.length} run(s) and ${ok}/${paths.length} report file(s) from the live site`);
}

async function resolveSiteUrl(api, inputs) {
  const suffix = inputs.publishDir ? inputs.publishDir + '/' : '';
  if (inputs.siteUrl) return inputs.siteUrl + '/' + suffix;
  try {
    // Needs `pages: read`; silently falls back to the github.io convention otherwise.
    const pages = await api.get(`/repos/${inputs.repository}/pages`);
    if (pages && pages.html_url) return pages.html_url.replace(/\/+$/, '') + '/' + suffix;
  } catch (e) { /* not permitted / not enabled */ }
  if (/github\.com$/.test(inputs.serverUrl)) {
    const [owner, name] = inputs.repository.split('/');
    const userSite = name.toLowerCase() === `${owner.toLowerCase()}.github.io`;
    return `https://${owner.toLowerCase()}.github.io/` + (userSite ? '' : name + '/') + suffix;
  }
  return null;
}

async function run() {
  const inputs = readInputs();
  const api = new GitHubApi({ token: inputs.token, apiUrl: inputs.apiUrl });
  const tmpRoot = process.env.RUNNER_TEMP || os.tmpdir();
  const stamp = Date.now().toString(36);
  const version = actionVersion();

  // Default branch (for the force-orphan guard and the dashboard's default filter) — best effort.
  let defaultBranch = null;
  try { defaultBranch = (await api.get(`/repos/${inputs.repository}`)).default_branch || null; } catch (e) { /* ignore */ }

  // ---- Where does the previous site live, where is the new one built? ------
  let checkout = null;
  let existingSiteDir;
  let buildDir;
  if (inputs.publish) {
    const workDir = path.join(tmpRoot, `build-dashboard-branch-${stamp}`);
    checkout = prepareCheckout({
      repository: inputs.repository, token: inputs.token, branch: inputs.publishBranch, workDir, serverUrl: inputs.serverUrl,
      forceOrphan: inputs.forceOrphan, defaultBranch, targetDir: inputs.publishDir,
    });
    existingSiteDir = inputs.publishDir ? path.join(workDir, inputs.publishDir) : workDir;
    buildDir = ensureDir(path.join(tmpRoot, `build-dashboard-site-${stamp}`));
  } else {
    existingSiteDir = inputs.outputDir;
    buildDir = ensureDir(inputs.outputDir);
    if (inputs.seedUrl) await seedFromUrl(api, inputs.seedUrl, buildDir, inputs.repository);
  }

  const historyFile = inputs.historyFile ? path.resolve(inputs.historyFile) : path.join(existingSiteDir, 'data', 'history.json');
  const history = loadHistory(historyFile, inputs.repository);
  log(`History: ${history.runs.length} run(s) loaded from ${exists(historyFile) ? historyFile : '(none)'}`);

  // ---- Collect --------------------------------------------------------------
  const collectOptions = {
    workflows: inputs.workflows, excludeWorkflows: inputs.excludeWorkflows, branches: inputs.branches, events: inputs.events,
    maxRuns: inputs.maxRuns, lookbackDays: inputs.lookbackDays, artifactPrefix: inputs.artifactPrefix,
    downloadReports: inputs.downloadReports, includeForkRuns: inputs.includeForkRuns, forceRefresh: inputs.forceRefresh,
    concurrency: inputs.concurrency, runIds: inputs.runIds,
  };
  util.group('Collecting workflow runs');
  const stats = await collect({ api, repository: inputs.repository, history, siteDir: buildDir, existingSiteDirs: [existingSiteDir], options: collectOptions });
  util.endGroup();

  // ---- Prune + generate (also re-run after a concurrent publish) -----------
  const siteUrl = await resolveSiteUrl(api, inputs);
  function pruneAndGenerate(h) {
    const { removedRuns, removedReportPaths } = prune(h, { maxRunsPerWorkflow: inputs.maxRuns, keepReports: inputs.keepReports });
    for (const rel of removedReportPaths) removeWithin(buildDir, rel);
    if (!inputs.publish) for (const rel of removedReportPaths) removeWithin(existingSiteDir, rel);
    if (removedRuns.length || removedReportPaths.length) log(`Pruned ${removedRuns.length} run(s) and ${removedReportPaths.length} report file(s)`);
    const out = generateSite({ history: h, siteDir: buildDir, title: inputs.title, actionVersion: version, siteUrl });
    log(`Generated ${out.indexFile} (${(out.bytes / 1024).toFixed(0)} KiB) with ${h.runs.length} run(s)`);
    return removedReportPaths;
  }
  let removedReportPaths = pruneAndGenerate(history);

  // ---- Publish --------------------------------------------------------------
  let published = { pushed: false, changed: false, sha: null };
  let finalHistory = history;
  if (inputs.publish) {
    published = await commitAndPush({
      checkout, buildDir, targetDir: inputs.publishDir, removedPaths: removedReportPaths,
      message: inputs.commitMessage, forceOrphan: inputs.forceOrphan, dryRun: inputs.dryRun,
      userName: inputs.commitUserName, userEmail: inputs.commitUserEmail,
      // Somebody else published meanwhile: merge what this invocation collected into THEIR history.
      onRefresh: async (co) => {
        const refreshedFile = path.join(inputs.publishDir ? path.join(co.workDir, inputs.publishDir) : co.workDir, 'data', 'history.json');
        const merged = loadHistory(refreshedFile, inputs.repository);
        merged.workflows = Object.assign({}, merged.workflows, history.workflows);
        merged.defaultBranch = history.defaultBranch || merged.defaultBranch;
        merged.repositoryUrl = history.repositoryUrl || merged.repositoryUrl;
        for (const r of stats.updatedRuns) upsertRun(merged, r);
        log(`Merged ${stats.updatedRuns.length} run(s) collected here into the concurrently published history (${merged.runs.length} runs)`);
        finalHistory = merged;
        removedReportPaths = pruneAndGenerate(merged);
        return { buildDir, removedPaths: removedReportPaths };
      },
    });
    if (inputs.outputDirGiven) {
      // Also expose the full site locally when the caller asked for an output dir explicitly.
      rmrf(inputs.outputDir);
      util.copyDir(existingSiteDir, ensureDir(inputs.outputDir), { skip: name => name === '.git' });
    }
    rmrf(buildDir);
  }

  const siteDir = inputs.publish ? (inputs.outputDirGiven ? inputs.outputDir : existingSiteDir) : buildDir;
  setOutput('site-dir', siteDir);
  setOutput('site-url', siteUrl || '');
  setOutput('runs-processed', stats.runsFetched);
  setOutput('runs-total', finalHistory.runs.length);
  setOutput('reports-collected', stats.reportsCollected);
  setOutput('published', published.pushed ? 'true' : 'false');
  setOutput('commit-sha', published.sha || '');

  await appendSummary([
    `### Build dashboard`,
    '',
    siteUrl ? `Site: ${siteUrl}` : `Site written to \`${siteDir}\``,
    '',
    `| Workflows | Runs seen | Runs fetched | Runs in history | mvn-lens reports collected | Fork runs skipped | API requests |`,
    `|---|---|---|---|---|---|---|`,
    `| ${stats.workflowsSelected} | ${stats.runsSeen} | ${stats.runsFetched} | ${finalHistory.runs.length} | ${stats.reportsCollected} | ${stats.forkRunsSkipped} | ${api.requests} |`,
    published.pushed ? `\nPublished commit \`${published.sha.slice(0, 7)}\` to \`${inputs.publishBranch}\`.` : (inputs.publish ? '\nNothing new to publish.' : ''),
  ].join('\n'));
  log(`Done: ${api.requests} API request(s), rate limit remaining ${api.rateLimitRemaining === null ? '?' : api.rateLimitRemaining}`);
  if (stats.errors) warning(`${stats.errors} run(s)/artifact(s) could not be processed; see the log above`);
}

if (require.main === module) {
  run().catch(e => {
    util.error(redact(e && e.stack ? e.stack : String(e)));
    process.exitCode = 1;
  });
}

module.exports = { run, readInputs, selfWorkflowPath, triggeringRunId, resolveSiteUrl };
