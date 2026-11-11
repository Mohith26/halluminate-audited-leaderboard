import { unpack, runAudits, estimate, rankIntervals, errorPosteriors, triage, predictor, PUBLISHED } from '../src/audit.js';

// ---- drawing helpers, same conventions as halluminate.ai/static/figures.js ----
const INK = '#14141c', TICK = '#57575d', GRID = '#dddddf', RULE = '#79797d', W = 774;
const HARNESS = { 'CU + TU': 'var(--harness-halluminate)', 'native CLI': 'var(--harness-native)' };
const HARNESS_SHAPE = { 'CU + TU': 'square', 'native CLI': 'circle' };
const EDGE = 'var(--viz-edge)';
const esc = (s) => String(s ?? '').split('&').join('&amp;').split('<').join('&lt;').split('"').join('&quot;');
const text = (x, y, s, size, fill, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${extra}>${esc(s)}</text>`;
const rect = (x, y, w, h, fill, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" style="fill:${fill}"${extra}/>`;
const line = (x1, y1, x2, y2, stroke, extra = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}"${extra}/>`;
function marker(shape, x, y, fill) {
  const style = ` style="fill:${fill};stroke:${EDGE};stroke-width:1"`;
  if (shape === 'square') return `<rect x="${x - 5}" y="${y - 5}" width="10" height="10"${style}/>`;
  if (shape === 'diamond') return `<rect x="${x - 4.5}" y="${y - 4.5}" width="9" height="9"${style} transform="rotate(45 ${x} ${y})"/>`;
  return `<circle cx="${x}" cy="${y}" r="5.5"${style}/>`;
}
function swatch(fill, shape) {
  if (shape) return `<svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">${marker(shape, 6, 6, fill)}</svg>`;
  return `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">${rect(0.5, 0.5, 9, 9, fill, ` stroke="${INK}" stroke-opacity="0.35"`)}</svg>`;
}
const legend = (items) => `<div class="chart-legend">${items.map((i) => `<span>${swatch(i[0], i[2])}${esc(i[1])}</span>`).join('')}</div>`;
const units = (b, s) => `<p class="chart-units"><b>${esc(b)}</b> ${esc(s)}</p>`;
const ciBar = (x, y1, y2) => line(x, y1, x, y2, INK, ' stroke-width="1.2"') + line(x - 4, y1, x + 4, y1, INK, ' stroke-width="1.2"') + line(x - 4, y2, x + 4, y2, INK, ' stroke-width="1.2"');
const $ = (s) => document.querySelector(s);
const f2 = (x) => x.toFixed(2), f3 = (x) => x.toFixed(3);
const cfgName = (P) => `${P.model} · ${P.harness}`;

// ---- published rows (anonymized) for the existing tabs ----
const DDB = [[61.4, 76, 23.1, 167, 5.97], [60.2, 67, 10.8, 113, 5.76], [60.6, 148, 44.8, 443, 27.96], [56.4, 279, 100.4, 503, 81.71], [54.9, 30, 5.5, 104, 15.15], [51.5, 180, 24.4, 228, 27.32], [53.8, 157, 18.7, 200, 104.85], [51.1, 35, 3.6, 34, 0.97], [51.1, 33, 3.3, 32, 6.05], [51.5, 94, 34.5, 430, 14.49], [43.9, 184, 21.1, 181, 2.91], [44.3, 66, 12.9, 120, 0.25], [42.0, 54, 10.8, 121, 7.66], [38.6, 72, 13.2, 96, 2.78], [41.7, 331, 71.0, 388, 8.09], [33.7, 95, 22.0, 236, 0.42], [25.8, 553, 111.9, 964, 81.87], [19.3, 378, 109.2, 424, 27.50]]
  .map((r, j) => ({ ...PUBLISHED[j], pass: r[0], steps: r[1], tokens: r[2], tools: r[3], cost: r[4], score: PUBLISHED[j].published }));

// ---- state ----
const BATCH = 60, MAXB = 40;
const TABS = [['audited', 'Audited'], ['histogram', 'Histogram'], ['scatter', '2D Plot'], ['table', 'Summary Table']];
const st = { tab: 'audited', batches: 5, strategy: 'active', seed: 7, config: -1, attempt: -1, check: -1, truth: false };
let B = null, RES = null, S = null;

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('halluminate.audit.v1') || '{}'); } catch {}
  const get = (k, d) => (p.has(k) ? p.get(k) : saved[k] ?? d);
  st.tab = TABS.some((t) => t[0] === get('tab', st.tab)) ? get('tab', st.tab) : 'audited';
  st.batches = Math.max(0, Math.min(MAXB, +get('batches', st.batches) || 0));
  st.strategy = get('strategy', st.strategy) === 'uniform' ? 'uniform' : 'active';
  st.seed = +get('seed', st.seed) || 7;
  st.config = p.has('config') ? +p.get('config') : -1;
  st.attempt = p.has('attempt') ? +p.get('attempt') : -1;
  st.check = p.has('check') ? +p.get('check') : -1;
  st.truth = p.get('truth') === '1';
}
function writeHash() {
  const p = new URLSearchParams({ tab: st.tab, batches: st.batches, strategy: st.strategy, seed: st.seed });
  if (st.config >= 0) p.set('config', st.config);
  if (st.attempt >= 0) p.set('attempt', st.attempt);
  if (st.check >= 0) p.set('check', st.check);
  if (st.truth) p.set('truth', '1');
  history.replaceState(null, '', '#' + p);
  try { localStorage.setItem('halluminate.audit.v1', JSON.stringify({ batches: st.batches, strategy: st.strategy, seed: st.seed, tab: st.tab })); } catch {}
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600); }

