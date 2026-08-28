'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const util = require('../src/util');
const { GitHubApi, nextLink } = require('../src/github-api');
const { tmpDir } = require('./helpers');

test('getInput reads INPUT_<NAME> with hyphen and underscore spellings', () => {
  process.env['INPUT_GITHUB-TOKEN'] = 'a';
  process.env['INPUT_MAX_RUNS'] = ' 12 ';
  process.env['INPUT_FLAG'] = 'Yes';
  try {
    assert.equal(util.getInput('github-token'), 'a');
    assert.equal(util.getInput('max-runs'), '12');
    assert.equal(util.getIntInput('max-runs', 5, 1, 10), 10, 'clamped to max');
    assert.equal(util.getBooleanInput('flag', false), true);
    assert.equal(util.getBooleanInput('missing', true), true);
    assert.equal(util.getInput('missing', { default: 'd' }), 'd');
    assert.throws(() => util.getInput('missing', { required: true }), /required/);
    assert.deepEqual(util.parseList('a, b\n c ,,\n'), ['a', 'b', 'c']);
  } finally {
    delete process.env['INPUT_GITHUB-TOKEN']; delete process.env['INPUT_MAX_RUNS']; delete process.env['INPUT_FLAG'];
  }
});

test('setOutput writes heredoc-style records to GITHUB_OUTPUT', () => {
  const dir = tmpDir('out');
  const file = path.join(dir, 'out');
  fs.writeFileSync(file, '');
  process.env.GITHUB_OUTPUT = file;
  try {
    util.setOutput('site-url', 'https://x/\nsecond line');
  } finally { delete process.env.GITHUB_OUTPUT; }
  const s = fs.readFileSync(file, 'utf8');
  assert.match(s, /^site-url<<ghadelimiter_[\w-]+\r?\nhttps:\/\/x\/\r?\nsecond line\r?\nghadelimiter_[\w-]+/);
});

test('glob supports **, * and ? and literal paths', () => {
  const root = tmpDir('glob');
  for (const f of ['a/target/mvnlens/report.html', 'b/c/target/mvnlens/report.html', 'target/mvnlens/report.html', 'target/mvnlens/model.json', 'x.html']) {
    fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), f);
  }
  const rel = (list) => list.map(p => util.toPosix(path.relative(root, p))).sort();
  assert.deepEqual(rel(util.glob('**/target/mvnlens/report.html', root)), ['a/target/mvnlens/report.html', 'b/c/target/mvnlens/report.html', 'target/mvnlens/report.html']);
  assert.deepEqual(rel(util.glob('target/mvnlens/*.html', root)), ['target/mvnlens/report.html']);
  assert.deepEqual(rel(util.glob('?.html', root)), ['x.html']);
  assert.deepEqual(rel(util.glob('target/mvnlens/report.html', root)), ['target/mvnlens/report.html']);
  assert.deepEqual(rel(util.glob('nope/*.html', root)), []);
  assert.deepEqual(rel(util.glob(path.join(root, 'a', '**', '*.html'), root)), ['a/target/mvnlens/report.html']);
});

test('sanitizeName keeps artifact-safe characters only', () => {
  assert.equal(util.sanitizeName('JDK 21 · windows-latest / build:1'), 'JDK-21-windows-latest-build-1');
  assert.equal(util.sanitizeName('   '), 'unnamed');
  assert.equal(util.sanitizeName('a'.repeat(300), 10).length, 10);
});

test('GitHubApi paginates through Link headers, retries 5xx and waits on rate limits', async () => {
  const calls = [];
  let fail = 1;
  const fetch = async (url, init) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/flaky') {
      if (fail-- > 0) return resp(502, 'bad gateway');
      return resp(200, JSON.stringify({ ok: true }));
    }
    if (u.pathname === '/limited') {
      if (calls.filter(c => c.includes('/limited')).length === 1) return resp(403, JSON.stringify({ message: 'API rate limit exceeded' }), { 'x-ratelimit-remaining': '0', 'retry-after': '0' });
      return resp(200, JSON.stringify({ ok: true }));
    }
    const page = Number(u.searchParams.get('page') || 1);
    const headers = page < 3 ? { link: `<https://api.github.com/items?per_page=2&page=${page + 1}>; rel="next"` } : {};
    return resp(200, JSON.stringify({ items: [page * 10, page * 10 + 1] }), headers);
  };
  const api = new GitHubApi({ token: 't', fetch, maxAttempts: 3 });
  assert.deepEqual(await api.paginate('/items', {}, 'items'), [10, 11, 20, 21, 30, 31]);
  assert.deepEqual(await api.paginate('/items', {}, 'items', { max: 3 }), [10, 11, 20]);
  assert.deepEqual(await api.get('/flaky'), { ok: true });
  assert.deepEqual(await api.get('/limited'), { ok: true });
  assert.ok(calls[0].includes('per_page=100'));
  assert.equal(nextLink('<https://x/a?page=2>; rel="next", <https://x/a?page=9>; rel="last"'), 'https://x/a?page=2');
  assert.equal(nextLink('<https://x/a?page=1>; rel="prev"'), null);

  function resp(status, body, headers) {
    const h = new Map(Object.entries(Object.assign({ 'x-ratelimit-remaining': '10' }, headers || {})));
    return { status, ok: status < 300, headers: { get: k => h.get(k.toLowerCase()) || null }, text: async () => body, arrayBuffer: async () => Buffer.from(body).buffer };
  }
});
