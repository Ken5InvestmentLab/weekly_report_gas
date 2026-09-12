export const SCORE_FIELDS = Object.freeze({
  material_impact: 20,
  earnings_quality: 20,
  growth_visibility: 15,
  financial_strength: 15,
  capital_structure: 10,
  governance_legal: 10,
  catalyst_quality: 10,
});

export const COMPONENT_ORDER = Object.freeze(Object.keys(SCORE_FIELDS));

export const BAND_POINTS = Object.freeze({
  material_impact: Object.freeze({ strong_positive: 18, moderate_positive: 15, neutral: 10, moderate_negative: 5, strong_negative: 1 }),
  earnings_quality: Object.freeze({ strong_positive: 18, moderate_positive: 15, neutral: 10, moderate_negative: 5, strong_negative: 1 }),
  growth_visibility: Object.freeze({ strong_positive: 14, moderate_positive: 11, neutral: 8, moderate_negative: 4, strong_negative: 1 }),
  financial_strength: Object.freeze({ strong_positive: 14, moderate_positive: 11, neutral: 8, moderate_negative: 4, strong_negative: 1 }),
  capital_structure: Object.freeze({ strong_positive: 9, moderate_positive: 7, neutral: 5, moderate_negative: 3, strong_negative: 1 }),
  governance_legal: Object.freeze({ strong_positive: 9, moderate_positive: 7, neutral: 5, moderate_negative: 3, strong_negative: 1 }),
  catalyst_quality: Object.freeze({ strong_positive: 9, moderate_positive: 7, neutral: 5, moderate_negative: 3, strong_negative: 1 }),
});

export const RISK_FLAGS = Object.freeze([
  'accounting_issue',
  'debt_excess',
  'disclosure_issue',
  'dilution',
  'going_concern',
  'lawsuit',
  'liquidity',
  'listing_risk',
  'ms_warrant',
  'regulatory_issue',
]);

const CONFIDENCE_DEDUCTIONS = Object.freeze({
  primary_financial_statement_missing: 0.20,
  latest_cash_flow_missing: 0.05,
  legal_impact_unquantified: 0.05,
  legal_outcome_unresolved: 0.10,
  capital_terms_incomplete: 0.10,
  unquantified_material_amount: 0.05,
  source_conflict: 0.10,
  valuation_proxy_only: 0.05,
  disclosure_scan_incomplete: 0.05,
  comparative_period_missing: 0.05,
});

