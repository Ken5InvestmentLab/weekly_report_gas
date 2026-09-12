import assert from 'node:assert/strict';
import { validateFundamentalScore, combineForExperiment } from './fundamental_scoring_v1.mjs';

const sample6696 = {
  symbol: '6696',
  as_of: '2026-09-10',
  material_impact: 6,
  earnings_quality: 3,
  growth_visibility: 7,
  financial_strength: 4,
  capital_structure: 6,
  governance_legal: 1,
  catalyst_quality: 7,
  fundamental_score: 34,
  confidence: 0.9,
  risk_flags: ['lawsuit', 'liquidity'],
  rationale: 'STB受注はあるが、営業赤字継続・純損失・自己資本規模に近い訴訟請求が重い。'
};

const valid = validateFundamentalScore(sample6696);
assert.equal(valid.ok, true, JSON.stringify(valid.errors));
assert.equal(valid.calculatedTotal, 34);

const bad = validateFundamentalScore({ ...sample6696, earnings_quality: 99, fundamental_score: 130 });
assert.equal(bad.ok, false);
assert.ok(bad.errors.some((e) => e.includes('earnings_quality')));

assert.equal(combineForExperiment({ technicalScore: 80, fundamentalScore: 34, lane: 'core' }), 68.5);
assert.equal(combineForExperiment({ technicalScore: 80, fundamentalScore: 34, lane: 'monster' }), 80);

console.log(JSON.stringify({
  status: 'PASS',
  sample: sample6696,
  core_example: { technical: 80, fundamental: 34, final_experimental: 68.5 },
  monster_example: { technical: 80, fundamental: 34, final_experimental: 80, note: 'not blended during research' }
}, null, 2));
