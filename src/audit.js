// Audited leaderboard: turn a small number of expert spot-checks into unbiased, calibrated
// benchmark scores, and choose which attempts experts should audit next.
// Pure ES module, no dependencies; used by the page, the generator, the report and the tests.
//
// Setting. Every graded attempt i (config j, task t, attempt a) has a verifier score
//   s_i = sum_c w_c v_c        (v_c = verifier verdict on check c; agentic checks can be wrong)
// and an unknown true score S_i = sum_c w_c y_c (what an expert would award). An expert audit
// of attempt i reveals y_c for its agentic checks (deterministic checks are exact).
//
// Estimator (prediction-powered difference estimator under Poisson sampling). With inclusion
// probability pi_i fixed before a batch is drawn,
//   mu_j = mean_i s_i + (1/N_j) sum_{i audited} (S_i - s_i) / pi_i
// is unbiased for the config's true mean score, and
//   Var_hat = (1/N_j^2) sum_{i audited} (1 - pi_i) (S_i - s_i)^2 / pi_i^2
// is unbiased for its variance. Batches are combined with weights fixed in advance (their
// expected sizes), which keeps the combination unbiased under adaptive allocation.
//
// Active allocation. Neyman: pi_i proportional to the predicted standard deviation of the
// residual S_i - s_i, using Beta posteriors of each agentic check's false-pass and
// false-fail rates (partially pooled toward the check family). Floors keep every pi_i > 0.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r) => { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const sig = (x) => 1 / (1 + Math.exp(-x));
const betaDraw = (r, a, b) => { // via two gammas (Marsaglia-Tsang), adequate for a > 0.3
  const g = (k) => { if (k < 1) return g(k + 1) * Math.pow(r(), 1 / k); const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d); for (;;) { let x, v; do { x = gauss(r); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = r(); if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; } };
  const x = g(a), y = g(b); return x / (x + y);
};

// Published shape of Westworld Finance Diligence Bench (halluminate.ai/blog/due-diligence-bench):
// 88 tasks in 7 categories, 18 model x harness configurations, 3 attempts each, verifier-graded
// mean scores below (the post's table, configurations anonymized to Model A-I).
export const CATEGORIES = [['Modeling', 14], ['Underwriting', 13], ['Quality of earnings', 9], ['Data preparation', 11], ['Pitch materials', 15], ['Closing', 4], ['Diligence review', 22]];
export const PUBLISHED = [
  ['A', 'native CLI', 0.60747], ['B', 'native CLI', 0.59374], ['B', 'CU + TU', 0.59122], ['C', 'CU + TU', 0.58229], ['C', 'native CLI', 0.56423],
  ['D', 'CU + TU', 0.54987], ['E', 'CU + TU', 0.54456], ['D', 'native CLI', 0.54129], ['E', 'native CLI', 0.53278], ['A', 'CU + TU', 0.51294],
  ['F', 'native CLI', 0.49655], ['G', 'native CLI', 0.48268], ['H', 'native CLI', 0.47160], ['I', 'native CLI', 0.45168], ['F', 'CU + TU', 0.45146],
  ['G', 'CU + TU', 0.39936], ['H', 'CU + TU', 0.29862], ['I', 'CU + TU', 0.25681],
].map(([m, h, s], j) => ({ j, model: 'Model ' + m, harness: h, published: s }));
export const ATTEMPTS = 3;
export const CHECK_FAMILIES = ['rubric', 'numeric tie-out', 'conclusion', 'presence', 'formatting'];

/**
 * Generate a benchmark replica with known ground truth. Returns columnar arrays.
 * checks: per check {task, kind: 'agentic'|'det', family, w, fpr, fnr, b}
 * attempts: per attempt {config, task, a, s (verifier score), S (true score)} plus per-check
 * verdicts packed as bit/float arrays.
 */
