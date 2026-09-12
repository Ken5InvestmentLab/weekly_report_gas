export const SCORE_FIELDS = Object.freeze({
  material_impact: 20,
  earnings_quality: 20,
  growth_visibility: 15,
  financial_strength: 15,
  capital_structure: 10,
  governance_legal: 10,
  catalyst_quality: 10,
});

export const RISK_FLAGS = Object.freeze([
  'dilution',
  'ms_warrant',
  'going_concern',
  'debt_excess',
  'liquidity',
  'lawsuit',
  'regulatory',
  'regulatory_issue',
  'disclosure_issue',
  'listing_risk',
  'accounting_issue',
]);

export function validateFundamentalScore(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, errors: ['record must be an object'] };
  }
  if (!String(record.symbol || '').trim()) errors.push('symbol is required');
  if (!String(record.as_of || '').trim()) errors.push('as_of is required');

  let total = 0;
  for (const [field, max] of Object.entries(SCORE_FIELDS)) {
    const value = record[field];
    if (!Number.isInteger(value)) {
      errors.push(`${field} must be an integer`);
      continue;
    }
    if (value < 0 || value > max) errors.push(`${field} must be 0..${max}`);
    total += value;
  }

  if (!Array.isArray(record.risk_flags)) errors.push('risk_flags must be an array');
  else {
    for (const flag of record.risk_flags) {
      if (!RISK_FLAGS.includes(flag)) errors.push(`unknown risk flag: ${flag}`);
    }
  }

  if (typeof record.confidence !== 'number' || record.confidence < 0 || record.confidence > 1) {
    errors.push('confidence must be 0..1');
  }

  if (!Number.isInteger(record.fundamental_score)) errors.push('fundamental_score must be an integer');
  else if (record.fundamental_score !== total) {
    errors.push(`fundamental_score mismatch: expected ${total}, got ${record.fundamental_score}`);
  }

  return { ok: errors.length === 0, errors, calculatedTotal: total };
}

export function combineForExperiment({ technicalScore, fundamentalScore, lane = 'core', fundamentalWeight = 0.25 }) {
  if (typeof technicalScore !== 'number' || technicalScore < 0 || technicalScore > 100) {
    throw new Error('technicalScore must be 0..100');
  }
  if (typeof fundamentalScore !== 'number' || fundamentalScore < 0 || fundamentalScore > 100) {
    throw new Error('fundamentalScore must be 0..100');
  }
  if (lane === 'core') {
    return +(technicalScore * (1 - fundamentalWeight) + fundamentalScore * fundamentalWeight).toFixed(2);
  }
  // Monster is intentionally not blended yet. During research we preserve the technical score
  // and store fundamental/risk data separately so big-winner capture is not accidentally suppressed.
  if (lane === 'monster') return +technicalScore.toFixed(2);
  throw new Error('lane must be core or monster');
}