// ---- compute ----
function compute() {
  const t0 = performance.now();
  const run = runAudits(B, { batches: st.batches + 1, batchSize: BATCH, strategy: st.strategy, seed: st.seed });
  const log = run.log.slice(0, st.batches);
  const next = run.log[st.batches];
  const audited = new Set(log.flatMap((L) => L.drawn));
  let est;
  if (log.length) est = estimate(B, log);
  else est = estimate(B, [{ n: 1, pis: new Map(), drawn: [], pred: B.attempts.map((A) => A.s) }]).map((e) => ({ ...e, se: NaN, lo: NaN, hi: NaN }));
  const ranks = log.length ? rankIntervals(est) : est.map(() => ({ lo: NaN, hi: NaN, top: NaN }));
  const post = errorPosteriors(B, audited);
  const tri = triage(B, post);
  const { sd } = predictor(B, post);
  const queue = next.drawn.map((i) => ({ i, pi: next.pis.get(i), sd: sd[i] })).sort((a, b) => b.pi - a.pi);
  S = { log, next, audited, est, ranks, post, tri, queue, ms: performance.now() - t0 };
}

// ---- leaderboard views ----
function auditedView() {
  const rows = S.est.map((e, j) => ({ ...e, j })).sort((a, b) => (b.est - a.est));
  const base = 310, perTenth = 40, yOf = (v) => base - (v / 0.1) * perTenth;
  let svg = '';
  for (let t = 0; t <= 7; t++) { const y = base - t * perTenth; svg += rect(0, y, 762, 1, GRID) + text(0, y - 10, (t / 10).toFixed(1), 12, TICK); }
  const pitch = (762 - 53) / rows.length, bw = pitch - 10;
  rows.forEach((r, i) => {
    const x = 53 + i * pitch, cx = x + bw / 2, h = base - yOf(r.est);
    const sel = r.j === st.config;
    svg += `<g class="aud-col${sel ? ' is-sel' : ''}" data-config="${r.j}" tabindex="0" role="button" aria-label="${esc(cfgName(r))}: audited ${f3(r.est)}${Number.isFinite(r.lo) ? `, 95% interval ${f3(r.lo)} to ${f3(r.hi)}` : ''}, verifier ${f3(r.verifier)}"><title>${esc(cfgName(r))}: audited ${f3(r.est)}${Number.isFinite(r.lo) ? ` [${f3(r.lo)}, ${f3(r.hi)}]` : ''} · verifier ${f3(r.verifier)} · ${r.audits} audits</title>`;
    svg += rect(x - 4, 20, bw + 8, base - 20, sel ? 'rgba(135,206,235,0.18)' : 'transparent', ' class="aud-hit"');
    svg += rect(x, base - h, bw, h, HARNESS[r.harness]);
    if (Number.isFinite(r.lo)) svg += ciBar(cx, yOf(r.hi), yOf(r.lo));
    svg += marker('diamond', cx, yOf(r.verifier), '#ffffff');
    if (st.truth) svg += line(x - 3, yOf(r.truth), x + bw + 3, yOf(r.truth), '#c0392b', ' stroke-width="2"');
    const topY = Math.min(Number.isFinite(r.hi) ? yOf(r.hi) : base - h, yOf(r.verifier) - 6, base - h);
    svg += text(cx, topY - 8, f2(r.est), 12, INK, ' text-anchor="middle"');
    svg += text(cx + 6, base + 16, r.model, 10, TICK, ` text-anchor="end" transform="rotate(-30 ${cx + 6} ${base + 16})"`);
    svg += '</g>';
  });
  const leg = [[HARNESS['native CLI'], 'native CLI'], [HARNESS['CU + TU'], 'CU + TU'], ['#ffffff', 'Verifier score (as published)', 'diamond']];
  const cov = S.est.filter((e) => e.lo <= e.truth && e.truth <= e.hi).length;
  return {
    html: `<div class="chart-scroll"><svg viewBox="0 0 ${W} 399" role="img" aria-label="Audited mean score with 95% intervals by configuration">${svg}</svg></div>
      <div>${units('Audited mean score', `Unbiased estimate from ${S.audited.size} expert audits, 95% intervals; diamonds are the verifier-graded scores`)}${legend(leg)}</div>
      <div class="aud-controls">
        <div class="chart-tabs aud-alloc" role="tablist" aria-label="Audit allocation"><button type="button" role="tab" data-strategy="active" aria-selected="${st.strategy === 'active'}">Active audits</button><button type="button" role="tab" data-strategy="uniform" aria-selected="${st.strategy === 'uniform'}">Uniform spot-checks</button></div>
        <label class="aud-check"><input type="checkbox" class="checkbox" id="aud-truth" ${st.truth ? 'checked' : ''}> Show hidden truth <span>(simulation only${st.truth && S.log.length ? `: ${cov} of 18 intervals cover it` : ''})</span></label>
      </div>
      ${summaryTable()}`,
    caption: S.log.length
      ? `Sorted by audited score. ${S.audited.size} of ${B.attempts.length.toLocaleString()} attempts audited by experts (${(100 * S.audited.size / B.attempts.length).toFixed(1)}%); mean 95% interval ±${f3(mean(S.est.map((e) => 1.96 * e.se)))}. Click a column or row for its audits.`
      : 'No audits yet: bars show verifier scores. Approve the first expert batch below to start.',
  };
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function summaryTable() {
  const rows = S.est.map((e, j) => ({ ...e, j, rank: S.ranks[j] })).sort((a, b) => b.est - a.est);
  const head = ['Configuration', 'Harness', 'Verifier', 'Audited', '95% interval', 'Shift', 'Rank', 'Audits'];
  return `<div class="chart-scroll aud-tablewrap"><table class="lb-table aud-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => {
    const shift = r.est - r.verifier, ok = Number.isFinite(r.lo);
    return `<tr data-config="${r.j}" tabindex="0" class="${r.j === st.config ? 'is-sel' : ''}"><td>${esc(r.model)}</td><td><i style="background:${HARNESS[r.harness]}"></i>${r.harness}</td><td>${f3(r.verifier)}</td><td>${f3(r.est)}</td><td>${ok ? `${f3(r.lo)} to ${f3(r.hi)}` : '—'}</td><td class="${shift < -0.005 ? 'aud-neg' : ''}">${ok ? (shift >= 0 ? '+' : '') + f3(shift) : '—'}</td><td>${ok ? (r.rank.lo === r.rank.hi ? r.rank.lo : `${r.rank.lo}–${r.rank.hi}`) : '—'}</td><td>${r.audits}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function histogramView() {
  const base = 310, perTenth = 40, yOf = (v) => base - (v / 0.1) * perTenth;
  let svg = '';
  for (let t = 0; t <= 7; t++) { const y = base - t * perTenth; svg += rect(0, y, 762, 1, GRID) + text(0, y - 10, (t / 10).toFixed(1), 12, TICK); }
  const pitch = (762 - 53) / DDB.length, bw = pitch - 10;
  DDB.forEach((r, i) => {
    const x = 53 + i * pitch, h = base - yOf(r.score), cx = x + bw / 2;
    svg += `<rect x="${x}" y="${base - h}" width="${bw}" height="${h}" style="fill:${HARNESS[r.harness]}"><title>${esc(cfgName(r))}: ${f2(r.score)} mean score, $${r.cost.toFixed(2)} per run</title></rect>`;
    svg += text(cx, base - h - 15, f2(r.score), 12, INK, ' text-anchor="middle"');
    svg += text(cx, base - 10, '$' + r.cost.toFixed(2), bw < 40 ? 9 : 10, r.harness === 'native CLI' ? '#ffffff' : INK, ' text-anchor="middle"');
    svg += text(cx + 6, base + 16, r.model, 10, TICK, ` text-anchor="end" transform="rotate(-30 ${cx + 6} ${base + 16})"`);
  });
  return { html: `<div class="chart-scroll"><svg viewBox="0 0 ${W} 399" role="img" aria-label="Mean score by model and harness">${svg}</svg></div><div>${units('Mean score', 'Average mean score and cost per task (USD)')}${legend([[HARNESS['CU + TU'], 'CU + TU'], [HARNESS['native CLI'], 'native CLI']])}</div>`, caption: 'Mean score by model and harness, as published (models anonymized). Labels inside bars show average cost per run (USD).' };
}
function scatterView() {
  const LO = 0.2, HI = 150, x0 = 56, x1 = 742, top = 20, base = 338, sMin = 0.2, sMax = 0.65;
  const xOf = (c) => x0 + (Math.log(HI / c) / Math.log(HI / LO)) * (x1 - x0), yOf = (s) => base - ((s - sMin) / (sMax - sMin)) * (base - top);
  let svg = '';
  for (let p = 2; p <= 6; p++) { const y = yOf(p / 10); svg += rect(x0, y, x1 - x0, 1, GRID) + text(0, y + 4, p * 10 + '%', 12, TICK); }
  [100, 50, 20, 10, 5, 2, 1, 0.5, 0.2].forEach((c) => { svg += rect(xOf(c), top, 1, base - top, GRID) + text(xOf(c), 362, '$' + (c < 1 ? c.toFixed(2) : c), 12, TICK, ' text-anchor="middle"'); });
  svg += text(x1, 392, 'Average cost per run (USD, log scale), cheaper to the right', 14, TICK, ' text-anchor="end"');
  const models = [...new Set(DDB.map((r) => r.model))];
  for (const m of models) { const pts = DDB.filter((r) => r.model === m); svg += `<polyline fill="none" stroke-width="1.5" style="stroke:var(--viz-context)" points="${pts.map((r) => xOf(r.cost) + ',' + yOf(r.score)).join(' ')}"/>`; }
  DDB.forEach((r) => { svg += `<g><title>${esc(cfgName(r))}: ${Math.round(r.score * 100)}% mean score, $${r.cost.toFixed(2)} per run</title>${marker(HARNESS_SHAPE[r.harness], xOf(r.cost), yOf(r.score), HARNESS[r.harness])}</g>`; });
  const halo = ' stroke="#ffffff" stroke-width="4" stroke-linejoin="round" paint-order="stroke"';
  for (const m of models) { const r = DDB.find((x) => x.model === m && x.harness === 'native CLI'); svg += text(xOf(r.cost) + 12, yOf(r.score) + 4, m, 12, INK, ` text-anchor="start"${halo}`); }
  return { html: `<div class="chart-scroll"><svg viewBox="0 0 ${W} 400" role="img" aria-label="Mean score versus average cost per run">${svg}</svg></div>${units('', 'Mean score (%) vs. average cost per run (USD, log scale)')}${legend(Object.keys(HARNESS).map((h) => [HARNESS[h], h, HARNESS_SHAPE[h]]))}`, caption: 'Mean score versus average cost. Lines connect the same model across harnesses; they are not a Pareto frontier.' };
}
function tableView() {
  const head = ['Model', 'Harness', 'Pass rate (%)', 'Mean score', 'Avg steps', 'Avg tokens (M)', 'Avg tool calls', 'Avg cost ($)'];
  return { html: `<div class="chart-scroll"><table class="lb-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${DDB.map((r) => `<tr><td>${esc(r.model)}</td><td><i style="background:${HARNESS[r.harness]}"></i>${r.harness}</td><td>${Math.round(r.pass)}</td><td>${f2(r.score)}</td><td>${r.steps}</td><td>${r.tokens.toFixed(1)}</td><td>${r.tools}</td><td>${r.cost.toFixed(2)}</td></tr>`).join('')}</tbody></table></div>`, caption: 'All 18 configurations in source order (models anonymized). Harness swatches match the histogram and the 2D plot.' };
}

function renderBoard() {
  const views = { audited: auditedView, histogram: histogramView, scatter: scatterView, table: tableView };
  const v = views[st.tab]();
  $('#board').innerHTML = `<div class="chart-body"><p class="chart-title">Westworld Finance Diligence Benchmark Leaderboard</p>
    <div class="chart-tabs" role="tablist" aria-label="Leaderboard views">${TABS.map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${st.tab === k}">${l}${k === 'audited' ? '<sup class="aud-new">New</sup>' : ''}</button>`).join('')}</div>
    <div class="chart-view" data-figure-view>${v.html}</div></div>
    <p class="chart-caption" ${v.caption ? '' : 'hidden'}>${esc(v.caption || '')}</p><p class="chart-source">Source: Halluminate · Due Diligence Bench (published scores); audited view: concept, synthetic audits</p>`;
}

// ---- config drill-down ----
function renderDrill() {
  const el = $('#drill');
  if (st.config < 0 || st.tab !== 'audited') { el.innerHTML = ''; return; }
  const j = st.config, e = S.est[j], P = PUBLISHED[j];
  const mine = [...S.audited].filter((i) => B.attempts[i].config === j).sort((a, b) => (B.attempts[b].s - B.attempts[b].S) - (B.attempts[a].s - B.attempts[a].S));
  const flips = (i) => { const A = B.attempts[i]; return B.byTask[A.task].filter((cid, k) => B.checks[cid].kind === 'agentic' && A.ver[k] !== A.tru[k]).length; };
  const byCat = {};
  for (const i of mine) { const A = B.attempts[i], c = B.tasks[A.task].cat; (byCat[c] ||= { n: 0, d: 0 }); byCat[c].n++; byCat[c].d += A.S - A.s; }
  let detail = '';
  if (st.attempt >= 0 && B.attempts[st.attempt]?.config === j) {
    const A = B.attempts[st.attempt];
    detail = `<div class="aud-sub"><p class="aud-subtitle">Task ${A.task + 1} · ${esc(B.tasks[A.task].cat)} · attempt ${A.a + 1}: verifier ${f3(A.s)}, expert ${f3(A.S)}</p>
      <table class="lb-table aud-mini"><thead><tr><th>Check</th><th>Kind</th><th>Weight</th><th>Verifier</th><th>Second judge</th><th>Expert</th></tr></thead><tbody>${B.byTask[A.task].map((cid, k) => { const c = B.checks[cid], bad = c.kind === 'agentic' && A.ver[k] !== A.tru[k]; return `<tr class="${bad ? 'aud-flip' : ''}"><td>${c.kind === 'agentic' ? esc(c.family) : 'deterministic'} #${cid}</td><td>${c.kind === 'agentic' ? 'agentic' : 'exact'}</td><td>${(100 * c.w).toFixed(1)}%</td><td>${fmtV(A.ver[k])}</td><td>${c.kind === 'agentic' ? fmtV(A.ver2[k]) : '—'}</td><td>${fmtV(A.tru[k])}${bad ? (A.ver[k] > A.tru[k] ? ' · false pass' : ' · false fail') : ''}</td></tr>`; }).join('')}</tbody></table></div>`;
  }
  el.innerHTML = `<div class="lc-fig aud-drill"><div class="aud-drillhead"><span class="lc-title">${esc(cfgName(P))}</span><button type="button" class="aud-x" id="aud-close" aria-label="Close configuration">Close</button></div>
    <div class="aud-stats"><div><span>Verifier score</span><b>${f3(e.verifier)}</b></div><div><span>Audited score</span><b>${f3(e.est)}</b></div><div><span>95% interval</span><b>${Number.isFinite(e.lo) ? `${f3(e.lo)} to ${f3(e.hi)}` : '—'}</b></div><div><span>Audited attempts</span><b>${mine.length} of ${e.N}</b></div></div>
    ${Object.keys(byCat).length ? `<p class="aud-note">Mean expert minus verifier on audited attempts, by category: ${Object.entries(byCat).map(([c, v]) => `${esc(c)} ${(v.d / v.n >= 0 ? '+' : '') + f3(v.d / v.n)} (${v.n})`).join(' · ')}</p>` : '<p class="aud-note">No attempts from this configuration have been audited yet.</p>'}
    ${mine.length ? `<div class="chart-scroll aud-tablewrap"><table class="lb-table aud-table"><thead><tr><th>Task</th><th>Category</th><th>Attempt</th><th>Verifier</th><th>Expert</th><th>Difference</th><th>Checks wrong</th></tr></thead><tbody>${mine.slice(0, 12).map((i) => { const A = B.attempts[i], d = A.S - A.s; return `<tr data-attempt="${i}" tabindex="0" class="${i === st.attempt ? 'is-sel' : ''}"><td>${A.task + 1}</td><td>${esc(B.tasks[A.task].cat)}</td><td>${A.a + 1}</td><td>${f3(A.s)}</td><td>${f3(A.S)}</td><td class="${d < -0.005 ? 'aud-neg' : ''}">${(d >= 0 ? '+' : '') + f3(d)}</td><td>${flips(i)}</td></tr>`; }).join('')}</tbody></table></div>${mine.length > 12 ? `<p class="aud-note">Showing the 12 audits with the largest verifier overstatement of ${mine.length}.</p>` : ''}` : ''}
    ${detail}</div>`;
}
const fmtV = (v) => (v === 1 ? 'pass' : v === 0 ? 'fail' : (100 * v).toFixed(0) + '%');

// ---- queue ----
function renderQueue() {
  const q = S.queue, full = st.batches >= MAXB;
  const dis = (i) => { const A = B.attempts[i]; return B.byTask[A.task].filter((cid, k) => B.checks[cid].kind === 'agentic' && A.ver[k] !== A.ver2[k]).length; };
  $('#queue').innerHTML = `<p class="aud-lede">Batch ${st.batches + 1}: ${q.length} attempts drawn ${st.strategy === 'active' && st.batches > 0 ? 'with probability proportional to their predicted verifier error (judges disagreeing, checks with false passes so far)' : 'uniformly at random (pilot batch)'}. Approving sends them to experts; their grades update every interval above.</p>
    <div class="aud-actions"><button type="button" class="cta" id="aud-approve" ${full ? 'disabled' : ''}>Approve batch ${st.batches + 1} →</button><button type="button" class="text-button" id="aud-export">Export queue (CSV)</button><button type="button" class="text-button" id="aud-undo" ${st.batches ? '' : 'disabled'}>Undo last batch</button><button type="button" class="text-button" id="aud-reset" ${st.batches ? '' : 'disabled'}>Reset</button><span class="aud-meta">${S.audited.size} audited · computed in ${Math.max(1, Math.round(S.ms))} ms · keys: a approve, u undo</span></div>
    <div class="chart-scroll aud-tablewrap"><table class="lb-table aud-table"><thead><tr><th>Task</th><th>Category</th><th>Configuration</th><th>Verifier</th><th>Judges disagree</th><th>Inclusion prob.</th><th>Predicted error</th></tr></thead><tbody>${q.slice(0, 10).map((x) => { const A = B.attempts[x.i]; return `<tr><td>${A.task + 1} · try ${A.a + 1}</td><td>${esc(B.tasks[A.task].cat)}</td><td>${esc(cfgName(PUBLISHED[A.config]))}</td><td>${f3(A.s)}</td><td>${dis(x.i)}</td><td>${(100 * x.pi).toFixed(1)}%</td><td>±${f3(x.sd)}</td></tr>`; }).join('')}</tbody></table></div>
    <p class="aud-note">Showing the 10 most likely of ${q.length}. The export has all of them with their inclusion probabilities, which the estimator needs.</p>`;
}

// ---- triage ----
function renderTriage() {
  if (!S.audited.size) { $('#triage').innerHTML = '<p class="aud-lede">No audits yet. Verifier error rates appear after the first batch.</p>'; return; }
  const top = S.tri.slice(0, 10);
  const flagged = S.tri.filter((x) => x.pWeak > 0.5).length;
  const sel = st.check >= 0 ? S.tri.find((x) => x.id === st.check) : null;
  $('#triage').innerHTML = `<p class="aud-lede">${flagged} agentic checks are more likely than not to pass work an expert fails more than 20% of the time. Fix or reweight these first; each row is one task's rubric check.</p>
    <div class="aud-actions"><button type="button" class="text-button" id="aud-tri-export">Export triage (CSV)</button></div>
    <div class="chart-scroll aud-tablewrap"><table class="lb-table aud-table"><thead><tr><th>Task</th><th>Check</th><th>Weight</th><th>Audited fails</th><th>False passes</th><th>False-pass rate</th><th>P(rate &gt; 20%)</th></tr></thead><tbody>${top.map((x) => `<tr data-check="${x.id}" tabindex="0" class="${x.id === st.check ? 'is-sel' : ''}"><td>${x.task + 1} · ${esc(B.tasks[x.task].cat)}</td><td>${esc(x.family)} #${x.id}</td><td>${(100 * x.w).toFixed(1)}%</td><td>${x.nNeg}</td><td>${x.fp}</td><td>${(100 * x.fpr).toFixed(0)}%</td><td><span class="aud-pbar"><i style="width:${(100 * x.pWeak).toFixed(0)}%"></i></span>${(100 * x.pWeak).toFixed(0)}%</td></tr>`).join('')}</tbody></table></div>
    ${sel ? checkDetail(sel) : ''}`;
}
function checkDetail(x) {
  const ex = [...S.audited].filter((i) => B.attempts[i].task === x.task).map((i) => { const A = B.attempts[i], k = B.byTask[A.task].indexOf(x.id); return { i, A, k }; }).filter((o) => o.A.tru[o.k] === 0);
  return `<div class="aud-sub"><p class="aud-subtitle">${esc(x.family)} check #${x.id} on task ${x.task + 1}: ${x.fp} false passes in ${x.nNeg} audited fails; posterior false-pass rate ${(100 * x.fpr).toFixed(0)}%${st.truth ? ` (simulated truth ${(100 * x.trueFpr).toFixed(0)}%)` : ''}.</p>
    <table class="lb-table aud-mini"><thead><tr><th>Configuration</th><th>Attempt</th><th>Verifier</th><th>Second judge</th><th>Expert</th></tr></thead><tbody>${ex.slice(0, 8).map((o) => `<tr class="${o.A.ver[o.k] === 1 ? 'aud-flip' : ''}"><td>${esc(cfgName(PUBLISHED[o.A.config]))}</td><td>${o.A.a + 1}</td><td>${fmtV(o.A.ver[o.k])}</td><td>${fmtV(o.A.ver2[o.k])}</td><td>fail</td></tr>`).join('')}</tbody></table></div>`;
}

// ---- efficiency chart (the post's line-figure component: lc-fig, Focus toggles, edge + ln) ----
const SERIES = [['active', 'Calibrated verifier + active audits', ''], ['calibratedUniform', 'Calibrated verifier + uniform audits', '7 5'], ['ppiRaw', 'Raw verifier + uniform audits', '3 3'], ['expertOnly', 'Expert audits only', '1 4']];
let focus = 'active';
function renderEff() {
  const C = RES.curves, X0 = 64, X1 = 898, T = 34, Bm = 372, maxA = 600, maxY = 0.15;
  const xOf = (a) => X0 + (a / maxA) * (X1 - X0), yOf = (v) => Bm - (Math.min(v, maxY) / maxY) * (Bm - T);
  let svg = '';
  for (let v = 0; v <= maxY + 1e-9; v += 0.05) { const y = yOf(v).toFixed(1); svg += `<line x1="${X0}" y1="${y}" x2="${X1}" y2="${y}" stroke="#dddddf" stroke-width="1"/><text x="55" y="${+y + 4}" font-size="13" fill="#57575d" text-anchor="end">±${v.toFixed(2)}</text>`; }
  for (let a = 0; a <= 600; a += 120) { const x = xOf(a).toFixed(1); svg += `<line x1="${x}" y1="${T}" x2="${x}" y2="${Bm}" stroke="#dddddf" stroke-width="1"/><text x="${x}" y="392" font-size="13" fill="#57575d" text-anchor="middle">${a}</text>`; }
  svg += `<line x1="${X0}" y1="${T}" x2="${X0}" y2="${Bm}" stroke="#bcbcbe" stroke-width="1"/><line x1="${X0}" y1="${Bm}" x2="${X1}" y2="${Bm}" stroke="#bcbcbe" stroke-width="1"/>`;
  svg += `<line x1="${xOf(300)}" y1="${T}" x2="${xOf(300)}" y2="${Bm}" stroke="#9a9a9e" stroke-dasharray="3 3" stroke-width="1"/><text x="${xOf(300) + 7}" y="48" font-size="12.5" fill="#9a9a9e">300 audits (6.3% of attempts)</text>`;
  svg += `<text x="481" y="412" font-size="14" fill="#14141c" text-anchor="middle">Expert audits (attempts graded by an expert, of 4,752)</text><text x="18" y="203" font-size="14" fill="#14141c" text-anchor="middle" transform="rotate(-90 18 203)">Mean 95% interval half-width</text>`;
  const order = [...SERIES].sort((a, b) => (a[0] === focus) - (b[0] === focus));
  for (const [k, label, dash] of order) {
    const pts = C[k].filter((c) => c.halfWidth <= maxY).map((c) => `${xOf(c.audits).toFixed(1)},${yOf(c.halfWidth).toFixed(1)}`).join(' ');
    const hl = k === focus ? ' hl' : '';
    const da = dash ? ` stroke-dasharray="${dash}"` : '';
    svg += `<polyline points="${pts}" fill="none"${da} stroke-linejoin="round" stroke-linecap="round" opacity="0.92" stroke-width="4.1" class="edge${hl}"/><polyline points="${pts}" fill="none"${da} stroke-linejoin="round" stroke-linecap="round" opacity="0.92" stroke-width="2.6" class="ln${hl}"/>`;
    const p300 = C[k].find((c) => c.audits === 300);
    if (p300 && p300.halfWidth <= maxY) svg += `<circle cx="${xOf(300)}" cy="${yOf(p300.halfWidth)}" r="3.5" class="pt${hl}"/>`;
    const last = C[k].filter((c) => c.halfWidth <= maxY).slice(-1)[0];
    if (k === focus && last) svg += `<text x="${xOf(last.audits) - 4}" y="${yOf(last.halfWidth) + 20}" text-anchor="end" class="flabel">${esc(label)} · ±${p300.halfWidth.toFixed(3)} at 300</text>`;
  }
  if (S.log.length) { const hw = mean(S.est.map((e) => 1.96 * e.se)), x = xOf(Math.min(600, S.audited.size)), y = yOf(hw); svg += marker('diamond', x, y, '#ffffff') + `<text x="${x + 10}" y="${y - 10}" class="flabel">this session: ${S.audited.size} audits, ±${hw.toFixed(3)}</text>`; }
  const a3 = RES.summary.at300;
  $('#eff').innerHTML = `<div class="lc-fig aud-lc"><div class="lc-title">Interval width as expert audits grow</div>
    <div style="padding:2px 4px 8px"><span class="mtog-lbl">Focus</span>${SERIES.map(([k, l]) => `<button type="button" class="mtog" data-focus="${k}" aria-pressed="${k === focus}">${esc(l)}</button>`).join('')}</div>
    <div class="lc-body"><svg class="pc-svg" viewBox="0 0 920 438" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" role="img" aria-label="Mean 95% interval half-width versus expert audits for four methods">${svg}</svg></div>
    <div class="aud-lclegend">${SERIES.map(([k, l, d]) => `<span><svg width="26" height="8" aria-hidden="true"><line x1="1" y1="4" x2="25" y2="4" stroke="${k === focus ? 'var(--sky)' : 'var(--viz-context)'}" stroke-width="2.6"${d ? ` stroke-dasharray="${d}"` : ''}/></svg>${esc(l)}</span>`).join('')}</div>
    <p class="fig-source">Each point averages 40 simulated audit runs; lines differ only in how audits are chosen and what they correct. Source: concept, synthetic replica of Due Diligence Bench</p></div>
    <p class="aud-note">At 300 audits: ±${a3.halfWidth.active.toFixed(3)} with active audits, ${a3.narrowerThanExpertOnly}x narrower than averaging expert grades alone (±${a3.halfWidth.expertOnly.toFixed(3)}) and ${a3.narrowerThanPpiRawPct}% narrower than correcting the raw verifier with uniform audits, which needs about ${a3.ppiRawAuditsToMatch} audits to match. Intervals covered the hidden truth ${(100 * a3.coverage200reps).toFixed(1)}% of the time over 200 replays.</p>`;
}

function renderMethod() {
  const n = RES.summary.naive;
  $('#method').innerHTML = `<p>Each attempt gets a calibrated prediction of its expert grade: every agentic check's verdict, plus a second judge's verdict, is converted to the probability the check truly passed using that check's false-pass and false-fail rates (Beta posteriors from audits so far, pooled toward the check family). Before each batch, attempts are drawn with probability proportional to the predicted error of that prediction (Neyman allocation, with a uniform floor). The score for a configuration is the mean prediction plus the inverse-probability-weighted mean of expert-minus-prediction on the audited attempts; because predictions and probabilities are fixed before each batch, the estimate is unbiased whatever the posteriors are, and batch errors add as martingale differences.</p>
    <p>In this replica the published verifier scores overstate the hidden truth by ${n.meanInflation.toFixed(3)} on average and up to ${n.maxInflation.toFixed(3)}; ${n.configsMovingRank} configurations sit at a different rank. Weak checks inflate weaker configurations more, because false passes can only happen on work that should fail.</p>`;
}

function renderAll() {
  renderBoard(); renderDrill(); renderQueue(); renderTriage(); renderEff(); renderMethod(); writeHash();
}

// ---- actions ----
function csv(name, rows) {
  const s = rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([s], { type: 'text/csv' })); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  toast('Exported ' + name);
}
function exportQueue() {
  csv(`audit-batch-${st.batches + 1}.csv`, [['attempt_index', 'task', 'category', 'attempt', 'configuration', 'verifier_score', 'inclusion_probability', 'predicted_error_sd'], ...S.queue.map((x) => { const A = B.attempts[x.i]; return [x.i, A.task + 1, B.tasks[A.task].cat, A.a + 1, cfgName(PUBLISHED[A.config]), A.s.toFixed(4), x.pi.toFixed(6), x.sd.toFixed(4)]; })]);
}
function exportTriage() {
  csv('verifier-triage.csv', [['check_id', 'task', 'category', 'family', 'weight', 'audited_fails', 'false_passes', 'posterior_false_pass_rate', 'p_rate_gt_20pct'], ...S.tri.map((x) => [x.id, x.task + 1, B.tasks[x.task].cat, x.family, x.w.toFixed(4), x.nNeg, x.fp, x.fpr.toFixed(4), x.pWeak.toFixed(4)])]);
}
function setBatches(b, msg) {
  st.batches = Math.max(0, Math.min(MAXB, b));
  $('#app').classList.add('is-busy');
  requestAnimationFrame(() => setTimeout(() => { compute(); renderAll(); $('#app').classList.remove('is-busy'); if (msg) toast(msg); }, 10));
}

function bind() {
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-tab],[data-strategy],[data-config],[data-attempt],[data-check],[data-focus],button');
    if (!t) return;
    if (t.dataset.focus) { focus = t.dataset.focus; renderEff(); return; }
    if (t.dataset.tab) { st.tab = t.dataset.tab; renderBoard(); renderDrill(); writeHash(); return; }
    if (t.dataset.strategy) { if (st.strategy !== t.dataset.strategy) { st.strategy = t.dataset.strategy; setBatches(st.batches, st.strategy === 'active' ? 'Active audits: batches after the pilot follow predicted error' : 'Uniform spot-checks'); } return; }
    if (t.dataset.config) { const j = +t.dataset.config; st.config = st.config === j ? -1 : j; st.attempt = -1; renderBoard(); renderDrill(); writeHash(); if (st.config >= 0) $('#drill').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
    if (t.dataset.attempt) { st.attempt = +t.dataset.attempt; renderDrill(); writeHash(); return; }
    if (t.dataset.check) { st.check = st.check === +t.dataset.check ? -1 : +t.dataset.check; renderTriage(); writeHash(); return; }
    switch (t.id) {
      case 'aud-approve': setBatches(st.batches + 1, `Batch ${st.batches + 1} approved: ${S.queue.length} expert grades in`); break;
      case 'aud-undo': setBatches(st.batches - 1, 'Last batch undone'); break;
      case 'aud-reset': setBatches(0, 'All audits cleared'); break;
      case 'aud-export': exportQueue(); break;
      case 'aud-tri-export': exportTriage(); break;
      case 'aud-close': st.config = -1; st.attempt = -1; renderBoard(); renderDrill(); writeHash(); break;
    }
  });
  document.addEventListener('change', (ev) => { if (ev.target.id === 'aud-truth') { st.truth = ev.target.checked; renderBoard(); renderTriage(); writeHash(); } });
  document.addEventListener('keydown', (ev) => {
    const tg = ev.target instanceof Element ? ev.target : document.body;
    if (tg.matches('input[type=text], textarea, select') || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === 'Enter' && tg.matches('[data-config],[data-attempt],[data-check]')) { tg.click(); return; }
    if (ev.key === 'a' && st.batches < MAXB) setBatches(st.batches + 1, `Batch ${st.batches + 1} approved`);
    else if (ev.key === 'u' && st.batches) setBatches(st.batches - 1, 'Last batch undone');
    else if (ev.key === 'e') exportQueue();
    else if (ev.key === 'Escape' && st.config >= 0) { st.config = -1; st.attempt = -1; renderBoard(); renderDrill(); writeHash(); }
    else if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') { if (!tg.closest('.chart-tabs')) return; const k = TABS.findIndex((x) => x[0] === st.tab); st.tab = TABS[(k + (ev.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0]; renderBoard(); renderDrill(); writeHash(); $(`[data-tab="${st.tab}"]`)?.focus(); }
  });
}

async function main() {
  readHash();
  bind();
  try {
    const [d, r] = await Promise.all([fetch('data/bench.json').then((x) => { if (!x.ok) throw new Error('bench HTTP ' + x.status); return x.json(); }), fetch('results/results.json').then((x) => { if (!x.ok) throw new Error('results HTTP ' + x.status); return x.json(); })]);
    B = unpack(d); RES = r;
    compute(); renderAll();
    $('#app').setAttribute('aria-busy', 'false');
  } catch (e) {
    $('#board').innerHTML = `<div class="chart-body"><p class="chart-title">Westworld Finance Diligence Benchmark Leaderboard</p><div class="chart-view"><p class="aud-loading">Couldn’t load the benchmark data (${esc(e.message)}). <button type="button" class="text-button" onclick="location.reload()">Retry</button></p></div></div>`;
  }
}
main();
