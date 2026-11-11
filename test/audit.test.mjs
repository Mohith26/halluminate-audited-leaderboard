import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  generateBench, unpack, runAudits, estimate, expertOnly, inclusionProbs, errorPosteriors, predictor,
  betaTail, rankIntervals, auditQueue, triage, PUBLISHED, mulberry32,
} from '../src/audit.js';
import { pack } from '../scripts/generate.mjs';
import { dexp, dlog, dsin, dcos, dpow } from '../src/detmath.js';

const raw = JSON.parse(fs.readFileSync(new URL('../data/bench.json', import.meta.url), 'utf8'));
const B = unpack(raw);
const R = JSON.parse(fs.readFileSync(new URL('../results/results.json', import.meta.url), 'utf8'));
const J = PUBLISHED.length;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

test('committed data is exactly what the seeded generator produces', () => {
  assert.deepEqual(pack(generateBench(raw.seed)), raw);
});

test('shape follows the published benchmark: 88 tasks, 7 categories, 18 configs x 3 attempts', () => {
  assert.equal(B.tasks.length, 88);
  assert.equal(B.attempts.length, 88 * 18 * 3);
  const counts = {}; for (const t of B.tasks) counts[t.cat] = (counts[t.cat] || 0) + 1;
  assert.deepEqual(counts, { Modeling: 14, Underwriting: 13, 'Quality of earnings': 9, 'Data preparation': 11, 'Pitch materials': 15, Closing: 4, 'Diligence review': 22 });
  for (const ids of B.byTask) assert.ok(Math.abs(ids.reduce((a, c) => a + B.checks[c].w, 0) - 1) < 1e-4);
});

test('verifier-graded means reproduce the published leaderboard within 0.002', () => {
  const v = new Array(J).fill(0), n = new Array(J).fill(0);
  for (const A of B.attempts) { v[A.config] += A.s; n[A.config]++; }
  PUBLISHED.forEach((P, j) => assert.ok(Math.abs(v[j] / n[j] - P.published) < 0.002, `${P.model} ${P.harness}`));
});

test('auditing every attempt recovers the truth exactly with zero standard error', () => {
  const N = B.attempts.length;
  const pis = new Map(Array.from({ length: N }, (_, i) => [i, 1]));
  const log = [{ n: 1, pis, drawn: Array.from({ length: N }, (_, i) => i), pred: B.attempts.map((A) => A.s) }];
  for (const e of estimate(B, log)) { assert.ok(Math.abs(e.est - e.truth) < 1e-9); assert.equal(e.se, 0); }
  for (const e of expertOnly(B, new Set(log[0].drawn))) { assert.ok(Math.abs(e.est - e.truth) < 1e-9); assert.ok(e.se < 1e-9); }
});

test('property: the active estimator is unbiased (mean error over 150 seeded runs within 3 SE of 0)', () => {
  const errs = [];
  for (let s = 1; s <= 150; s++) { const E = estimate(B, runAudits(B, { batches: 3, batchSize: 60, strategy: 'active', seed: 5000 + s }).log); errs.push(mean(E.map((e) => e.est - e.truth))); }
  const m = mean(errs), sd = Math.sqrt(mean(errs.map((x) => (x - m) ** 2)));
  assert.ok(Math.abs(m) < 3 * sd / Math.sqrt(errs.length), `mean error ${m}, sd ${sd}`);
});

test('property: the uniform estimator with the raw verifier as predictor is unbiased too', () => {
  const errs = [];
  for (let s = 1; s <= 150; s++) { const E = estimate(B, runAudits(B, { batches: 2, batchSize: 60, strategy: 'uniform', predictorMode: 'raw', seed: 9000 + s }).log); errs.push(mean(E.map((e) => e.est - e.truth))); }
  const m = mean(errs), sd = Math.sqrt(mean(errs.map((x) => (x - m) ** 2)));
  assert.ok(Math.abs(m) < 3 * sd / Math.sqrt(errs.length));
});

test('inclusion probabilities: expected size equals the batch size, capped at 1, monotone in weight', () => {
  const r = mulberry32(4), w = Float64Array.from({ length: 500 }, () => r() ** 3 * 10);
  const elig = Array.from({ length: 500 }, (_, i) => i);
  const p = inclusionProbs(w, elig, 60, 0.1);
  const tot = [...p.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(tot - 60) < 1e-6);
  for (const v of p.values()) assert.ok(v > 0 && v <= 1);
  const sorted = elig.slice().sort((a, b) => w[a] - w[b]);
  for (let k = 1; k < sorted.length; k++) assert.ok(p.get(sorted[k]) >= p.get(sorted[k - 1]) - 1e-12);
});

test('error posteriors count false passes and false fails from audits', () => {
  const t = B.attempts[0].task;
  const audited = new Set(B.attempts.map((A, i) => [A, i]).filter(([A]) => A.task === t).map(([, i]) => i));
  const post = errorPosteriors(B, audited);
  B.byTask[t].forEach((cid, k) => {
    if (B.checks[cid].kind !== 'agentic') return;
    let fp = 0, neg = 0;
    for (const i of audited) { const A = B.attempts[i]; if (A.tru[k] === 0) { neg++; if (A.ver[k] === 1) fp++; } }
    assert.equal(post[cid].fp, fp); assert.equal(post[cid].nNeg, neg);
  });
});

