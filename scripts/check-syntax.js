#!/usr/bin/env node
// Parses every shipped script (they run un-bundled on the runner's Node 20) and
// checks that the action manifests reference files that exist.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const files = ['src', 'mvn-lens', 'site', 'scripts'].flatMap(dir =>
  fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js')).map(f => path.join(dir, f)));
let failed = 0;
for (const f of files) {
  try {
    const src = fs.readFileSync(path.join(root, f), 'utf8').replace(/^#![^\n]*\n/, '\n');
    if (f.startsWith('site')) new vm.Script(src, { filename: f });
    else new vm.Script(`(function(){${src}\n})`, { filename: f });
    // Node 20 has no fs.glob / Array#toSorted usage guard: keep the surface conservative.
    if (/\bfs\.globSync\b|\btoSorted\(|\bObject\.groupBy\b|\bPromise\.withResolvers\b/.test(src)) throw new Error('uses an API newer than Node 20');
    console.log('ok  ' + f);
  } catch (e) {
    failed++;
    console.error('ERR ' + f + ': ' + e.message);
  }
}
for (const manifest of ['action.yml', 'mvn-lens/action.yml']) {
  const y = fs.readFileSync(path.join(root, manifest), 'utf8');
  const m = /main:\s*(\S+)/.exec(y);
  if (m && !fs.existsSync(path.join(root, path.dirname(manifest), m[1]))) { failed++; console.error(`ERR ${manifest}: main ${m[1]} missing`); }
  else console.log('ok  ' + manifest);
}
if (!fs.existsSync(path.join(root, 'site', 'vendor', 'chart.umd.min.js'))) { failed++; console.error('ERR site/vendor/chart.umd.min.js missing'); }
process.exit(failed ? 1 : 0);