export function generateBench(seed = 20261111) {
  const r = mulberry32(seed);
  const tasks = [];
  for (const [cat, n] of CATEGORIES) for (let k = 0; k < n; k++) tasks.push({ id: tasks.length, cat, beta: gauss(r) * 1.0 });
  const checks = [];
  for (const t of tasks) {
    const nA = 3 + Math.floor(r() * 6), nD = 1 + Math.floor(r() * 3);
    const agenticShare = 0.7 + r() * 0.25; // post's sample task: 95% agentic weight
    const raw = Array.from({ length: nA }, () => 0.5 + r());
    const rawD = Array.from({ length: nD }, () => 0.5 + r());
    const sa = raw.reduce((a, b) => a + b, 0), sd = rawD.reduce((a, b) => a + b, 0);
    raw.forEach((x, k) => {
      const family = CHECK_FAMILIES[Math.floor(r() * CHECK_FAMILIES.length)];
      const weak = r() < 0.07; // keyword-style or degenerate judges, like the post's "recommend" example
      const fpr = weak ? 0.35 + 0.35 * r() : betaDraw(r, 2, family === 'conclusion' ? 18 : 30);
      const fnr = betaDraw(r, 2, family === 'rubric' ? 22 : 40);
      // second, cheaper judge (a different model re-grading the same rubric item). On weak
      // checks both judges tend to be fooled the same way (the rubric itself is the problem).
      const fpr2 = weak ? fpr : betaDraw(r, 2, 26), fnr2 = betaDraw(r, 2, 30);
      checks.push({ id: checks.length, task: t.id, kind: 'agentic', family, w: (agenticShare * x) / sa, fpr, fnr, fpr2, fnr2, weak, b: gauss(r) * 0.8 });
    });
    rawD.forEach((x) => checks.push({ id: checks.length, task: t.id, kind: 'det', family: 'deterministic', w: ((1 - agenticShare) * x) / sd, fpr: 0, fnr: 0, fpr2: 0, fnr2: 0, weak: false, b: gauss(r) * 0.8 }));
  }
  const byTask = tasks.map(() => []);
  for (const c of checks) byTask[c.task].push(c.id);
  // config x task interaction, shared by the three attempts
  const inter = PUBLISHED.map(() => tasks.map(() => gauss(r) * 0.6));
  const noise = [];
  for (let j = 0; j < PUBLISHED.length; j++) for (let t = 0; t < tasks.length; t++) for (let a = 0; a < ATTEMPTS; a++) for (const c of byTask[t]) noise.push(r(), r(), r(), r(), r());
  // calibrate each config's ability so the verifier-graded mean equals the published mean
  const simulate = (j, theta, write) => {
    let k = 0, sum = 0;
    let idx = noiseStart[j];
    const out = [];
    for (let t = 0; t < tasks.length; t++) for (let a = 0; a < ATTEMPTS; a++) {
      let s = 0, S = 0; const ver = [], tru = [], ver2 = [];
      for (const cid of byTask[t]) {
        const c = checks[cid];
        const u1 = noise[idx++], u2 = noise[idx++], u3 = noise[idx++], u4 = noise[idx++], u5 = noise[idx++];
        const p = sig(theta - tasks[t].beta - c.b + inter[j][t]);
        let y, v, v2;
        if (c.kind === 'det') { y = u1 < p ? 1 : Math.min(1, Math.max(0, p * (0.4 + 0.6 * u2))); v = y; v2 = y; }
        else {
          y = u1 < p ? 1 : 0;
          v = y ? (u2 < c.fnr ? 0 : 1) : (u3 < c.fpr ? 1 : 0);
          if (c.weak && y === 0 && v === 1 && u4 < 0.7) v2 = 1; // correlated failure
          else v2 = y ? (u5 < c.fnr2 ? 0 : 1) : (u4 < c.fpr2 ? 1 : 0);
        }
        s += c.w * v; S += c.w * y; ver.push(v); tru.push(y); ver2.push(v2);
      }
      sum += s; k++;
      if (write) out.push({ config: j, task: t, a, s, S, ver, ver2, tru });
    }
    return write ? out : sum / k;
  };
  const noiseStart = [];
  { let acc = 0; const per = tasks.reduce((x, t) => x + byTask[t.id].length, 0) * ATTEMPTS * 5; for (let j = 0; j < PUBLISHED.length; j++) { noiseStart.push(acc); acc += per; } }
  const attempts = [];
  const thetas = [];
  for (const P of PUBLISHED) {
    let lo = -6, hi = 6;
    for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; if (simulate(P.j, mid, false) < P.published) lo = mid; else hi = mid; }
    thetas.push((lo + hi) / 2);
    attempts.push(...simulate(P.j, (lo + hi) / 2, true));
  }
  return { seed, tasks, checks, byTask, attempts, thetas };
}

