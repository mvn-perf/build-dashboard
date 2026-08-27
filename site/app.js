/*
 * Build dashboard — single-page viewer for history.json.
 * Copyright (c) The mvn-perf Authors. Licensed under the Apache License, Version 2.0.
 *
 * Routes (hash):   #/                       overview: run durations per workflow
 *                  #/workflow/<id>          one workflow: durations + step stacks per job + runs table
 *                  #/run/<id>               one run: jobs/steps timeline, mvn-lens reports
 *                  #/maven                  every Maven build series (mvn-lens)
 *                  #/maven/<key>            one Maven build: build-time trend + all reports
 *
 * Everything user-controlled (step names, branch names, titles…) is inserted
 * with textContent — never innerHTML.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------------
  /** The dataset is plain JSON, or "gzip:" + base64(gzip(json)) for large sites (inflated natively). */
  function loadData() {
    var node = document.getElementById('build-dashboard-data');
    var raw = node ? (node.textContent || '').trim() : '';
    if (!raw) return Promise.resolve({ runs: [], workflows: {}, meta: {} });
    if (raw.indexOf('gzip:') !== 0) {
      try { return Promise.resolve(JSON.parse(raw)); } catch (e) { return Promise.resolve({ runs: [], workflows: {}, meta: {}, parseError: String(e) }); }
    }
    if (typeof DecompressionStream === 'undefined') {
      return Promise.resolve({ runs: [], workflows: {}, meta: {}, parseError: 'this browser cannot inflate the compressed dataset (DecompressionStream unsupported) — open data/history.json instead' });
    }
    var bytes;
    try {
      var bin = atob(raw.slice(5));
      bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch (e) {
      return Promise.resolve({ runs: [], workflows: {}, meta: {}, parseError: 'the embedded dataset is not valid base64 (' + String(e) + ') — open data/history.json instead' });
    }
    try {
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Response(stream).text().then(function (json) { return JSON.parse(json); })
        .catch(function (e) { return { runs: [], workflows: {}, meta: {}, parseError: String(e) }; });
    } catch (e) {
      return Promise.resolve({ runs: [], workflows: {}, meta: {}, parseError: String(e) });
    }
  }

  var DATA, META, RUNS, WORKFLOWS, REPO, REPO_URL, BY_ID, isSingleBranchDataset, FILTER_DEFAULTS, filters;

  function boot(data) {
  DATA = data;
  META = DATA.meta || {};
  RUNS = Array.isArray(DATA.runs) ? DATA.runs : [];
  WORKFLOWS = DATA.workflows || {};
  REPO = DATA.repository || '';
  REPO_URL = DATA.repositoryUrl || (REPO ? 'https://github.com/' + REPO : '');

  RUNS.forEach(function (r) {
    r.createdMs = Date.parse(r.createdAt) || 0;
    r.startedMs = Date.parse(r.startedAt) || r.createdMs;
    r.completedMs = Date.parse(r.completedAt) || null;
    r.jobs = r.jobs || [];
    r.mvnLens = r.mvnLens || [];
    r.jobs.forEach(function (j) {
      j.startedMs = Date.parse(j.startedAt) || null;
      j.completedMs = Date.parse(j.completedAt) || null;
      j.steps = j.steps || [];
      j.steps.forEach(function (s) { s.startedMs = Date.parse(s.startedAt) || null; s.completedMs = Date.parse(s.completedAt) || null; });
    });
    if (!WORKFLOWS[String(r.workflowId)]) WORKFLOWS[String(r.workflowId)] = { id: r.workflowId, name: r.workflowName, path: r.workflowPath };
  });
  RUNS.sort(function (a, b) { return b.createdMs - a.createdMs; });
  BY_ID = {};
  RUNS.forEach(function (r) { BY_ID[r.id] = r; });

  isSingleBranchDataset = uniq(RUNS.map(function (r) { return r.branch; })).length <= 1;
  FILTER_DEFAULTS = { range: '90d', branch: DATA.defaultBranch && !isSingleBranchDataset && RUNS.some(function (r) { return r.branch === DATA.defaultBranch; }) ? DATA.defaultBranch : '', event: '', status: '' };
  filters = loadFilters();
  }

  // ------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v; // only used with trusted constant markup
      else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    append(el, children);
    return el;
  }
  function append(el, children) {
    if (children === undefined || children === null || children === false) return el;
    if (Array.isArray(children)) { children.forEach(function (c) { append(el, c); }); return el; }
    el.appendChild(typeof children === 'string' || typeof children === 'number' ? document.createTextNode(String(children)) : children);
    return el;
  }
  function uniq(arr) { var s = {}; return arr.filter(function (x) { if (x === null || x === undefined) return false; if (s[x]) return false; s[x] = 1; return true; }); }
  function median(nums) { if (!nums.length) return null; var a = nums.slice().sort(function (x, y) { return x - y; }); var m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
  function percentile(nums, p) { if (!nums.length) return null; var a = nums.slice().sort(function (x, y) { return x - y; }); return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))]; }

  function fmtMs(ms) {
    if (ms === null || ms === undefined || isNaN(ms)) return '—';
    if (ms < 1000) return Math.round(ms) + ' ms';
    var s = ms / 1000;
    if (s < 60) return s.toFixed(1) + ' s';
    var total = Math.round(s);                       // round first, so 119.6 s is "2m 00s", never "1m 60s"
    var m = Math.floor(total / 60), rs = total % 60;
    if (m < 60) return m + 'm ' + (rs < 10 ? '0' : '') + rs + 's';
    var hh = Math.floor(m / 60);
    return hh + 'h ' + (m % 60) + 'm';
  }
  function fmtSecAxis(sec) {
    var total = Math.round(sec);
    if (total < 60) return total + 's';
    var m = Math.floor(total / 60), s = total % 60;
    if (m < 60) return m + 'm' + (s ? (s < 10 ? '0' : '') + s + 's' : '');
    return Math.floor(m / 60) + 'h' + (m % 60 ? (m % 60) + 'm' : '');
  }
  function fmtBytes(b) { if (!b) return '0 B'; var u = ['B', 'KB', 'MB', 'GB']; var i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return (i ? b.toFixed(1) : b) + ' ' + u[i]; }
  function fmtDate(ms) { if (!ms) return '—'; var d = new Date(ms); return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function fmtDateShort(ms) { var d = new Date(ms); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  function fmtDateTick(ms, spanMs) {
    var d = new Date(ms);
    if (spanMs < 2 * 86400000) return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    if (spanMs < 300 * 86400000) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
  }
  function fmtRel(ms) {
    var diff = Date.now() - ms; var m = Math.round(diff / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; var hh = Math.round(m / 60); if (hh < 48) return hh + ' h ago'; return Math.round(hh / 24) + ' days ago';
  }
  function shortSha(sha) { return sha ? sha.slice(0, 7) : ''; }
  function runState(r) { return r.status === 'completed' ? (r.conclusion || 'neutral') : 'running'; }
  function stateLabel(s) { return { success: 'Success', failure: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped', timed_out: 'Timed out', running: 'Running', neutral: 'Neutral', action_required: 'Action required', startup_failure: 'Startup failure', stale: 'Stale' }[s] || s; }
  function badge(state) { return h('span', { class: 'badge ' + state }, [h('span', { class: 'dot' }), stateLabel(state)]); }
  function link(href, text, cls, external) { return h('a', { href: href, class: cls || null, target: external ? '_blank' : null, rel: external ? 'noopener' : null }, text); }
  function runHref(r) { return '#/run/' + r.id; }
  function workflowHref(id) { return '#/workflow/' + id; }
  function mavenHref(key) { return '#/maven/' + encodeURIComponent(key); }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function withAlpha(hex, a) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex); if (!m) return hex;
    var n = parseInt(m[1], 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function stateColor(state) {
    if (state === 'success') return cssVar('--good');
    if (state === 'failure' || state === 'timed_out' || state === 'startup_failure') return cssVar('--critical');
    if (state === 'running') return cssVar('--series-1');
    if (state === 'action_required' || state === 'stale') return cssVar('--warning');
    return cssVar('--muted');
  }
  function seriesColors() { var c = []; for (var i = 1; i <= 8; i++) c.push(cssVar('--series-' + i)); return c; }

  // ------------------------------------------------------------------------
  // Filters (persisted per viewer)
  // ------------------------------------------------------------------------
  var RANGES = ['7d', '30d', '90d', '365d', 'all'];
  function loadFilters() {
    var f = Object.assign({}, FILTER_DEFAULTS);
    var saved = null;
    try { var raw = localStorage.getItem('build-dashboard.filters.' + REPO); if (raw) saved = JSON.parse(raw); } catch (e) { /* storage unavailable */ }
    if (saved && typeof saved === 'object') {
      // Only values that still exist in this dataset — a stale branch would hide every run behind "All branches".
      if (RANGES.indexOf(saved.range) >= 0) f.range = saved.range;
      if (saved.branch === '' || RUNS.some(function (r) { return r.branch === saved.branch; })) f.branch = saved.branch;
      if (saved.event === '' || RUNS.some(function (r) { return r.event === saved.event; })) f.event = saved.event;
      if (['', 'success', 'failure', 'completed'].indexOf(saved.status) >= 0) f.status = saved.status;
    }
    return f;
  }
  function saveFilters() { try { localStorage.setItem('build-dashboard.filters.' + REPO, JSON.stringify(filters)); } catch (e) { /* ignore */ } }
  function rangeMs(range) { return { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[range] ? { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[range] * 86400000 : null; }
  function filteredRuns(extra) {
    var since = rangeMs(filters.range); var cutoff = since ? Date.now() - since : 0;
    return RUNS.filter(function (r) {
      if (cutoff && r.createdMs < cutoff) return false;
      if (filters.branch && r.branch !== filters.branch) return false;
      if (filters.event && r.event !== filters.event) return false;
      if (filters.status === 'success' && runState(r) !== 'success') return false;
      if (filters.status === 'failure' && runState(r) !== 'failure') return false;
      if (filters.status === 'completed' && r.status !== 'completed') return false;
      if (extra && !extra(r)) return false;
      return true;
    });
  }

  function renderFilters(countText) {
    var branches = uniq(RUNS.map(function (r) { return r.branch; })).sort();
    var events = uniq(RUNS.map(function (r) { return r.event; })).sort();
    var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Date range' }, [['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['365d', '1 year'], ['all', 'All']].map(function (o) {
      return h('button', { type: 'button', class: filters.range === o[0] ? 'active' : null, text: o[1], onclick: function () { filters.range = o[0]; saveFilters(); render(); } });
    }));
    function select(name, label, options, current) {
      var sel = h('select', { 'aria-label': label, onchange: function () { filters[name] = sel.value; saveFilters(); render(); } },
        options.map(function (o) { return h('option', { value: o[0], selected: o[0] === current ? true : null, text: o[1] }); }));
      return h('label', null, [label, sel]);
    }
    return h('div', { class: 'filters' }, [
      seg,
      select('branch', 'Branch', [['', 'All branches']].concat(branches.map(function (b) { return [b, b]; })), filters.branch),
      select('event', 'Event', [['', 'All events']].concat(events.map(function (e) { return [e, e]; })), filters.event),
      select('status', 'Status', [['', 'Any status'], ['success', 'Successful'], ['failure', 'Failed'], ['completed', 'Completed']], filters.status),
      h('span', { class: 'count', text: countText || '' }),
    ]);
  }

  // ------------------------------------------------------------------------
  // Charts (Chart.js) — instances are destroyed on every re-render
  // ------------------------------------------------------------------------
  var charts = [];
  function destroyCharts() { charts.forEach(function (c) { try { c.destroy(); } catch (e) { /* ignore */ } }); charts = []; }
  function chartDefaults() {
    if (!window.Chart) return;
    Chart.defaults.font.family = cssVar('--font') || 'system-ui, sans-serif';
    Chart.defaults.font.size = 12;
    Chart.defaults.color = cssVar('--ink-2');
    Chart.defaults.borderColor = cssVar('--grid');
    Chart.defaults.animation = false;
    Chart.defaults.plugins.tooltip.backgroundColor = cssVar('--ink');
    Chart.defaults.plugins.tooltip.titleColor = cssVar('--page');
    Chart.defaults.plugins.tooltip.bodyColor = cssVar('--page');
    Chart.defaults.plugins.tooltip.padding = 8;
    Chart.defaults.plugins.tooltip.displayColors = false;
  }
  function chartBox(cls, label) { var canvas = h('canvas', { role: 'img', 'aria-label': label || 'chart' }); return { box: h('div', { class: 'chart ' + (cls || '') }, canvas), canvas: canvas }; }
  function makeChart(canvas, config) { if (!window.Chart) return null; var c = new Chart(canvas.getContext('2d'), config); charts.push(c); return c; }

  /** Run-duration-over-time chart: points coloured by conclusion, a thin line when the runs form one branch series. */
  function completedRuns(runs) { return runs.filter(function (r) { return r.durationMs !== null && r.durationMs !== undefined; }); }
  function durationChart(canvas, runs, opts) {
    var o = opts || {};
    var pts = completedRuns(runs)
      .map(function (r) { return { x: r.createdMs, y: r.durationMs / 1000, run: r }; })
      .sort(function (a, b) { return a.x - b.x; });
    if (!pts.length) return null;
    var oneBranch = filters.branch || isSingleBranchDataset || uniq(runs.map(function (r) { return r.branch; })).length === 1;
    var span = pts.length ? Math.max(1, pts[pts.length - 1].x - pts[0].x) : 1;
    var colors = pts.map(function (p) { return stateColor(runState(p.run)); });
    return makeChart(canvas, {
      type: 'line',
      data: { datasets: [{
        label: 'Duration', data: pts, parsing: false,
        // The line is a neutral guide: colour is reserved for the run's status (points).
        showLine: oneBranch, borderColor: withAlpha(cssVar('--axis'), 0.9), borderWidth: 2, tension: 0,
        pointBackgroundColor: colors, pointBorderColor: colors, pointRadius: o.small ? 3 : 4, pointHoverRadius: 7, pointHitRadius: 12,
      }] },
      options: {
        maintainAspectRatio: false, responsive: true,
        interaction: { mode: 'nearest', intersect: false },
        onClick: function (ev, els) { if (els.length) { var p = pts[els[0].index]; if (p) location.hash = runHref(p.run); } },
        onHover: function (ev, els) { ev.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        scales: {
          x: { type: 'linear', ticks: { maxTicksLimit: o.small ? 5 : 9, callback: function (v) { return fmtDateTick(v, span); } }, grid: { display: false }, border: { color: cssVar('--axis') } },
          y: { beginAtZero: true, ticks: { maxTicksLimit: 6, callback: fmtSecAxis }, grid: { color: cssVar('--grid') }, border: { display: false }, title: o.small ? undefined : { display: true, text: 'Run duration', color: cssVar('--muted') } },
        },
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          title: function (items) { var r = items[0].raw.run; return '#' + r.runNumber + ' · ' + (r.branch || '') + ' · ' + fmtDate(r.createdMs); },
          label: function (item) { var r = item.raw.run; return [fmtMs(r.durationMs) + ' · ' + stateLabel(runState(r)), (r.title || '').slice(0, 80)]; },
        } } },
      },
    });
  }
  function statusLegend(extraItems) {
    var items = [['success', 'Success'], ['failure', 'Failed'], ['cancelled', 'Cancelled'], ['running', 'Running']].map(function (s) {
      return h('span', { class: 'item' }, [h('span', { class: 'sw', style: { background: stateColor(s[0]) } }), s[1]]);
    });
    (extraItems || []).forEach(function (i) { items.push(i); });
    return h('div', { class: 'legend' }, items);
  }

  /** Stacked bars: one bar per run, one segment per step (top 7 by total time, rest folded into "Other steps"). */
  function stepStackChart(canvas, jobName, runsAsc) {
    var totals = {};
    var per = runsAsc.map(function (r) {
      var job = r.jobs.filter(function (j) { return j.name === jobName; })[0];
      var m = {};
      if (job) job.steps.forEach(function (s) { if (s.durationMs) { m[s.name] = (m[s.name] || 0) + s.durationMs; totals[s.name] = (totals[s.name] || 0) + s.durationMs; } });
      return { run: r, job: job, steps: m };
    });
    var names = Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; });
    var top = names.slice(0, 7);
    var rest = names.slice(7);
    var palette = seriesColors();
    var datasets = top.map(function (name, i) {
      return { label: name, backgroundColor: palette[i], borderColor: cssVar('--surface'), borderWidth: 1, data: per.map(function (p) { return (p.steps[name] || 0) / 1000; }), stepName: name };
    });
    if (rest.length) datasets.push({ label: 'Other steps (' + rest.length + ')', backgroundColor: cssVar('--muted'), borderColor: cssVar('--surface'), borderWidth: 1, data: per.map(function (p) { return rest.reduce(function (a, n) { return a + (p.steps[n] || 0); }, 0) / 1000; }), stepName: null, restNames: rest });
    var labels = per.map(function (p) { return '#' + p.run.runNumber; });
    // Non-visual alternative: the same breakdown as a list (screen readers, no-canvas).
    var alt = h('ul', { class: 'sr-only' }, names.slice(0, 12).map(function (n) { return h('li', { text: n + ': ' + fmtMs(totals[n]) + ' in total over ' + per.length + ' runs' }); }));
    canvas.parentNode.appendChild(alt);
    canvas.setAttribute('aria-label', 'Step durations of job ' + jobName + ' across ' + per.length + ' runs, stacked per step');
    var chart = makeChart(canvas, {
      type: 'bar',
      data: { labels: labels, datasets: datasets },
      options: {
        maintainAspectRatio: false, responsive: true,
        interaction: { mode: 'index', intersect: false },
        onClick: function (ev, els) { if (els.length) location.hash = runHref(per[els[0].index].run); },
        onHover: function (ev, els) { ev.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 20 }, border: { color: cssVar('--axis') } },
          y: { stacked: true, beginAtZero: true, ticks: { maxTicksLimit: 6, callback: fmtSecAxis }, grid: { color: cssVar('--grid') }, border: { display: false } },
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: false, padding: 12 } },
          tooltip: { callbacks: {
            title: function (items) { var p = per[items[0].dataIndex]; return '#' + p.run.runNumber + ' · ' + (p.run.branch || '') + ' · ' + fmtDate(p.run.createdMs); },
            label: function (item) { return item.dataset.label + ': ' + fmtMs(item.raw * 1000); },
            footer: function (items) { var p = per[items[0].dataIndex]; return p.job ? 'Job: ' + fmtMs(p.job.durationMs) + ' · ' + stateLabel(p.job.status === 'completed' ? p.job.conclusion || 'neutral' : 'running') : ''; },
          } },
        },
      },
    });
    return { chart: chart, top: top, rest: rest };
  }

  /** Maven metric over time for one series. */
  function mavenTrendChart(canvas, points, metric, opts) {
    var o = opts || {};
    var pts = points.filter(function (p) { return p.summary && p.summary[metric.key] !== null && p.summary[metric.key] !== undefined; })
      .map(function (p) { return { x: p.run.createdMs, y: metric.scale(p.summary[metric.key]), p: p }; })
      .sort(function (a, b) { return a.x - b.x; });
    if (!pts.length) return null;
    var span = pts.length ? Math.max(1, pts[pts.length - 1].x - pts[0].x) : 1;
    var colors = pts.map(function (q) { return (q.p.summary.status || 'OK') === 'OK' ? cssVar('--good') : cssVar('--critical'); });
    return makeChart(canvas, {
      type: 'line',
      data: { datasets: [{ label: metric.label, data: pts, parsing: false, showLine: true, borderColor: withAlpha(cssVar('--series-2'), 0.7), borderWidth: 2, tension: 0,
        pointBackgroundColor: colors, pointBorderColor: colors, pointRadius: o.small ? 2.5 : 4, pointHoverRadius: 7, pointHitRadius: 12 }] },
      options: {
        maintainAspectRatio: false, responsive: true,
        interaction: { mode: 'nearest', intersect: false },
        onClick: function (ev, els) { if (els.length) { var q = pts[els[0].index]; if (q) location.hash = runHref(q.p.run); } },
        onHover: function (ev, els) { ev.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        scales: {
          x: { type: 'linear', ticks: { maxTicksLimit: o.small ? 4 : 9, callback: function (v) { return fmtDateTick(v, span); }, display: !o.small }, grid: { display: false }, border: { color: cssVar('--axis'), display: !o.small } },
          y: { beginAtZero: true, ticks: { maxTicksLimit: 6, callback: metric.tick, display: !o.small }, grid: { color: cssVar('--grid'), display: !o.small }, border: { display: false }, title: o.small ? undefined : { display: true, text: metric.label, color: cssVar('--muted') } },
        },
        plugins: { legend: { display: false }, tooltip: { enabled: !o.small, callbacks: {
          title: function (items) { var r = items[0].raw.p.run; return '#' + r.runNumber + ' · ' + (r.branch || '') + ' · ' + fmtDate(r.createdMs); },
          label: function (item) { var s = item.raw.p.summary; return [metric.label + ': ' + metric.fmt(s[metric.key]), 'Maven ' + (s.goals || []).join(' ') + ' · ' + (s.status || '')]; },
        } } },
      },
    });
  }
  var MAVEN_METRICS = [
    { id: 'total', key: 'totalMs', label: 'Maven total time', scale: function (v) { return v / 1000; }, tick: fmtSecAxis, fmt: fmtMs },
    { id: 'wall', key: 'wallMs', label: 'Session wall-clock', scale: function (v) { return v / 1000; }, tick: fmtSecAxis, fmt: fmtMs },
    { id: 'cpu', key: 'cpuMs', label: 'CPU time', scale: function (v) { return v / 1000; }, tick: fmtSecAxis, fmt: fmtMs },
    { id: 'gc', key: 'gcMs', label: 'GC time', scale: function (v) { return v / 1000; }, tick: fmtSecAxis, fmt: fmtMs },
    { id: 'c2', key: 'c2Ms', label: 'JIT C2 compilation', scale: function (v) { return v / 1000; }, tick: fmtSecAxis, fmt: fmtMs },
    { id: 'download', key: 'downloadMs', label: 'Dependency downloads', scale: function (v) { return v / 1000; }, tick: fmtSecAxis, fmt: fmtMs },
    { id: 'tests', key: 'testMs', label: 'Test time (sum)', scale: function (v) { return v / 1000; }, tick: fmtSecAxis, fmt: fmtMs },
  ];

  // ------------------------------------------------------------------------
  // Maven series (mvn-lens) helpers
  // ------------------------------------------------------------------------
  function mavenKey(run, entry, report) {
    return [run.workflowPath || '', entry.jobName || '', entry.stepName || '', entry.label || report.label || ''].join(' ');
  }
  function mavenSeries(runs) {
    var map = {};
    runs.forEach(function (r) {
      r.mvnLens.forEach(function (e) {
        (e.reports || []).forEach(function (rep) {
          var key = mavenKey(r, e, rep);
          var s = map[key] || (map[key] = { key: key, workflowId: r.workflowId, workflowName: r.workflowName, workflowPath: r.workflowPath, jobName: e.jobName, stepName: e.stepName, label: e.label || rep.label || null, points: [] });
          s.points.push({ run: r, entry: e, report: rep, summary: rep.summary || null });
        });
      });
    });
    var list = Object.keys(map).map(function (k) { return map[k]; });
    list.forEach(function (s) { s.points.sort(function (a, b) { return b.run.createdMs - a.run.createdMs; }); });
    list.sort(function (a, b) { return (a.workflowName || '').localeCompare(b.workflowName || '') || (a.jobName || '').localeCompare(b.jobName || '') || (a.stepName || '').localeCompare(b.stepName || '') || (a.label || '').localeCompare(b.label || ''); });
    return list;
  }
  function seriesTitle(s) {
    var parts = [s.workflowName || s.workflowPath || 'workflow'];
    if (s.jobName) parts.push(s.jobName);
    var t = parts.join(' · ');
    if (s.stepName) t += ' › ' + s.stepName;
    if (s.label) t += ' · ' + s.label;
    return t;
  }

  // ------------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------------
  function viewOverview() {
    var runs = filteredRuns();
    var frag = document.createDocumentFragment();
    frag.appendChild(renderFilters(runs.length + ' run' + (runs.length === 1 ? '' : 's')));

    var durations = runs.filter(function (r) { return r.durationMs !== null; }).map(function (r) { return r.durationMs; });
    var completed = runs.filter(function (r) { return r.status === 'completed'; });
    var ok = completed.filter(function (r) { return r.conclusion === 'success'; }).length;
    var slowest = runs.reduce(function (a, r) { return r.durationMs !== null && (!a || r.durationMs > a.durationMs) ? r : a; }, null);
    var reports = 0; runs.forEach(function (r) { r.mvnLens.forEach(function (e) { reports += (e.reports || []).length; }); });
    frag.appendChild(h('div', { class: 'tiles' }, [
      tile('Runs', runs.length, null),
      tile('Success rate', completed.length ? Math.round(100 * ok / completed.length) + '%' : '—', completed.length ? (ok / completed.length >= 0.9 ? 'good' : ok / completed.length < 0.6 ? 'bad' : null) : null, completed.length ? ok + ' / ' + completed.length : null),
      tile('Median duration', fmtMs(median(durations)), null),
      tile('p90 duration', fmtMs(percentile(durations, 0.9)), null),
      tile('Slowest run', slowest ? h('a', { href: runHref(slowest), text: fmtMs(slowest.durationMs) }) : '—', null, slowest ? '#' + slowest.runNumber : null),
      tile('mvn-lens reports', reports, null, reports ? h('a', { href: '#/maven', text: 'Maven builds →' }) : null),
    ]));

    var ids = uniq(runs.map(function (r) { return String(r.workflowId); }));
    Object.keys(WORKFLOWS).forEach(function (id) { if (ids.indexOf(id) < 0 && RUNS.some(function (r) { return String(r.workflowId) === id; })) ids.push(id); });
    if (!ids.length) frag.appendChild(h('p', { class: 'empty', text: RUNS.length ? 'No runs match the current filters.' : 'No runs collected yet — the dashboard fills up as workflows run.' }));
    var cards = h('div', { class: 'cards' });
    ids.sort(function (a, b) { return (WORKFLOWS[a].name || '').localeCompare(WORKFLOWS[b].name || ''); }).forEach(function (id) {
      var wf = WORKFLOWS[id];
      var wruns = runs.filter(function (r) { return String(r.workflowId) === id; });
      var d = wruns.filter(function (r) { return r.durationMs !== null; }).map(function (r) { return r.durationMs; });
      var wc = wruns.filter(function (r) { return r.status === 'completed'; });
      var wok = wc.filter(function (r) { return r.conclusion === 'success'; }).length;
      var last = wruns[0];
      var done = completedRuns(wruns);
      var box = chartBox('', (wf.name || 'workflow') + ' run duration over time, ' + done.length + ' completed runs');
      var card = h('div', { class: 'card' }, [
        h('div', { class: 'card-head' }, [
          h('h2', null, h('a', { href: workflowHref(id), text: wf.name || wf.path || ('workflow ' + id) })),
          h('span', { class: 'dim small', text: wf.path || '' }),
          h('div', { class: 'stats' }, [
            h('span', null, [h('b', { text: String(wruns.length) }), ' runs']),
            h('span', null, ['median ', h('b', { text: fmtMs(median(d)) })]),
            h('span', null, ['success ', h('b', { text: wc.length ? Math.round(100 * wok / wc.length) + '%' : '—' })]),
            last ? h('span', null, ['last ', h('a', { href: runHref(last) }, badge(runState(last))), ' ', h('span', { class: 'dim', text: fmtRel(last.createdMs) })]) : null,
          ]),
        ]),
        done.length ? box.box : h('p', { class: 'empty', text: wruns.length ? 'No completed runs in range yet.' : 'No runs in range.' }),
        done.length ? statusLegend() : null,
      ]);
      cards.appendChild(card);
      if (done.length) requestAnimationFrame(function () { durationChart(box.canvas, wruns, {}); });
    });
    frag.appendChild(cards);
    return frag;
  }

  function tile(k, v, cls, sub) {
    return h('div', { class: 'tile' }, [h('div', { class: 'k', text: k }), h('div', { class: 'v ' + (cls || '') }, [typeof v === 'object' ? v : String(v), sub ? h('small', null, sub) : null])]);
  }

  function viewWorkflow(id) {
    var wf = WORKFLOWS[String(id)];
    if (!wf) return notFound('Workflow ' + id + ' is not in this dashboard.');
    var runs = filteredRuns(function (r) { return String(r.workflowId) === String(id); });
    var frag = document.createDocumentFragment();
    frag.appendChild(crumbs([['#/', 'Overview'], [null, wf.name || wf.path]]));
    frag.appendChild(h('div', { class: 'page-head' }, [
      h('div', { class: 'grow' }, [h('h1', { text: wf.name || wf.path }), h('div', { class: 'sub' }, [h('code', { text: wf.path || '' }), REPO_URL && wf.path ? [' · ', link(REPO_URL + '/actions/workflows/' + wf.path.split('/').pop(), 'GitHub Actions ↗', null, true)] : null])]),
    ]));
    frag.appendChild(renderFilters(runs.length + ' run' + (runs.length === 1 ? '' : 's')));
    if (!runs.length) { frag.appendChild(h('p', { class: 'empty', text: 'No runs match the current filters.' })); return frag; }

    var d = runs.filter(function (r) { return r.durationMs !== null; }).map(function (r) { return r.durationMs; });
    var wc = runs.filter(function (r) { return r.status === 'completed'; });
    var wok = wc.filter(function (r) { return r.conclusion === 'success'; }).length;
    var q = runs.filter(function (r) { return r.queueMs !== null; }).map(function (r) { return r.queueMs; });
    frag.appendChild(h('div', { class: 'tiles' }, [
      tile('Runs', runs.length), tile('Success rate', wc.length ? Math.round(100 * wok / wc.length) + '%' : '—', null, wc.length ? wok + ' / ' + wc.length : null),
      tile('Median duration', fmtMs(median(d))), tile('p90 duration', fmtMs(percentile(d, 0.9))), tile('Fastest', fmtMs(d.length ? Math.min.apply(null, d) : null)), tile('Median queue', fmtMs(median(q))),
    ]));

    var box = chartBox('tall', (wf.name || 'workflow') + ' run duration over time, ' + d.length + ' completed runs');
    frag.appendChild(h('section', null, [h('h2', { text: 'Run duration over time' }), h('div', { class: 'card' }, d.length ? [box.box, statusLegend()] : h('p', { class: 'empty', text: 'No completed runs in range yet.' }))]));
    if (d.length) requestAnimationFrame(function () { durationChart(box.canvas, runs, {}); });

    // Step durations per job (stacked bars, oldest → newest, capped for readability).
    var MAX_BARS = 60;
    var asc = runs.slice().sort(function (a, b) { return a.createdMs - b.createdMs; });
    var shown = asc.slice(-MAX_BARS);
    var jobNames = {};
    runs.forEach(function (r) { r.jobs.forEach(function (j) { jobNames[j.name] = (jobNames[j.name] || 0) + 1; }); });
    var names = Object.keys(jobNames).sort(function (a, b) { return jobNames[b] - jobNames[a] || a.localeCompare(b); });
    var sec = h('section', null, [h('h2', { text: 'Step durations per job' }), h('p', { class: 'sub', text: 'One bar per run (oldest to newest), one segment per step. The 7 steps with the most total time are shown individually; the rest fold into “Other steps”. Click a bar to open the run timeline.' + (asc.length > MAX_BARS ? ' Showing the last ' + MAX_BARS + ' of ' + asc.length + ' runs.' : '') })]);
    var grid = h('div', { class: 'cards' });
    names.forEach(function (name) {
      var jobs = runs.map(function (r) { return r.jobs.filter(function (j) { return j.name === name; })[0]; }).filter(Boolean);
      var jd = jobs.filter(function (j) { return j.durationMs !== null; }).map(function (j) { return j.durationMs; });
      var jok = jobs.filter(function (j) { return j.conclusion === 'success'; }).length;
      var b = chartBox('tall', 'Step durations of job ' + name);
      grid.appendChild(h('div', { class: 'card ' + (names.length === 1 ? 'wide' : '') }, [
        h('div', { class: 'card-head' }, [h('h2', { text: name }), h('div', { class: 'stats' }, [
          h('span', null, [h('b', { text: String(jobs.length) }), ' jobs']), h('span', null, ['median ', h('b', { text: fmtMs(median(jd)) })]), h('span', null, ['success ', h('b', { text: jobs.length ? Math.round(100 * jok / jobs.length) + '%' : '—' })]),
        ])]),
        b.box,
      ]));
      requestAnimationFrame(function () { stepStackChart(b.canvas, name, shown); });
    });
    sec.appendChild(grid);
    frag.appendChild(sec);

    frag.appendChild(h('section', null, [h('h2', { text: 'Runs' }), runsTable(runs, { workflow: false })]));
    return frag;
  }

  function runsTable(runs, opts) {
    var o = opts || {};
    var rows = runs.map(function (r) {
      var reports = 0; r.mvnLens.forEach(function (e) { reports += (e.reports || []).length; });
      return h('tr', null, [
        h('td', null, h('a', { href: runHref(r), text: '#' + r.runNumber })),
        o.workflow !== false ? h('td', null, h('a', { href: workflowHref(r.workflowId), text: r.workflowName || '' })) : null,
        h('td', { class: 'wrap' }, [r.title || '', r.attempt > 1 ? h('span', { class: 'dim small', text: ' (attempt ' + r.attempt + ')' }) : null]),
        h('td', null, badge(runState(r))),
        h('td', { class: 'num', text: fmtMs(r.durationMs) }),
        h('td', { class: 'num dim', text: fmtMs(r.queueMs) }),
        h('td', { text: r.branch || '' }),
        h('td', null, r.sha ? link(REPO_URL + '/commit/' + r.sha, shortSha(r.sha), 'sha', true) : ''),
        h('td', { class: 'dim', text: r.event || '' }),
        h('td', { class: 'dim', text: r.actor || '' }),
        h('td', { title: fmtDate(r.createdMs), text: fmtDate(r.createdMs) }),
        h('td', null, reports ? h('a', { href: runHref(r), class: 'chip', text: reports + ' mvn-lens' }) : ''),
        h('td', null, r.htmlUrl ? link(r.htmlUrl, 'GitHub ↗', null, true) : ''),
      ]);
    });
    return h('div', { class: 'table-wrap' }, h('table', null, [
      h('thead', null, h('tr', null, ['Run', o.workflow !== false ? 'Workflow' : null, 'Title', 'Status', 'Duration', 'Queue', 'Branch', 'Commit', 'Event', 'By', 'Started', 'Reports', ''].map(function (t) { return t === null ? null : h('th', { class: t === 'Duration' || t === 'Queue' ? 'num' : null, text: t }); }))),
      h('tbody', null, rows),
    ]));
  }

  function viewRun(id) {
    var r = BY_ID[id];
    if (!r) return notFound('Run ' + id + ' is not in this dashboard (it may have been pruned).');
    var frag = document.createDocumentFragment();
    var wf = WORKFLOWS[String(r.workflowId)] || {};
    frag.appendChild(crumbs([['#/', 'Overview'], [workflowHref(r.workflowId), wf.name || r.workflowName || 'workflow'], [null, '#' + r.runNumber]]));
    frag.appendChild(h('div', { class: 'page-head' }, [
      h('div', { class: 'grow' }, [
        h('h1', null, [(wf.name || r.workflowName || '') + ' #' + r.runNumber + ' ', badge(runState(r))]),
        h('div', { class: 'sub', text: r.title || '' }),
      ]),
      h('div', { class: 'actions' }, [r.htmlUrl ? link(r.htmlUrl, 'Open on GitHub ↗', null, true) : null]),
    ]));
    frag.appendChild(h('div', { class: 'card' }, h('div', { class: 'kv' }, [
      kv('Duration', fmtMs(r.durationMs)), kv('Queued', fmtMs(r.queueMs)), kv('Started', fmtDate(r.startedMs)), kv('Finished', r.completedMs ? fmtDate(r.completedMs) : '—'),
      kv('Branch', r.branch || '—'), kv('Commit', r.sha ? link(REPO_URL + '/commit/' + r.sha, shortSha(r.sha), 'sha', true) : '—'), kv('Event', r.event || '—'), kv('Triggered by', r.actor || '—'),
      kv('Attempt', String(r.attempt || 1)), kv('Jobs', String(r.jobs.length)),
    ])));

    frag.appendChild(h('section', null, [h('h2', { text: 'Timeline' }), h('p', { class: 'sub', text: 'Jobs and their steps, relative to the start of the run. Steps profiled with mvn-lens carry a report link; the orange bar under such a step is the Maven session itself.' }), timeline(r)]));

    var entries = r.mvnLens;
    var sec = h('section', null, [h('h2', { text: 'mvn-lens reports' })]);
    if (!entries.length) sec.appendChild(h('p', { class: 'empty', text: 'No mvn-lens report was attached to this run. Add the mvn-perf/build-dashboard/mvn-lens step after your Maven step to collect one.' }));
    else sec.appendChild(reportsTable(entries.map(function (e) { return { run: r, entry: e }; }), { run: false }));
    frag.appendChild(sec);
    return frag;
  }
  function kv(k, v) { return h('div', null, [h('span', { class: 'k', text: k }), h('span', { class: 'v' }, v)]); }

  /** HTML/CSS Gantt: label column + proportional bars, tooltip on hover. */
  function timeline(r) {
    var showSkipped = false;
    var wrap = h('div', { class: 'timeline' });
    var toolbar = h('div', { class: 'tl-toolbar' });
    var cb = h('input', { type: 'checkbox', onchange: function () { showSkipped = cb.checked; draw(); } });
    toolbar.appendChild(h('label', null, [cb, 'Show skipped steps']));
    var legend = h('span', { class: 'inline-list' }, [
      h('span', { class: 'item legend' }, [h('span', { class: 'sw rect', style: { background: cssVar('--bar-success') } }), 'success']),
      h('span', { class: 'item legend' }, [h('span', { class: 'sw rect', style: { background: cssVar('--critical') } }), 'failure']),
      h('span', { class: 'item legend' }, [h('span', { class: 'sw rect', style: { background: cssVar('--muted') } }), 'cancelled']),
      h('span', { class: 'item legend' }, [h('span', { class: 'sw rect', style: { background: 'repeating-linear-gradient(45deg, ' + cssVar('--series-1') + ' 0 3px, transparent 3px 6px)' } }), 'running']),
      h('span', { class: 'item legend' }, [h('span', { class: 'sw rect', style: { background: cssVar('--series-2'), height: '4px' } }), 'Maven session (mvn-lens)']),
    ]);
    toolbar.appendChild(legend);
    wrap.appendChild(toolbar);
    var scroll = h('div', { class: 'tl-scroll' });
    wrap.appendChild(scroll);

    var byJobStep = {};
    r.mvnLens.forEach(function (e) { if (e.jobId) { var k = e.jobId + ':' + (e.stepNumber || ''); (byJobStep[k] = byJobStep[k] || []).push(e); } });
    var unattributed = r.mvnLens.filter(function (e) { return !e.jobId; });

    function draw() {
      scroll.innerHTML = '';
      var t0 = r.startedMs, t1 = r.completedMs || 0;
      r.jobs.forEach(function (j) {
        if (j.startedMs && j.startedMs < t0) t0 = j.startedMs;
        if (j.completedMs && j.completedMs > t1) t1 = j.completedMs;
        j.steps.forEach(function (s) { if (s.completedMs && s.completedMs > t1) t1 = s.completedMs; });
      });
      if (!t1 || t1 <= t0) t1 = Math.max(t0 + 1000, Date.now());
      var span = t1 - t0;
      var grid = h('div', { class: 'tl-grid' });
      var axis = h('div', { class: 'tl-axis' });
      var step = niceTick(span);
      for (var t = 0; t <= span; t += step) axis.appendChild(h('span', { class: 't', style: { left: (100 * t / span) + '%' }, text: fmtSecAxis(t / 1000) }));
      grid.appendChild(h('div', { class: 'tl-axis-label', text: 'elapsed' }));
      grid.appendChild(axis);

      function track(cls, bars) {
        var tr = h('div', { class: 'tl-track' });
        for (var t = step; t < span; t += step) tr.appendChild(h('span', { class: 'tl-tick', style: { left: (100 * t / span) + '%' } }));
        bars.forEach(function (b) { tr.appendChild(b); });
        return tr;
      }
      function bar(start, end, cls, tip) {
        if (!start) return null;
        var e = end || Date.now();
        var left = Math.max(0, 100 * (start - t0) / span);
        var width = Math.max(0.15, 100 * (e - start) / span);
        var el = h('div', { class: 'tl-bar ' + cls, style: { left: left + '%', width: Math.min(width, 100 - left) + '%' }, role: 'img', 'aria-label': tip().textContent });
        attachTip(el, tip);
        return el;
      }
      r.jobs.forEach(function (j) {
        var jstate = j.status === 'completed' ? (j.conclusion || 'neutral') : (j.status || 'queued');
        var jl = h('div', { class: 'tl-label' }, [
          h('span', { class: 'name', title: j.name }, j.htmlUrl ? link(j.htmlUrl, j.name, null, true) : j.name),
          j.runnerName ? h('span', { class: 'dim small', text: j.labels && j.labels.length ? j.labels.join(', ') : '' }) : null,
          h('span', { class: 'dur', text: fmtMs(j.durationMs) }),
        ]);
        grid.appendChild(h('div', { class: 'tl-row job' }, [jl, track('job', [bar(j.startedMs, j.completedMs, jstate, function () { return tipContent(j.name, j.startedMs, j.completedMs, j.durationMs, stateLabel(jstate), (j.runnerName ? 'Runner: ' + j.runnerName : null)); })].filter(Boolean))]));
        j.steps.forEach(function (s) {
          if (!showSkipped && s.conclusion === 'skipped') return;
          var sstate = s.status === 'completed' ? (s.conclusion || 'neutral') : (s.status || 'queued');
          var entries = byJobStep[j.id + ':' + s.number] || [];
          var chips = [];
          entries.forEach(function (e) {
            (e.reports || []).forEach(function (rep, i) {
              var text = 'mvn-lens' + (e.label || rep.label ? ' · ' + (e.label || rep.label) : '') + ((e.reports.length > 1) ? ' #' + (i + 1) : '');
              chips.push(rep.path && !rep.removed ? h('a', { class: 'chip', href: rep.path, target: '_blank', rel: 'noopener', title: 'Open the mvn-lens report of this step', text: text + ' ↗' }) : h('span', { class: 'chip muted', title: 'The HTML report of this run is no longer kept on the site (keep-reports); its timings are still in the trend.', text: text }));
              chips.push(h('a', { class: 'small', href: mavenHref(mavenKey(r, e, rep)), title: 'Maven build-time trend of this step', text: 'trend' }));
            });
          });
          var sl = h('div', { class: 'tl-label' }, [h('span', { class: 'name', title: s.name, text: s.name }), chips, h('span', { class: 'dur', text: fmtMs(s.durationMs) })]);
          var bars = [bar(s.startedMs, s.completedMs, sstate, function () { return tipContent(s.name, s.startedMs, s.completedMs, s.durationMs, stateLabel(sstate), null); })];
          entries.forEach(function (e) {
            (e.reports || []).forEach(function (rep) {
              var sm = rep.summary;
              if (sm && sm.startedAt && sm.endedAt) {
                var a = Math.max(sm.startedAt, s.startedMs || sm.startedAt), b = Math.min(sm.endedAt, s.completedMs || sm.endedAt);
                if (b > a) bars.push(bar(a, b, 'mvn', function () { return tipContent('Maven ' + (sm.goals || []).join(' '), sm.startedAt, sm.endedAt, sm.totalMs || sm.wallMs, sm.status || '', (sm.moduleCount != null ? sm.moduleCount + ' module(s) · ' : '') + (sm.threads > 1 ? '-T' + sm.threads + ' ' : '') + (sm.builderId || '')); }));
              }
            });
          });
          grid.appendChild(h('div', { class: 'tl-row step' + (entries.length ? ' has-mvn' : '') }, [sl, track('step', bars.filter(Boolean))]));
        });
      });
      if (!r.jobs.length) grid.appendChild(h('div', { class: 'tl-label', style: { gridColumn: '1 / -1' }, text: 'No job information was recorded for this run.' }));
      if (unattributed.length) {
        var ul = h('div', { class: 'tl-label' }, [h('span', { class: 'name', text: 'mvn-lens reports not attributed to a step' })]);
        var chips = [];
        unattributed.forEach(function (e) { (e.reports || []).forEach(function (rep) { chips.push(rep.path && !rep.removed ? h('a', { class: 'chip', href: rep.path, target: '_blank', rel: 'noopener', text: (e.label || rep.label || e.artifactName) + ' ↗' }) : h('span', { class: 'chip muted', text: e.label || rep.label || e.artifactName })); }); });
        grid.appendChild(h('div', { class: 'tl-row step' }, [ul, h('div', { class: 'tl-track', style: { padding: '4px 8px' } }, chips)]));
      }
      scroll.appendChild(grid);
    }
    draw();
    return wrap;
  }
  function niceTick(spanMs) {
    var steps = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000, 7200000, 4 * 3600000, 8 * 3600000, 12 * 3600000, 24 * 3600000];
    for (var i = 0; i < steps.length; i++) if (spanMs / steps[i] <= 12) return steps[i];
    return Math.ceil(spanMs / 12 / 86400000) * 86400000;   // multi-day runs: whole days, at most ~12 labels
  }
  function tipContent(name, start, end, dur, state, extra) {
    return h('div', null, [h('b', { text: name }), h('div', { class: 'row' }, [h('span', { text: 'Duration' }), h('span', { text: fmtMs(dur) })]), h('div', { class: 'row' }, [h('span', { text: 'Started' }), h('span', { text: start ? new Date(start).toLocaleTimeString() : '—' })]), h('div', { class: 'row' }, [h('span', { text: 'Ended' }), h('span', { text: end ? new Date(end).toLocaleTimeString() : 'running' })]), state ? h('div', { class: 'row' }, [h('span', { text: 'Status' }), h('span', { text: state })]) : null, extra ? h('div', { class: 'dim', text: extra }) : null]);
  }
  var tipEl = null;
  function attachTip(el, content) {
    function show(ev) {
      if (!tipEl) { tipEl = h('div', { class: 'tl-tip' }); document.body.appendChild(tipEl); }
      tipEl.innerHTML = ''; tipEl.appendChild(content()); move(ev); tipEl.style.display = 'block';
    }
    function move(ev) { if (!tipEl) return; var x = ev.clientX + 14, y = ev.clientY + 14; if (x + 300 > window.innerWidth) x = ev.clientX - 310; tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px'; }
    function hide() { if (tipEl) tipEl.style.display = 'none'; }
    el.addEventListener('mouseenter', show); el.addEventListener('mousemove', move); el.addEventListener('mouseleave', hide);
    el.setAttribute('tabindex', '0'); el.addEventListener('focus', function (ev) { var b = el.getBoundingClientRect(); show({ clientX: b.left, clientY: b.bottom }); }); el.addEventListener('blur', hide);
  }

  function reportsTable(items, opts) {
    var o = opts || {};
    var rows = [];
    items.forEach(function (it) {
      var r = it.run, e = it.entry;
      (e.reports || []).forEach(function (rep) {
        var s = rep.summary || {};
        rows.push(h('tr', null, [
          o.run !== false ? h('td', null, [h('a', { href: runHref(r), text: '#' + r.runNumber }), ' ', h('span', { class: 'dim small', text: fmtDate(r.createdMs) })]) : null,
          o.run !== false ? h('td', { text: r.branch || '' }) : null,
          o.series !== false ? h('td', { class: 'wrap' }, [e.jobName || h('span', { class: 'dim', text: 'unattributed' }), e.stepName ? [' › ', e.stepName] : null, e.label || rep.label ? h('span', { class: 'dim', text: ' · ' + (e.label || rep.label) }) : null]) : null,
          h('td', null, s.status ? badge(s.status === 'OK' ? 'success' : 'failure') : h('span', { class: 'dim', text: '—' })),
          h('td', { class: 'mono small', text: s.goals ? s.goals.join(' ') + (s.threads > 1 ? ' -T' + s.threads : '') : '' }),
          h('td', { class: 'num', text: fmtMs(s.totalMs) }), h('td', { class: 'num dim', text: fmtMs(s.wallMs) }), h('td', { class: 'num dim', text: fmtMs(s.cpuMs) }), h('td', { class: 'num dim', text: fmtMs(s.gcMs) }), h('td', { class: 'num dim', text: fmtMs(s.c2Ms) }),
          h('td', { class: 'num dim', text: s.downloadMs ? fmtMs(s.downloadMs) + ' / ' + fmtBytes(s.downloadBytes) : '—' }),
          h('td', { class: 'num dim', text: s.moduleCount !== undefined ? String(s.moduleCount) : '' }),
          h('td', { class: 'dim small', text: [s.mavenVersion ? 'Maven ' + s.mavenVersion : null, s.jdkVersion ? 'JDK ' + s.jdkVersion : null, s.environment && s.environment.mvnd ? 'mvnd' : null].filter(Boolean).join(' · ') }),
          h('td', null, rep.path && !rep.removed ? h('a', { class: 'chip', href: rep.path, target: '_blank', rel: 'noopener', text: 'Open report ↗' }) : h('span', { class: 'chip muted', title: 'No longer kept on the site (keep-reports)', text: 'report expired' })),
          h('td', null, h('a', { href: mavenHref(mavenKey(r, e, rep)), text: 'trend' })),
        ]));
      });
    });
    var head = [o.run !== false ? 'Run' : null, o.run !== false ? 'Branch' : null, o.series !== false ? 'Job › step' : null, 'Maven', 'Goals', 'Total', 'Wall', 'CPU', 'GC', 'JIT C2', 'Downloads', 'Modules', 'Runtime', 'Report', ''];
    return h('div', { class: 'table-wrap' }, h('table', null, [h('thead', null, h('tr', null, head.map(function (t) { return t === null ? null : h('th', { class: ['Total', 'Wall', 'CPU', 'GC', 'JIT C2', 'Downloads', 'Modules'].indexOf(t) >= 0 ? 'num' : null, text: t }); }))), h('tbody', null, rows)]));
  }

  function viewMaven() {
    var runs = filteredRuns();
    var series = mavenSeries(runs);
    var frag = document.createDocumentFragment();
    frag.appendChild(crumbs([['#/', 'Overview'], [null, 'Maven builds']]));
    frag.appendChild(h('div', { class: 'page-head' }, [h('div', { class: 'grow' }, [h('h1', { text: 'Maven builds (mvn-lens)' }), h('div', { class: 'sub', text: 'Every workflow step that attached an mvn-lens report, with its Maven build-time trend. Click a series for the full trend and all its reports.' })])]));
    frag.appendChild(renderFilters(series.length + ' Maven build' + (series.length === 1 ? '' : 's')));
    if (!series.length) { frag.appendChild(h('p', { class: 'empty', text: RUNS.some(function (r) { return r.mvnLens.length; }) ? 'No Maven builds match the current filters.' : 'No mvn-lens reports collected yet. Add the mvn-perf/build-dashboard/mvn-lens step after your Maven step.' })); return frag; }
    var cards = h('div', { class: 'cards' });
    series.forEach(function (s) {
      var totals = s.points.filter(function (p) { return p.summary; }).map(function (p) { return p.summary.totalMs; });
      var last = s.points[0];
      var b = chartBox('short', 'Maven total time of ' + seriesTitle(s) + ', ' + totals.length + ' reports');
      cards.appendChild(h('div', { class: 'card' }, [
        h('div', { class: 'card-head' }, [h('h2', null, h('a', { href: mavenHref(s.key), text: seriesTitle(s) })), h('div', { class: 'stats' }, [
          h('span', null, [h('b', { text: String(s.points.length) }), ' reports']), h('span', null, ['last ', h('b', { text: last && last.summary ? fmtMs(last.summary.totalMs) : '—' })]), h('span', null, ['median ', h('b', { text: fmtMs(median(totals)) })]),
        ])]),
        totals.length ? b.box : h('p', { class: 'empty', text: 'No Maven timings in these reports.' }),
        totals.length ? h('div', { class: 'legend' }, [h('span', { class: 'item' }, [h('span', { class: 'sw', style: { background: cssVar('--good') } }), 'Maven OK']), h('span', { class: 'item' }, [h('span', { class: 'sw', style: { background: cssVar('--critical') } }), 'Maven failed']), h('span', { class: 'item dim', text: 'y: Maven total time' })]) : null,
      ]));
      if (totals.length) requestAnimationFrame(function () { mavenTrendChart(b.canvas, s.points, MAVEN_METRICS[0], { small: true }); });
    });
    frag.appendChild(cards);
    return frag;
  }

  var mavenMetric = 'total';
  function viewMavenSeries(key) {
    var all = mavenSeries(RUNS).filter(function (s) { return s.key === key; })[0];
    if (!all) return notFound('This Maven build series is not in the dashboard.');
    var runs = filteredRuns();
    var ids = {}; runs.forEach(function (r) { ids[r.id] = 1; });
    var s = Object.assign({}, all, { points: all.points.filter(function (p) { return ids[p.run.id]; }) });
    var frag = document.createDocumentFragment();
    frag.appendChild(crumbs([['#/', 'Overview'], ['#/maven', 'Maven builds'], [null, seriesTitle(s)]]));
    frag.appendChild(h('div', { class: 'page-head' }, [h('div', { class: 'grow' }, [h('h1', { text: seriesTitle(s) }), h('div', { class: 'sub' }, [h('a', { href: workflowHref(s.workflowId), text: s.workflowName || s.workflowPath || '' }), s.jobName ? ' · job ' : '', s.jobName ? h('code', { text: s.jobName }) : null, s.stepName ? ' · step ' : '', s.stepName ? h('code', { text: s.stepName }) : null])])]));
    frag.appendChild(renderFilters(s.points.length + ' report' + (s.points.length === 1 ? '' : 's')));
    if (!s.points.length) { frag.appendChild(h('p', { class: 'empty', text: 'No reports match the current filters.' })); return frag; }

    var sums = s.points.filter(function (p) { return p.summary; }).map(function (p) { return p.summary; });
    var totals = sums.map(function (x) { return x.totalMs; });
    var last = sums[0];
    frag.appendChild(h('div', { class: 'tiles' }, [
      tile('Reports', s.points.length), tile('Last total time', fmtMs(last ? last.totalMs : null), null, last ? 'Maven ' + (last.goals || []).join(' ') : null),
      tile('Median total', fmtMs(median(totals))), tile('Best', fmtMs(totals.length ? Math.min.apply(null, totals) : null)), tile('Worst', fmtMs(totals.length ? Math.max.apply(null, totals) : null)),
      tile('Maven OK', sums.length ? Math.round(100 * sums.filter(function (x) { return x.status === 'OK'; }).length / sums.length) + '%' : '—'),
    ]));

    var seg = h('div', { class: 'seg metric-seg', role: 'group', 'aria-label': 'Metric' }, MAVEN_METRICS.map(function (m) {
      return h('button', { type: 'button', class: mavenMetric === m.id ? 'active' : null, text: m.label, onclick: function () { mavenMetric = m.id; render(); } });
    }));
    var metric = MAVEN_METRICS.filter(function (m) { return m.id === mavenMetric; })[0] || MAVEN_METRICS[0];
    var hasMetric = s.points.some(function (p) { return p.summary && p.summary[metric.key] !== null && p.summary[metric.key] !== undefined; });
    var b = chartBox('tall', metric.label + ' of ' + seriesTitle(s) + ' over time');
    frag.appendChild(h('section', null, [h('h2', { text: 'Trend' }), h('div', { class: 'card' }, [seg, hasMetric ? b.box : h('p', { class: 'empty', text: 'No "' + metric.label + '" values in these reports.' }), h('div', { class: 'legend' }, [h('span', { class: 'item' }, [h('span', { class: 'sw', style: { background: cssVar('--good') } }), 'Maven OK']), h('span', { class: 'item' }, [h('span', { class: 'sw', style: { background: cssVar('--critical') } }), 'Maven failed']), h('span', { class: 'item dim', text: 'click a point to open the run' })])])]));
    if (hasMetric) requestAnimationFrame(function () { mavenTrendChart(b.canvas, s.points, metric, {}); });

    // Per-module wall time of the latest report, when modules are known (reactor builds).
    if (last && last.modules && last.modules.length > 1) {
      var mods = last.modules.slice().sort(function (a, b) { return b.wallMs - a.wallMs; }).slice(0, 15);
      frag.appendChild(h('section', null, [h('h2', { text: 'Slowest modules of the latest report' }), h('div', { class: 'table-wrap' }, h('table', null, [h('thead', null, h('tr', null, [h('th', { text: 'Module' }), h('th', { class: 'num', text: 'Wall-clock' }), h('th', { class: 'num', text: 'Forks' })])), h('tbody', null, mods.map(function (m) { return h('tr', null, [h('td', { text: m.name || m.artifactId || '' }), h('td', { class: 'num', text: fmtMs(m.wallMs) }), h('td', { class: 'num dim', text: String(m.forkCount || 0) })]); }))]))]));
    }

    frag.appendChild(h('section', null, [h('h2', { text: 'All reports' }), reportsTable(s.points.map(function (p) { return { run: p.run, entry: Object.assign({}, p.entry, { reports: [p.report] }) }; }), { series: false })]));
    return frag;
  }

  function crumbs(items) {
    var el = h('div', { class: 'crumbs' });
    items.forEach(function (it, i) { if (i) el.appendChild(h('span', { class: 'sep', text: '›' })); el.appendChild(it[0] ? h('a', { href: it[0], text: it[1] }) : h('span', { text: it[1] })); });
    return el;
  }
  function notFound(msg) { return h('div', null, [crumbs([['#/', 'Overview']]), h('p', { class: 'empty', text: msg })]); }

  // ------------------------------------------------------------------------
  // Shell + router
  // ------------------------------------------------------------------------
  function shell() {
    var app = document.getElementById('app');
    app.innerHTML = '';
    var nav = h('nav', null, [h('a', { href: '#/', 'data-route': 'overview', text: 'Overview' }), h('a', { href: '#/maven', 'data-route': 'maven', text: 'Maven builds' })]);
    app.appendChild(h('header', { class: 'top' }, [
      h('div', { class: 'brand' }, [h('a', { class: 'title', href: '#/', text: META.title || 'Build dashboard' }), REPO ? h('span', { class: 'repo' }, REPO_URL ? link(REPO_URL, REPO, null, true) : REPO) : null]),
      nav,
      h('div', { class: 'meta', title: META.generatedAt || '' }, ['Updated ', META.generatedAt ? fmtRel(Date.parse(META.generatedAt)) + ' · ' + fmtDate(Date.parse(META.generatedAt)) : '—']),
    ]));
    app.appendChild(h('main', { id: 'view' }));
    app.appendChild(h('footer', null, ['Generated by ', link('https://github.com/mvn-perf/build-dashboard', 'mvn-perf/build-dashboard', null, true), META.actionVersion ? ' v' + META.actionVersion : '', ' · ', link('data/history.json', 'history.json'), ' · ', RUNS.length + ' runs']));
    return nav;
  }

  var navEl = null;
  function render() {
    if (!navEl) navEl = shell();
    chartDefaults();
    destroyCharts();
    if (tipEl) tipEl.style.display = 'none';
    var hash = location.hash || '#/';
    var m;
    var view = document.getElementById('view');
    view.innerHTML = '';
    var route = 'overview';
    var content;
    try {
      if ((m = /^#\/workflow\/(\d+)/.exec(hash))) { content = viewWorkflow(m[1]); }
      else if ((m = /^#\/run\/(\d+)/.exec(hash))) { content = viewRun(Number(m[1])); }
      else if ((m = /^#\/maven\/(.+)$/.exec(hash))) { route = 'maven'; content = viewMavenSeries(decodeURIComponent(m[1])); }
      else if (/^#\/maven\/?$/.test(hash)) { route = 'maven'; content = viewMaven(); }
      else { content = viewOverview(); }
    } catch (e) {
      console.error(e);
      content = h('p', { class: 'empty', text: 'This view failed to render: ' + e.message });
    }
    if (DATA.parseError) view.appendChild(h('p', { class: 'empty', text: 'The embedded dataset could not be parsed: ' + DATA.parseError }));
    view.appendChild(content);
    Array.prototype.forEach.call(navEl.querySelectorAll('a'), function (a) { a.classList.toggle('active', a.getAttribute('data-route') === route); });
    document.title = (META.title || 'Build dashboard');
    try { window.scrollTo(0, 0); } catch (e) { /* non-browser environments */ }
  }

  loadData().then(function (data) {
    boot(data);
    window.addEventListener('hashchange', render);
    if (window.matchMedia) {
      try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render); } catch (e) { /* old browsers */ }
    }
    render();
    window.buildDashboard = { data: DATA, render: render, mavenSeries: mavenSeries, filteredRuns: filteredRuns };
  });
})();
