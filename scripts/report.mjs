// Recompute every number the README, the email and the page's efficiency chart quote.
// Usage: node scripts/report.mjs   (writes results/results.json, about 20 s)
import fs from 'node:fs';
import { unpack, runAudits, estimate, expertOnly, rankIntervals, errorPosteriors, triage, PUBLISHED } from '../src/audit.js';

const B = unpack(JSON.parse(fs.readFileSync(new URL('../data/bench.json', import.meta.url), 'utf8')));
const J = PUBLISHED.length, BATCH = 60, REPS = 40;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// 1. How far the verifier-graded leaderboard is from the truth
const truth = new Array(J).fill(0), ver = new Array(J).fill(0), n = new Array(J).fill(0);
for (const A of B.attempts) { truth[A.config] += A.S; ver[A.config] += A.s; n[A.config]++; }
for (let j = 0; j < J; j++) { truth[j] /= n[j]; ver[j] /= n[j]; }
const order = (x) => x.map((v, j) => [v, j]).sort((a, b) => b[0] - a[0]).map((p) => p[1]);
const rankOf = (x) => { const o = order(x), r = new Array(J); o.forEach((j, k) => { r[j] = k + 1; }); return r; };
const rv = rankOf(ver), rt = rankOf(truth);
let discordant = 0;
for (let a = 0; a < J; a++) for (let b = a + 1; b < J; b++) if ((ver[a] - ver[b]) * (truth[a] - truth[b]) < 0) discordant++;
const naive = {
  meanInflation: +mean(ver.map((v, j) => v - truth[j])).toFixed(4),
  maxInflation: +Math.max(...ver.map((v, j) => v - truth[j])).toFixed(4),
  configsMovingRank: rv.filter((r, j) => r !== rt[j]).length,
  discordantPairs: discordant,
};

// 2. Efficiency: mean 95% CI half-width (averaged over configs) vs expert audits
const methods = {
  expertOnly: (s, b) => expertOnly(B, runAudits(B, { batches: b, batchSize: BATCH, strategy: 'uniform', predictorMode: 'raw', seed: s }).audited),
  ppiRaw: (s, b) => estimate(B, runAudits(B, { batches: b, batchSize: BATCH, strategy: 'uniform', predictorMode: 'raw', seed: s }).log),
  calibratedUniform: (s, b) => estimate(B, runAudits(B, { batches: b, batchSize: BATCH, strategy: 'uniform', predictorMode: 'calibrated', seed: s }).log),
  active: (s, b) => estimate(B, runAudits(B, { batches: b, batchSize: BATCH, strategy: 'active', predictorMode: 'calibrated', seed: s }).log),
};
const curves = {};
const t0 = Date.now();
for (const [name, f] of Object.entries(methods)) {
  curves[name] = [];
  for (let b = 1; b <= 10; b++) {
    const hw = [], cov = [];
    for (let s = 1; s <= REPS; s++) { const E = f(s, b); hw.push(mean(E.map((e) => 1.96 * e.se))); cov.push(E.filter((e) => e.lo <= e.truth && e.truth <= e.hi).length / J); }
    curves[name].push({ audits: b * BATCH, halfWidth: +mean(hw).toFixed(5), coverage: +mean(cov).toFixed(4) });
  }
}
// 3. Coverage of the default method at 300 audits over more replications
const cov300 = [];
const abs300 = [];
for (let s = 101; s <= 300; s++) { const E = methods.active(s, 5); cov300.push(E.filter((e) => e.lo <= e.truth && e.truth <= e.hi).length / J); abs300.push(mean(E.map((e) => Math.abs(e.est - e.truth)))); }
// 4. Default page state (seed 7, 5 batches of 60) and verifier triage quality
const def = runAudits(B, { batches: 5, batchSize: BATCH, strategy: 'active', seed: 7 });
const est = estimate(B, def.log);
const ranks = rankIntervals(est);
const tri = triage(B, errorPosteriors(B, def.audited));
const weakTotal = B.checks.filter((c) => c.weak).length;
const top10 = tri.slice(0, 10);
const at = (name, audits) => curves[name].find((c) => c.audits === audits);
const h300 = { expertOnly: at('expertOnly', 300).halfWidth, ppiRaw: at('ppiRaw', 300).halfWidth, calibratedUniform: at('calibratedUniform', 300).halfWidth, active: at('active', 300).halfWidth };
// audits plain PPI needs to match the active method's width at 300 (linear interpolation)
const need = (name, target) => { const c = curves[name]; for (let k = 1; k < c.length; k++) if (c[k].halfWidth <= target) { const a = c[k - 1], b2 = c[k]; return Math.round(a.audits + ((a.halfWidth - target) / (a.halfWidth - b2.halfWidth)) * (b2.audits - a.audits)); } return null; };
const summary = {
  attempts: B.attempts.length,
  agenticChecks: B.checks.filter((c) => c.kind === 'agentic').length,
  weakChecks: weakTotal,
  naive,
  at300: {
    halfWidth: h300,
    narrowerThanExpertOnly: +(h300.expertOnly / h300.active).toFixed(2),
    narrowerThanPpiRawPct: +(100 * (1 - h300.active / h300.ppiRaw)).toFixed(1),
    narrowerThanCalibratedUniformPct: +(100 * (1 - h300.active / h300.calibratedUniform)).toFixed(1),
    ppiRawAuditsToMatch: need('ppiRaw', h300.active),
    coverage200reps: +mean(cov300).toFixed(4),
    meanAbsError: +mean(abs300).toFixed(4),
  },
  defaultState: {
    seed: 7, batches: 5, audits: def.audited.size,
    meanHalfWidth: +mean(est.map((e) => 1.96 * e.se)).toFixed(5),
    covered: est.filter((e) => e.lo <= e.truth && e.truth <= e.hi).length,
    top: est.map((e, j) => ({ config: `${e.model} · ${e.harness}`, verifier: +e.verifier.toFixed(4), audited: +e.est.toFixed(4), lo: +e.lo.toFixed(4), hi: +e.hi.toFixed(4), truth: +e.truth.toFixed(4), rank: [ranks[j].lo, ranks[j].hi] })),
    triageTop10TrulyWeak: top10.filter((x) => x.trueWeak).length,
  },
};
fs.mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../results/results.json', import.meta.url), JSON.stringify({ generatedFrom: 'data/bench.json', summary, curves }, null, 1));
console.log(JSON.stringify({ naive: summary.naive, at300: summary.at300, triage: summary.defaultState.triageTop10TrulyWeak, hw: summary.defaultState.meanHalfWidth, covered: summary.defaultState.covered }, null, 1));
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
