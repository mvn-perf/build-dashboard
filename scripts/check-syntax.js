#!/usr/bin/env node
// Parses every script — the sources, and the dist/ bundles the runner actually
// executes — and checks that the action manifests reference files that exist.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const files = ['src', 'mvn-lens', 'site', 'scripts', 'dist'].flatMap(dir =>
  fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js')).map(f => path.join(dir, f)) : []);
let failed = 0;
for (const f of files) {
  try {
    const src = fs.readFileSync(path.join(root, f), 'utf8').replace(/^#![^\n]*\n/, '\n');
    if (f.startsWith('site')) new vm.Script(src, { filename: f });
    else new vm.Script(`(function(){${src}\n})`, { filename: f });
    // Node 20 has no fs.glob / Array#toSorted usage guard: keep the surface of our own code conservative.
    if (!f.startsWith('dist') && /\bfs\.globSync\b|\btoSorted\(|\bObject\.groupBy\b|\bPromise\.withResolvers\b/.test(src)) throw new Error('uses an API newer than Node 20');
    console.log('ok  ' + f);
  } catch (e) {
    failed++;
    console.error('ERR ' + f + ': ' + e.message);
  }
}
// Every script a manifest runs (`main:` of a node action, `node "${{ github.action_path }}/…"`
// of a composite step) must exist relative to the manifest's directory — i.e. dist/ is built.
for (const manifest of ['action.yml', 'mvn-lens/action.yml']) {
  const y = fs.readFileSync(path.join(root, manifest), 'utf8');
  const refs = [];
  for (const m of y.matchAll(/^\s*main:\s*(\S+)/gm)) refs.push(m[1]);
  for (const m of y.matchAll(/node\s+"\$\{\{\s*github\.action_path\s*\}\}\/([^"]+)"/g)) refs.push(m[1]);
  const missing = refs.filter(r => !fs.existsSync(path.join(root, path.dirname(manifest), r)));
  if (!refs.length) { failed++; console.error(`ERR ${manifest}: no script reference found`); }
  else if (missing.length) { failed++; console.error(`ERR ${manifest}: ${missing.join(', ')} missing (run npm run build)`); }
  else console.log('ok  ' + manifest + ' -> ' + refs.join(', '));
}
if (!fs.existsSync(path.join(root, 'site', 'vendor', 'chart.umd.min.js'))) { failed++; console.error('ERR site/vendor/chart.umd.min.js missing'); }
process.exit(failed ? 1 : 0);