const issueTypes = new Set(['lawsuit', 'accounting_issue', 'disclosure_issue', 'regulatory_issue', 'governance_issue']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function numberOrNull(value, name) {
  assert(value === null || (typeof value === 'number' && Number.isFinite(value)), `${name} must be a finite number or null`);
  return value;
}

function band(component, name, reasonCode, details = {}) {
  return { band: name, score: BAND_POINTS[component][name], reason_code: reasonCode, ...details };
}

function materialImpact(facts) {
  const f = facts.observations.material_impact;
  const revision = f.forecast_revision;
  const impact = numberOrNull(f.forecast_operating_profit_change_pct, 'forecast_operating_profit_change_pct');
  if (revision !== 'none' && !f.repeated_or_already_disclosed && impact !== null) {
    if (revision === 'up') {
      if (impact >= 20) return band('material_impact', 'strong_positive', 'new_guidance_up_ge_20pct');
      if (impact >= 5) return band('material_impact', 'moderate_positive', 'new_guidance_up_ge_5pct');
    } else {
      if (impact >= 20) return band('material_impact', 'strong_negative', 'new_guidance_down_ge_20pct');
      if (impact >= 5) return band('material_impact', 'moderate_negative', 'new_guidance_down_ge_5pct');
    }
  }

  const contractPct = numberOrNull(f.unforecast_contract_pct_annual_revenue, 'unforecast_contract_pct_annual_revenue');
  if (contractPct !== null && !f.contract_already_in_guidance) {
    if (contractPct >= 50) return band('material_impact', 'strong_positive', 'unforecast_contract_ge_50pct_revenue');
    if (contractPct >= 20) return band('material_impact', 'moderate_positive', 'unforecast_contract_ge_20pct_revenue');
  }

  const planGapPct = numberOrNull(f.period_operating_profit_gap_pct_annual_revenue, 'period_operating_profit_gap_pct_annual_revenue');
  if (planGapPct !== null) {
    if (planGapPct <= -10) return band('material_impact', 'strong_negative', 'period_profit_gap_le_minus_10pct_revenue');
    if (planGapPct <= -5) return band('material_impact', 'moderate_negative', 'period_profit_gap_le_minus_5pct_revenue');
    if (planGapPct >= 10) return band('material_impact', 'strong_positive', 'period_profit_gap_ge_10pct_revenue');
    if (planGapPct >= 5) return band('material_impact', 'moderate_positive', 'period_profit_gap_ge_5pct_revenue');
  }
  return band('material_impact', 'neutral', 'no_incremental_company_scale_impact');
}

function earningsQuality(facts) {
  const f = facts.observations.earnings_quality;
  const operatingProfit = numberOrNull(f.operating_profit, 'operating_profit');
  const margin = numberOrNull(f.operating_margin_pct, 'operating_margin_pct');
  const opGrowth = numberOrNull(f.operating_profit_growth_pct, 'operating_profit_growth_pct');
  const oneOffPct = numberOrNull(f.one_off_or_valuation_impact_pct_of_operating_profit, 'one_off_or_valuation_impact_pct_of_operating_profit');

  if (operatingProfit < 0 && margin <= -20 && f.net_income_positive === false && f.latest_operating_cash_flow_positive === false) {
    return band('earnings_quality', 'strong_negative', 'operating_loss_margin_le_minus_20_net_loss_negative_cfo');
  }
  if (operatingProfit < 0 || f.net_income_positive === false || (oneOffPct !== null && oneOffPct >= 25)) {
    return band('earnings_quality', 'moderate_negative', 'loss_or_net_loss_or_oneoff_impact_ge_25pct');
  }
  if (opGrowth !== null && opGrowth >= 30 && margin >= 10 && f.net_income_positive === true && f.latest_operating_cash_flow_positive === true && (oneOffPct === null || oneOffPct < 10)) {
    return band('earnings_quality', 'strong_positive', 'growth_margin_cash_conversion_confirmed');
  }
  if (opGrowth !== null && opGrowth >= 15 && margin >= 5 && f.net_income_positive === true && f.latest_operating_cash_flow_positive === true && (oneOffPct === null || oneOffPct < 10)) {
    return band('earnings_quality', 'moderate_positive', 'growth_margin_and_cash_conversion_confirmed');
  }
  if (operatingProfit > 0 && f.net_income_positive === true) {
    return band('earnings_quality', 'neutral', 'positive_operations_with_mixed_or_low_margin_evidence');
  }
  return band('earnings_quality', 'moderate_negative', 'insufficient_positive_earnings_evidence');
}

function growthVisibility(facts) {
  const f = facts.observations.growth_visibility;
  const recurringGrowth = numberOrNull(f.quantified_recurring_metric_growth_pct, 'quantified_recurring_metric_growth_pct');
  const backlogCoverage = numberOrNull(f.secured_backlog_pct_annual_revenue, 'secured_backlog_pct_annual_revenue');
  const revenueGrowth = numberOrNull(f.revenue_growth_pct, 'revenue_growth_pct');
  const progress = numberOrNull(f.revenue_progress_vs_time_elapsed_plan, 'revenue_progress_vs_time_elapsed_plan');
  const leadingActivity = numberOrNull(f.leading_activity_growth_pct, 'leading_activity_growth_pct');

  if (recurringGrowth !== null && recurringGrowth >= 20 && backlogCoverage !== null && backlogCoverage >= 50) {
    return band('growth_visibility', 'strong_positive', 'recurring_growth_ge_20_and_backlog_ge_50');
  }
  if (recurringGrowth !== null && recurringGrowth >= 10 && backlogCoverage !== null && backlogCoverage >= 25) {
    return band('growth_visibility', 'moderate_positive', 'recurring_growth_ge_10_and_backlog_ge_25');
  }
  if ((revenueGrowth !== null && revenueGrowth <= -25) || (progress !== null && progress < 0.50)) {
    return band('growth_visibility', 'strong_negative', 'revenue_decline_ge_25_or_plan_progress_below_50pct');
  }
  if ((revenueGrowth !== null && revenueGrowth < -10) || (leadingActivity !== null && leadingActivity < -10) || (progress !== null && progress < 0.75)) {
    return band('growth_visibility', 'moderate_negative', 'revenue_or_leading_activity_decline_or_plan_progress_below_75pct');
  }
  return band('growth_visibility', 'neutral', 'no_quantified_secured_expansion_or_material_decline');
}

function financialStrength(facts) {
  const f = facts.observations.financial_strength;
  const cash = numberOrNull(f.cash, 'cash');
  const debt = numberOrNull(f.interest_bearing_debt, 'interest_bearing_debt');
  const netAssets = numberOrNull(f.net_assets, 'net_assets');
  const equityRatio = numberOrNull(f.equity_ratio_pct, 'equity_ratio_pct');
  const currentMaturities = numberOrNull(f.debt_due_within_12_months, 'debt_due_within_12_months');
  const operatingCashFlow = numberOrNull(f.latest_operating_cash_flow, 'latest_operating_cash_flow');
  const interestCoverage = numberOrNull(f.interest_coverage, 'interest_coverage');
  const cashDebtCoverage = debt > 0 ? cash / debt : null;
  const currentDebtCoverage = currentMaturities > 0 ? cash / currentMaturities : null;

  if (f.business_model === 'property_investment') {
    if (equityRatio < 20 && ((currentDebtCoverage !== null && currentDebtCoverage < 0.25) || (interestCoverage !== null && interestCoverage < 1))) {
      return band('financial_strength', 'strong_negative', 'property_equity_below_20_and_severe_liquidity_or_cover');
    }
    if ((currentDebtCoverage !== null && currentDebtCoverage < 0.50) || (interestCoverage !== null && interestCoverage < 2)) {
      return band('financial_strength', 'moderate_negative', 'property_cash_maturity_cover_below_0_5_or_interest_cover_below_2');
    }
    if (equityRatio >= 40 && currentDebtCoverage !== null && currentDebtCoverage >= 1 && interestCoverage !== null && interestCoverage >= 3 && operatingCashFlow !== null && operatingCashFlow >= 0) {
      return band('financial_strength', 'moderate_positive', 'property_equity_liquidity_interest_and_cashflow_adequate');
    }
    return band('financial_strength', 'neutral', 'property_leverage_assessed_with_liquidity_and_interest_cover');
  }

  const netDebt = debt - cash;
  const severeTests = Number(equityRatio < 15) + Number(operatingCashFlow < 0) + Number(interestCoverage !== null && interestCoverage < 1) + Number(netDebt > 0 && currentDebtCoverage !== null && currentDebtCoverage < 0.25);
  if (severeTests >= 3) return band('financial_strength', 'strong_negative', 'three_or_more_severe_operating_finance_tests');
  const negativeTests = Number(equityRatio < 25) + Number(operatingCashFlow < 0) + Number(interestCoverage !== null && interestCoverage < 2) + Number(cashDebtCoverage !== null && cashDebtCoverage < 0.5);
  if (negativeTests >= 2) return band('financial_strength', 'moderate_negative', 'two_or_more_operating_finance_tests');
  if (equityRatio >= 50 && cashDebtCoverage !== null && cashDebtCoverage >= 1 && (currentDebtCoverage === null || currentDebtCoverage >= 2) && operatingCashFlow >= 0) {
    return band('financial_strength', 'strong_positive', 'high_equity_net_cash_liquidity_and_positive_cfo');
  }
  if (equityRatio >= 50 && cashDebtCoverage !== null && cashDebtCoverage >= 1 && (currentDebtCoverage === null || currentDebtCoverage >= 2)) {
    return band('financial_strength', 'moderate_positive', 'high_equity_net_cash_and_liquidity');
  }
  if (equityRatio >= 30 && operatingCashFlow >= 0 && (interestCoverage === null || interestCoverage >= 2)) {
    return band('financial_strength', 'neutral', 'adequate_equity_positive_cashflow_and_interest_cover');
  }
  return band('financial_strength', 'moderate_negative', 'one_or_more_financial_weaknesses_without_neutral_anchor');
}

function capitalStructure(facts) {
  const f = facts.observations.capital_structure;
  const issuedShares = numberOrNull(f.issued_shares, 'issued_shares');
  const potentialShares = numberOrNull(f.unexercised_potential_shares, 'unexercised_potential_shares');
  let scoreBand;
  let score;
  let bucket;

  if (issuedShares === null || issuedShares <= 0 || potentialShares === null) {
    scoreBand = 'neutral';
    score = BAND_POINTS.capital_structure.neutral;
    bucket = 'unknown_or_not_quantified';
  } else {
    const dilutionPct = (potentialShares / issuedShares) * 100;
    if (dilutionPct <= 5) {
      scoreBand = 'neutral';
      score = 5;
      bucket = '0_to_5pct';
    } else if (dilutionPct <= 10) {
      scoreBand = 'moderate_negative';
      score = 4;
      bucket = 'over_5_to_10pct';
    } else if (dilutionPct <= 20) {
      scoreBand = 'moderate_negative';
      score = 3;
      bucket = 'over_10_to_20pct';
    } else if (dilutionPct <= 30) {
      scoreBand = 'strong_negative';
      score = 2;
      bucket = 'over_20_to_30pct';
    } else {
      scoreBand = 'strong_negative';
      score = 1;
      bucket = 'over_30pct';
    }
    if (f.resettable_or_market_price_warrant) score = Math.max(0, score - 2);
  }

  return { band: scoreBand, score, reason_code: `potential_dilution_${bucket}`, dilution_bucket: bucket };
}

function governanceLegal(facts) {
  const governance = facts.observations.governance_legal;
  const issues = governance.issues;
  assert(Array.isArray(issues), 'governance_legal.issues must be an array');
  for (const issue of issues) assert(issueTypes.has(issue.type), `unknown governance issue type: ${issue.type}`);

  let strongest = null;
  if (governance.going_concern_disclosed === true) {
    strongest = band('governance_legal', 'strong_negative', 'issuer_discloses_going_concern_uncertainty');
  } else if (governance.listing_risk_disclosed === true) {
    strongest = band('governance_legal', 'moderate_negative', 'issuer_or_exchange_discloses_listing_risk');
  }
  for (const issue of issues) {
    if (issue.status === 'closed' || issue.status === 'fully_remediated') continue;
    let candidate = null;
    if (issue.type === 'lawsuit') {
      const claimPct = numberOrNull(issue.claim_pct_net_assets, 'claim_pct_net_assets');
      const provisionPct = numberOrNull(issue.provision_pct_claim, 'provision_pct_claim');
      if (claimPct !== null && claimPct >= 50 && provisionPct !== null && provisionPct < 50) {
        candidate = band('governance_legal', 'strong_negative', 'pending_claim_ge_50pct_net_assets_not_mostly_provisioned', { issue_id: issue.evidence_id });
      } else if (claimPct !== null && claimPct >= 50) {
        candidate = band('governance_legal', 'moderate_negative', 'large_pending_claim_with_provision_or_unreported_provision', { issue_id: issue.evidence_id });
      } else if (claimPct !== null && claimPct >= 10 && (provisionPct === null || provisionPct < 50)) {
        candidate = band('governance_legal', 'moderate_negative', 'pending_claim_ge_10pct_net_assets_not_mostly_provisioned', { issue_id: issue.evidence_id });
      }
    } else if (issue.type === 'accounting_issue' && issue.material === true) {
      candidate = band('governance_legal', issue.restated_or_qualified === true ? 'strong_negative' : 'moderate_negative', 'material_accounting_issue', { issue_id: issue.evidence_id });
    } else if (issue.type === 'disclosure_issue' && issue.formal_delay_or_correction === true) {
      candidate = band('governance_legal', issue.unresolved === true ? 'strong_negative' : 'moderate_negative', 'formal_disclosure_delay_or_material_correction', { issue_id: issue.evidence_id });
    } else if (issue.type === 'regulatory_issue' && issue.formal_action === true) {
      candidate = band('governance_legal', issue.material === true ? 'strong_negative' : 'moderate_negative', 'formal_regulatory_action', { issue_id: issue.evidence_id });
    } else if (issue.type === 'governance_issue' && issue.material === true) {
      candidate = band('governance_legal', 'moderate_negative', 'material_governance_issue', { issue_id: issue.evidence_id });
    }
    if (candidate && (!strongest || candidate.score < strongest.score)) strongest = candidate;
  }
  return strongest || band('governance_legal', 'neutral', 'no_material_unresolved_governance_or_legal_issue');
}

export function businessSessionsAfter(eventDate, asOfDate, holidays = []) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(eventDate), 'event date must be YYYY-MM-DD');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(asOfDate), 'as_of must be YYYY-MM-DD');
  assert(eventDate <= asOfDate, 'event date must not be after as_of');
  const holidaySet = new Set(holidays);
  let count = 0;
  const cursor = new Date(`${eventDate}T12:00:00Z`);
  const end = new Date(`${asOfDate}T12:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidaySet.has(iso)) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function catalystQuality(facts) {
  const f = facts.observations.catalyst_quality;
  const age = businessSessionsAfter(f.event_date, facts.as_of, facts.japan_holidays || []);
  let catalystStrength = 0;
  if (age <= 1) catalystStrength += 2;
  else if (age <= 5) catalystStrength += 1;
  else if (age > 20) catalystStrength -= 1;

  if (f.timing === 'within_5_business_days') catalystStrength += 2;
  else if (f.timing === 'date_known_after_5_business_days') catalystStrength += 1;
  else if (f.timing === 'unknown') catalystStrength -= 1;
  if (f.novelty === 'new') catalystStrength += 1;
  else if (f.novelty === 'repeated') catalystStrength -= 1;
  if (f.amount_clarity === 'exact') catalystStrength += 1;
  else if (f.amount_clarity === 'qualitative') catalystStrength -= 1;
  if (f.direct_near_term_business_link === true) catalystStrength += 1;
  else catalystStrength -= 1;

  let name = 'neutral';
  if (f.direction === 'positive') {
    if (catalystStrength >= 6) name = 'strong_positive';
    else if (catalystStrength >= 4) name = 'moderate_positive';
    else if (catalystStrength < 0) name = 'strong_negative';
    else if (catalystStrength < 2) name = 'moderate_negative';
  } else if (f.direction === 'negative') {
    if (catalystStrength >= 6) name = 'strong_negative';
    else if (catalystStrength >= 4) name = 'moderate_negative';
  }
  return { band: name, score: BAND_POINTS.catalyst_quality[name], reason_code: 'age_timing_novelty_amount_and_business_link_then_direction_band', catalyst_strength: catalystStrength, age_business_sessions: age };
}

function riskFlags(facts) {
  const flags = new Set();
  const capital = facts.observations.capital_structure;
  const issuedShares = capital.issued_shares;
  const potentialShares = capital.unexercised_potential_shares;
  if (issuedShares > 0 && potentialShares !== null && potentialShares / issuedShares > 0.05) flags.add('dilution');
  if (capital.resettable_or_market_price_warrant === true) flags.add('ms_warrant');

  const financial = facts.observations.financial_strength;
  const interestCoverage = financial.interest_coverage;
  if (financial.business_model === 'property_investment') {
    const propertyAssets = financial.property_asset_value_proxy;
    const propertyDebtProxy = propertyAssets > 0 ? financial.interest_bearing_debt / propertyAssets : null;
    if ((propertyDebtProxy !== null && propertyDebtProxy >= 0.85) || (interestCoverage !== null && interestCoverage < 1.2)) flags.add('debt_excess');
  } else if ((financial.interest_bearing_debt !== null && financial.net_assets > 0 && financial.interest_bearing_debt / financial.net_assets >= 2)
    || (interestCoverage !== null && interestCoverage < 1.2)) {
    flags.add('debt_excess');
  }
  if (financial.cash !== null && financial.debt_due_within_12_months > 0 && financial.cash / financial.debt_due_within_12_months < 0.5) flags.add('liquidity');

  const issues = facts.observations.governance_legal.issues;
  if (issues.some((x) => x.type === 'lawsuit' && x.status !== 'closed' && x.status !== 'fully_remediated')) flags.add('lawsuit');
  if (issues.some((x) => x.type === 'accounting_issue' && x.material === true && x.status !== 'closed' && x.status !== 'fully_remediated')) flags.add('accounting_issue');
  if (issues.some((x) => x.type === 'disclosure_issue' && x.formal_delay_or_correction === true && x.status !== 'fully_remediated')) flags.add('disclosure_issue');
  if (issues.some((x) => x.type === 'regulatory_issue' && x.formal_action === true && x.status !== 'closed')) flags.add('regulatory_issue');
  if (facts.observations.governance_legal.going_concern_disclosed === true) flags.add('going_concern');
  if (facts.observations.governance_legal.listing_risk_disclosed === true) flags.add('listing_risk');
  return [...flags].sort();
}

function confidence(facts) {
  const quality = facts.confidence_quality;
  let raw = 1;
  const deductions = [];
  for (const [key, amount] of Object.entries(CONFIDENCE_DEDUCTIONS)) {
    if (quality[key] === true) {
      raw -= amount;
      deductions.push({ reason: key, amount });
    }
  }
  const value = Math.max(0.5, Math.min(1, Math.round(raw * 20) / 20));
  return { base: 1, deductions, raw: +raw.toFixed(4), value };
}

function validateCase(facts) {
  assert(facts && typeof facts === 'object' && !Array.isArray(facts), 'case must be an object');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(facts.as_of), 'as_of must be YYYY-MM-DD');
  assert(/^\d{4}$/.test(facts.symbol), 'symbol must be a four-digit code');
  assert(typeof facts.alertId === 'string' && facts.alertId.trim().length > 0, 'alertId is required');
  assert(facts.observations && typeof facts.observations === 'object', 'observations are required');
  for (const component of COMPONENT_ORDER) {
    const entry = facts.observations[component];
    assert(entry && Array.isArray(entry.evidence_ids) && entry.evidence_ids.length > 0, `${component}.evidence_ids is required`);
  }
  assert(facts.observations.governance_legal.issues.every((issue) => typeof issue.evidence_id === 'string'), 'each governance issue must have an evidence_id');
  assert(facts.sources && facts.evidence, 'sources and evidence registries are required');
}

export function scoreFactsV2(facts) {
  validateCase(facts);
  const scoredComponents = {
    material_impact: materialImpact(facts),
    earnings_quality: earningsQuality(facts),
    growth_visibility: growthVisibility(facts),
    financial_strength: financialStrength(facts),
    capital_structure: capitalStructure(facts),
    governance_legal: governanceLegal(facts),
    catalyst_quality: catalystQuality(facts),
  };
  let total = 0;
  for (const [component, result] of Object.entries(scoredComponents)) {
    total += result.score;
    result.evidence_ids = facts.observations[component].evidence_ids;
  }
  const flags = riskFlags(facts);
  const confidenceResult = confidence(facts);
  const score = {
    alertId: facts.alertId,
    symbol: facts.symbol,
    as_of: facts.as_of,
    ...Object.fromEntries(COMPONENT_ORDER.map((component) => [component, scoredComponents[component].score])),
    fundamental_score: total,
    confidence: confidenceResult.value,
    risk_flags: flags,
    rationale: `Rubric V2 fixed bands: ${COMPONENT_ORDER.map((component) => `${component}=${scoredComponents[component].band}`).join('; ')}; evidence-linked and deterministic.`,
  };

  const evidenceAllocation = [];
  for (const component of COMPONENT_ORDER) {
    for (const evidenceId of scoredComponents[component].evidence_ids) {
      const evidence = facts.evidence[evidenceId];
      assert(evidence, `unknown evidence id: ${evidenceId}`);
      evidenceAllocation.push({
        evidence_id: evidenceId,
        applied_component: component,
        source_ids: evidence.source_ids,
        description: evidence.description,
      });
    }
  }
  const riskEvidence = {};
  const flagEvidenceComponent = {
    dilution: 'capital_structure',
    ms_warrant: 'capital_structure',
    debt_excess: 'financial_strength',
    liquidity: 'financial_strength',
    lawsuit: 'governance_legal',
    accounting_issue: 'governance_legal',
    disclosure_issue: 'governance_legal',
    regulatory_issue: 'governance_legal',
    going_concern: 'governance_legal',
    listing_risk: 'governance_legal',
  };
  for (const flag of flags) {
    const component = flagEvidenceComponent[flag];
    riskEvidence[flag] = facts.observations[component].evidence_ids;
  }

  const audit = {
    rubric_version: 2,
    symbol: facts.symbol,
    as_of: facts.as_of,
    components: scoredComponents,
    evidence_allocation: evidenceAllocation,
    risk_flag_evidence: riskEvidence,
    confidence: confidenceResult,
  };
  return { score, audit };
}