// ------------------------------------------------------------------------------------------
// Error-rate posteriors from audits so far. Partial pooling: each check's Beta prior is centred
// on its family's pooled rate with prior strength K.
export function errorPosteriors(bench, audited, K = 8) {
  const { checks, attempts } = bench;
  const fp = new Float64Array(checks.length), tn = new Float64Array(checks.length), fn = new Float64Array(checks.length), tp = new Float64Array(checks.length);
  const fpB = new Float64Array(checks.length), fnB = new Float64Array(checks.length);
  for (const i of audited) {
    const A = attempts[i], ids = bench.byTask[A.task];
    ids.forEach((cid, k) => {
      if (checks[cid].kind !== 'agentic') return;
      const y = A.tru[k], v = A.ver[k], v2 = A.ver2[k];
      if (y === 0) { if (v === 1) fp[cid]++; else tn[cid]++; if (v2 === 1) fpB[cid]++; } else { if (v === 0) fn[cid]++; else tp[cid]++; if (v2 === 0) fnB[cid]++; }
    });
  }
  const fam = {};
  for (const c of checks) if (c.kind === 'agentic') {
    const f = (fam[c.family] ||= { fp: 1, neg: 12, fn: 1, pos: 20, fpB: 1, fnB: 1 });
    f.fp += fp[c.id]; f.neg += fp[c.id] + tn[c.id]; f.fn += fn[c.id]; f.pos += fn[c.id] + tp[c.id]; f.fpB += fpB[c.id]; f.fnB += fnB[c.id];
  }
  return checks.map((c) => {
    if (c.kind !== 'agentic') return { id: c.id, a1: 0, b1: 1, a2: 0, b2: 1, fpr: 0, fnr: 0, fpr2: 0, fnr2: 0, nNeg: 0, nPos: 0, fp: 0, fn: 0 };
    const f = fam[c.family], m1 = f.fp / f.neg, m2 = f.fn / f.pos, m3 = f.fpB / f.neg, m4 = f.fnB / f.pos;
    const nNeg = fp[c.id] + tn[c.id], nPos = fn[c.id] + tp[c.id];
    const a1 = K * m1 + fp[c.id], b1 = K * (1 - m1) + tn[c.id], a2 = K * m2 + fn[c.id], b2 = K * (1 - m2) + tp[c.id];
    return { id: c.id, a1, b1, a2, b2, fpr: a1 / (a1 + b1), fnr: a2 / (a2 + b2), fpr2: (K * m3 + fpB[c.id]) / (K + nNeg), fnr2: (K * m4 + fnB[c.id]) / (K + nPos), nNeg, nPos, fp: fp[c.id], fn: fn[c.id] };
  });
}

