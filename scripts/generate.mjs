// Write the seeded benchmark replica the page loads (data/bench.json). The shape follows the
// published Westworld Finance Diligence Bench (88 tasks, 7 categories, 18 configs x 3 attempts,
// verifier-graded means equal to the post's table); verifier error rates are simulated.
// Usage: node scripts/generate.mjs
import fs from 'node:fs';
import { generateBench, CATEGORIES, PUBLISHED } from '../src/audit.js';

export function pack(B) {
  return {
    seed: B.seed,
    note: 'Synthetic replica with known ground truth. Task counts, configurations and verifier-graded mean scores follow halluminate.ai/blog/due-diligence-bench; configurations anonymized; verifier error rates simulated.',
    categories: CATEGORIES,
    configs: PUBLISHED,
    tasks: B.tasks.map((t) => [t.cat, +t.beta.toFixed(4)]),
    checks: B.checks.map((c) => [c.task, c.kind === 'agentic' ? 1 : 0, c.family, +c.w.toFixed(6), +c.fpr.toFixed(4), +c.fnr.toFixed(4), +c.fpr2.toFixed(4), +c.fnr2.toFixed(4), c.weak ? 1 : 0]),
    attempts: B.attempts.map((A) => [A.config, A.task, A.a, A.ver.join(''), A.ver2.join(''), A.tru.map((y) => (y === 0 || y === 1 ? y : +y.toFixed(4)))]),
  };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const B = generateBench(20261111);
  fs.writeFileSync(new URL('../data/bench.json', import.meta.url), JSON.stringify(pack(B)));
  console.log('attempts', B.attempts.length, 'checks', B.checks.length, 'weak', B.checks.filter((c) => c.weak).length);
}