test('predictor equals the verifier score when both judges agree and error rates are zero', () => {
  const post = B.checks.map((c) => ({ fpr: 1e-9, fnr: 1e-9, fpr2: 1e-9, fnr2: 1e-9 }));
  const { pred } = predictor(B, post);
  let checked = 0;
  B.attempts.forEach((A, i) => { if (A.ver.every((v, k) => v === A.ver2[k])) { assert.ok(Math.abs(pred[i] - A.s) < 1e-6); checked++; } });
  assert.ok(checked > 100);
});

test('beta tail matches closed forms', () => {
  assert.ok(Math.abs(betaTail(1, 1, 0.3) - 0.7) < 1e-4);
  const x = 0.4; // Beta(2,2): P(X > x) = 1 - (3x^2 - 2x^3)
  assert.ok(Math.abs(betaTail(2, 2, x) - (1 - (3 * x * x - 2 * x ** 3))) < 1e-4);
});

test('rank intervals collapse to the point rank when standard errors are zero', () => {
  const rows = [0.5, 0.7, 0.6].map((est) => ({ est, se: 0 }));
  assert.deepEqual(rankIntervals(rows).map((r) => [r.lo, r.hi]), [[3, 3], [1, 1], [2, 2]]);
});

test('audit queue: next batch is unaudited attempts, ordered by inclusion probability', () => {
  const { audited } = runAudits(B, { batches: 2, batchSize: 60, seed: 7 });
  const q = auditQueue(B, audited, 60);
  assert.equal(q.length, 60);
  for (const x of q) assert.ok(!audited.has(x.i));
  for (let k = 1; k < q.length; k++) assert.ok(q[k].pi <= q[k - 1].pi + 1e-12);
});

test('triage puts checks with observed false passes above checks with none', () => {
  const { audited } = runAudits(B, { batches: 5, batchSize: 60, seed: 7 });
  const tri = triage(B, errorPosteriors(B, audited));
  const withFp = tri.filter((x) => x.fp >= 2);
  assert.ok(withFp.length > 0);
  const firstZero = tri.findIndex((x) => x.fp === 0);
  assert.ok(withFp.every((x) => tri.indexOf(x) < firstZero || x.nNeg > 20));
});

test('headline: active audits at 300 are 3.8x narrower than expert-only and cover ~95%', () => {
  const s = R.summary.at300;
  assert.equal(s.narrowerThanExpertOnly, 3.77);
  assert.ok(s.halfWidth.active < s.halfWidth.calibratedUniform && s.halfWidth.calibratedUniform < s.halfWidth.ppiRaw && s.halfWidth.ppiRaw < s.halfWidth.expertOnly);
  assert.ok(s.coverage200reps > 0.92 && s.coverage200reps < 0.98);
  // recompute the active half-width at 300 with the report's seeds
  const hw = [];
  for (let seed = 1; seed <= 40; seed++) hw.push(mean(estimate(B, runAudits(B, { batches: 5, batchSize: 60, strategy: 'active', seed }).log).map((e) => 1.96 * e.se)));
  assert.ok(Math.abs(mean(hw) - s.halfWidth.active) < 1e-5);
});

test('default page state matches the committed results', () => {
  const E = estimate(B, runAudits(B, { batches: 5, batchSize: 60, strategy: 'active', seed: 7 }).log);
  const d = R.summary.defaultState;
  assert.ok(Math.abs(mean(E.map((e) => 1.96 * e.se)) - d.meanHalfWidth) < 1e-5);
  E.forEach((e, j) => assert.ok(Math.abs(e.est - d.top[j].audited) < 1e-4));
});

test('deterministic math: pinned bit-exact values (same on every platform) and within 2 ulp of Math.*', () => {
  // These exact values are what macOS arm64 produces; CI on ubuntu x86-64 must match bit for bit.
  assert.equal(dexp(-1.2345678901234), 0.2909604620972207);
  assert.equal(dlog(0.0012345678), -6.697034329666487);
  assert.equal(dcos(2 * Math.PI * 0.3141592), -0.392293963251902);
  assert.equal(dsin(Math.PI * 0.123456), 0.3781975602958137);
  assert.equal(dpow(0.7316, 1 / 1.75), 0.8364540965325369);
  assert.equal(dexp(0), 1); assert.equal(dlog(1), 0); assert.equal(dlog(0), -Infinity);
  const r = mulberry32(99), eps = 2.220446049250313e-16;
  for (let k = 0; k < 20000; k++) {
    const u = r();
    const x = (u - 0.5) * 60, y = Math.exp((u - 0.5) * 200), z = (u - 0.5) * 20;
    assert.ok(Math.abs(dexp(x) - Math.exp(x)) <= 2.5 * eps * Math.exp(x), `exp ${x}`);
    assert.ok(Math.abs(dlog(y) - Math.log(y)) <= 2.5 * eps * Math.max(1, Math.abs(Math.log(y))), `log ${y}`);
    assert.ok(Math.abs(dsin(z) - Math.sin(z)) <= 2 * eps && Math.abs(dcos(z) - Math.cos(z)) <= 2 * eps, `trig ${z}`);
  }
});