// Calibrated predictor and residual SD under current posteriors. For an agentic check with
// verdict v, E[y | v] follows from Bayes with the check's false-pass/false-fail posteriors and
// the config's estimated true pass rate; deterministic checks are exact. pred_i is fixed before
// each batch is drawn, so the difference estimator stays unbiased whatever the posteriors are.
export function predictor(bench, post, mode = 'calibrated') {
  const { attempts, checks, byTask } = bench;
  const N = attempts.length;
  const pred = new Float64Array(N), sd = new Float64Array(N);
  if (mode === 'raw') { for (let i = 0; i < N; i++) pred[i] = attempts[i].s; }
  // per-config prior pass rate on agentic checks: (observed pass rate - mean fpr) / (1 - fpr - fnr)
  const J = PUBLISHED.length, vp = new Float64Array(J), vn = new Float64Array(J);
  let mf = 0, mn = 0, nc = 0;
  for (const c of checks) if (c.kind === 'agentic') { mf += post[c.id].fpr; mn += post[c.id].fnr; nc++; }
  mf /= nc; mn /= nc;
  for (const A of attempts) byTask[A.task].forEach((cid, k) => { if (checks[cid].kind === 'agentic') { vp[A.config] += A.ver[k]; vn[A.config]++; } });
  const prior = Array.from({ length: J }, (_, j) => Math.min(0.97, Math.max(0.03, (vp[j] / vn[j] - mf) / (1 - mf - mn))));
  for (let i = 0; i < N; i++) {
    const A = attempts[i]; let v2 = 0, e = 0; const pr = prior[A.config];
    byTask[A.task].forEach((cid, k) => {
      const c = checks[cid];
      if (c.kind !== 'agentic') { e += c.w * A.ver[k]; return; }
      const P = post[cid], v1 = A.ver[k], w2 = A.ver2[k];
      // P(v1, v2 | y) assuming the judges err independently given y
      const l1 = (v1 ? 1 - P.fnr : P.fnr) * (w2 ? 1 - P.fnr2 : P.fnr2);
      const l0 = (v1 ? P.fpr : 1 - P.fpr) * (w2 ? P.fpr2 : 1 - P.fpr2);
      const ey = (l1 * pr) / (l1 * pr + l0 * (1 - pr));
      e += c.w * ey;
      v2 += c.w * c.w * ey * (1 - ey);
    });
    if (mode !== 'raw') pred[i] = e;
    // residual SD around the predictor actually used (raw adds its bias to the spread)
    sd[i] = Math.sqrt(v2 + (mode === 'raw' ? (e - attempts[i].s) ** 2 : 0));
  }
  return { pred, sd };
}

// Inclusion probabilities for a batch of expected size n among eligible attempts.
export function inclusionProbs(weights, eligible, n, floor = 0.15) {
  const m = eligible.length;
  if (!m) return new Map();
  const w = eligible.map((i) => weights[i]);
  const mean = w.reduce((a, b) => a + b, 0) / m || 1;
  // mix with uniform so no attempt has negligible probability
  let raw = w.map((x) => (1 - floor) * x / mean + floor);
  // scale to expected size n with caps at 1 (iterative)
  let pis = raw.map(() => 0), scale = n / raw.reduce((a, b) => a + b, 0);
  for (let it = 0; it < 30; it++) {
    pis = raw.map((x) => Math.min(1, x * scale));
    const tot = pis.reduce((a, b) => a + b, 0);
    if (Math.abs(tot - n) < 1e-9) break;
    const free = raw.reduce((acc, x, k) => acc + (pis[k] < 1 ? x : 0), 0);
    const capped = pis.filter((p) => p >= 1).length;
    scale = free > 0 ? (n - capped) / free : scale;
  }
  return new Map(eligible.map((i, k) => [i, pis[k]]));
}

/**
 * Run audit batches. strategy: 'active' (Neyman on predicted residual SD) or 'uniform';
 * predictorMode: 'calibrated' (debiased with error-rate posteriors) or 'raw' (verifier score).
 * The first batch is a uniform pilot. Deterministic for a seed.
 */
