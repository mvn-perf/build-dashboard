/*
 * Copyright (c) The mvn-perf Authors.
 * Licensed under the Apache License, Version 2.0.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir } = require('./util');
const { saveHistory } = require('./history');

const zlib = require('zlib');

const SITE_SRC = path.join(__dirname, '..', 'site');
/** Datasets above this many bytes are gzip-embedded (see generateSite). */
const DEFAULT_GZIP_THRESHOLD = 256 * 1024;

/**
 * Writes the self-contained dashboard: index.html (CSS, Chart.js, app JS and the
 * dataset all inlined), data/history.json and .nojekyll.
 *
 * @param {object} p
 * @param {object} p.history
 * @param {string} p.siteDir
 * @param {string} [p.title]
 * @param {string} [p.actionVersion]
 * @param {string} [p.siteUrl]
 */
function generateSite(p) {
  const siteDir = ensureDir(p.siteDir);
  const template = fs.readFileSync(path.join(SITE_SRC, 'index.template.html'), 'utf8');
  const css = fs.readFileSync(path.join(SITE_SRC, 'app.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(SITE_SRC, 'app.js'), 'utf8');
  const vendorJs = fs.readFileSync(path.join(SITE_SRC, 'vendor', 'chart.umd.min.js'), 'utf8');

  const title = p.title || `Build dashboard · ${p.history.repository || ''}`.trim();
  const dataset = Object.assign({}, p.history, {
    meta: {
      title,
      actionVersion: p.actionVersion || null,
      siteUrl: p.siteUrl || null,
      generatedAt: p.history.generatedAt || new Date().toISOString(),
    },
  });

  // Large datasets are embedded as "gzip:" + base64(gzip(json)) — roughly a tenth
  // of the size — and inflated in the browser with the native DecompressionStream.
  const threshold = p.gzipThreshold === undefined ? DEFAULT_GZIP_THRESHOLD : p.gzipThreshold;
  let payload = embedJson(dataset);
  if (threshold !== null && Buffer.byteLength(payload) > threshold) {
    payload = 'gzip:' + zlib.gzipSync(Buffer.from(JSON.stringify(dataset), 'utf8'), { level: 9 }).toString('base64');
  }

  const html = template
    .replace(/__TITLE__/g, () => escapeHtml(title))
    .replace('__APP_CSS__', () => css)
    .replace('__VENDOR_JS__', () => vendorJs)
    .replace('__DATA_JSON__', () => payload)
    .replace('__APP_JS__', () => appJs);

  fs.writeFileSync(path.join(siteDir, 'index.html'), html);
  fs.writeFileSync(path.join(siteDir, '.nojekyll'), '');
  saveHistory(path.join(siteDir, 'data', 'history.json'), p.history);
  return { indexFile: path.join(siteDir, 'index.html'), bytes: Buffer.byteLength(html) };
}

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * JSON that is safe inside <script type="application/json">: every "<" becomes
 * the < escape (still valid JSON), so neither "</script>" nor "<!--" can
 * occur; U+2028/U+2029 are escaped as well for JS-source-safety.
 */
function embedJson(obj) {
  return JSON.stringify(obj)
    .split('<').join('\\u003c')
    .split(LINE_SEPARATOR).join('\\u2028')
    .split(PARAGRAPH_SEPARATOR).join('\\u2029');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { generateSite, embedJson, escapeHtml };