export function runAudits(bench, { batches = 5, batchSize = 60, strategy = 'active', predictorMode = 'calibrated', seed = 7, floor = 0.15 } = {}) {
  const r = mulberry32(seed);
  const N = bench.attempts.length;
  const audited = new Set();
  const log = [];
  for (let b = 0; b < batches; b++) {
    const eligible = []; for (let i = 0; i < N; i++) if (!audited.has(i)) eligible.push(i);
    const post = errorPosteriors(bench, audited);
    const { pred, sd } = predictor(bench, post, predictorMode);
    const uniform = strategy === 'uniform' || b === 0;
    const pis = inclusionProbs(uniform ? new Float64Array(N).fill(1) : sd, eligible, batchSize, uniform ? 1 : floor);
    const drawn = [];
    for (const i of eligible) if (r() < pis.get(i)) drawn.push(i);
    for (const i of drawn) audited.add(i);
    log.push({ b, n: batchSize, strategy: uniform ? 'uniform' : 'active', pis, drawn, pred, eligibleCount: eligible.length });
  }
  return { log, audited };
}

// Per-config estimates from a batch log. Batch k estimates the config's total true score as
//   (sum of S over attempts audited before k) + (sum of pred over the rest)
//   + (sum over drawn of (S - pred) / pi),
// unbiased given the past; batches are combined with weights fixed in advance, and because the
// batch errors are martingale differences their variances add.
export function estimate(bench, log, z = 1.96) {
  const J = PUBLISHED.length, { attempts } = bench;
  const Nj = new Array(J).fill(0), sbar = new Array(J).fill(0), truth = new Array(J).fill(0);
  for (const A of attempts) { Nj[A.config]++; sbar[A.config] += A.s; truth[A.config] += A.S; }
  for (let j = 0; j < J; j++) { sbar[j] /= Nj[j]; truth[j] /= Nj[j]; }
  const total = log.reduce((a, L) => a + L.n, 0);
  const est = new Array(J).fill(0), vr = new Array(J).fill(0), nAud = new Array(J).fill(0);
  const seen = new Set();
  for (const L of log) {
    const wb = L.n / total;
    const tot = new Array(J).fill(0), v = new Array(J).fill(0);
    for (let i = 0; i < attempts.length; i++) { const A = attempts[i]; tot[A.config] += seen.has(i) ? A.S : L.pred[i]; }
    for (const i of L.drawn) {
      const A = attempts[i], p = L.pis.get(i), res = A.S - L.pred[i];
      tot[A.config] += res / p;
      v[A.config] += ((1 - p) * res * res) / (p * p);
      nAud[A.config]++;
    }
    for (let j = 0; j < J; j++) { est[j] += (wb * tot[j]) / Nj[j]; vr[j] += (wb * wb * v[j]) / (Nj[j] * Nj[j]); }
    for (const i of L.drawn) seen.add(i);
  }
  return PUBLISHED.map((P, j) => {
    const se = Math.sqrt(vr[j]);
    return { ...P, verifier: sbar[j], truth: truth[j], est: est[j], se, lo: est[j] - z * se, hi: est[j] + z * se, audits: nAud[j], N: Nj[j] };
  });
}

// Expert-only baseline: mean true score of the audited attempts (uniform audits), with the
// finite-population standard error. What you get if you ignore the verifier.
export function expertOnly(bench, audited, z = 1.96) {
  const J = PUBLISHED.length, by = Array.from({ length: J }, () => []), Nj = new Array(J).fill(0), truth = new Array(J).fill(0);
  for (const A of bench.attempts) { Nj[A.config]++; truth[A.config] += A.S; }
  for (const i of audited) { const A = bench.attempts[i]; by[A.config].push(A.S); }
  return PUBLISHED.map((P, j) => {
    const x = by[j], n = x.length, m = x.reduce((a, b) => a + b, 0) / Math.max(1, n);
    const v = n > 1 ? x.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1) : 0.25;
    const se = Math.sqrt((1 - n / Nj[j]) * v / Math.max(1, n));
    return { ...P, est: m, se, lo: m - z * se, hi: m + z * se, truth: truth[j] / Nj[j], audits: n };
  });
}

// Normal-approximation rank intervals: rank range containing 95% of rank draws (independent
// config estimates), from a deterministic set of quasi-random draws.
export function rankIntervals(rows, draws = 2000, seed = 3) {
  const r = mulberry32(seed), J = rows.length;
  const ranks = rows.map(() => []);
  for (let d = 0; d < draws; d++) {
    const x = rows.map((R) => R.est + R.se * gauss(r));
    const order = x.map((v, j) => [v, j]).sort((a, b) => b[0] - a[0]);
    order.forEach(([, j], k) => ranks[j].push(k + 1));
  }
  return rows.map((R, j) => { const v = ranks[j].sort((a, b) => a - b); return { lo: v[Math.floor(0.025 * draws)], hi: v[Math.ceil(0.975 * draws) - 1], top: v.filter((k) => k === 1).length / draws }; });
}

// Verifier triage: agentic checks ranked by posterior probability that the false-pass rate
// exceeds a threshold (Beta tail by numeric integration).
export function betaTail(a, b, x0) {
  // P(X > x0), X ~ Beta(a,b); midpoint rule on [x0,1] with log-space density
  const lb = lgamma(a + b) - lgamma(a) - lgamma(b);
  const n = 400; let s = 0;
  for (let k = 0; k < n; k++) { const x = x0 + ((k + 0.5) * (1 - x0)) / n; s += Math.exp(lb + (a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x)); }
  return Math.min(1, Math.max(0, (s * (1 - x0)) / n));
}
function lgamma(z) { // Lanczos
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1; let x = c[0]; for (let i = 1; i < g + 2; i++) x += c[i] / (z + i); const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
export function triage(bench, post, threshold = 0.2) {
  return bench.checks.filter((c) => c.kind === 'agentic').map((c) => {
    const P = post[c.id];
    return { id: c.id, task: c.task, family: c.family, w: c.w, fpr: P.fpr, fnr: P.fnr, pWeak: betaTail(P.a1, P.b1, threshold), nNeg: P.nNeg, nPos: P.nPos, fp: P.fp, fn: P.fn, trueWeak: c.weak, trueFpr: c.fpr };
  }).sort((a, b) => b.pWeak - a.pWeak);
}

// Next-batch audit queue: the attempts with the highest inclusion probability under the
// active policy (what an expert would see first), with why.
export function auditQueue(bench, audited, size = 60) {
  const post = errorPosteriors(bench, audited);
  const { sd } = predictor(bench, post);
  const eligible = []; for (let i = 0; i < bench.attempts.length; i++) if (!audited.has(i)) eligible.push(i);
  const pis = inclusionProbs(sd, eligible, size, 0.15);
  return eligible.map((i) => ({ i, pi: pis.get(i), sd: sd[i] })).sort((a, b) => b.pi - a.pi).slice(0, size);
}

// Rebuild a bench object from data/bench.json (the page and tests use this, so the packed file is
// the single source of truth). Det check outcomes may be fractional; verdict strings are 0/1.
export function unpack(D) {
  const tasks = D.tasks.map(([cat, beta], id) => ({ id, cat, beta }));
  const checks = D.checks.map(([task, ag, family, w, fpr, fnr, fpr2, fnr2, weak], id) => ({ id, task, kind: ag ? 'agentic' : 'det', family, w, fpr, fnr, fpr2, fnr2, weak: !!weak }));
  const byTask = tasks.map(() => []);
  for (const c of checks) byTask[c.task].push(c.id);
  const attempts = D.attempts.map(([config, task, a, v1, v2, tru]) => {
    const ids = byTask[task];
    const ver = ids.map((cid, k) => (checks[cid].kind === 'det' ? tru[k] : +v1[k]));
    const ver2 = ids.map((cid, k) => (checks[cid].kind === 'det' ? tru[k] : +v2[k]));
    let s = 0, S = 0;
    ids.forEach((cid, k) => { s += checks[cid].w * ver[k]; S += checks[cid].w * tru[k]; });
    return { config, task, a, s, S, ver, ver2, tru };
  });
  return { seed: D.seed, tasks, checks, byTask, attempts };
}
