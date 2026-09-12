import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { businessSessionsAfter, scoreFactsV2 } from './fundamental_scoring_v2.mjs';

const fixturePath = path.resolve('premium_worker/experimental/fixtures/fundamental_scoring_v2_asof_2026-09-11.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const bySymbol = Object.fromEntries(fixture.cases.map((item) => [item.symbol, item]));
const calculate = (symbol, transform = (value) => value) => {
  const base = structuredClone(bySymbol[symbol]);
  const changed = transform(base) || base;
  return scoreFactsV2({ ...changed, sources: fixture.sources, japan_holidays: fixture.japan_holidays });
};

for (const record of fixture.cases) {
  const first = scoreFactsV2({ ...record, sources: fixture.sources, japan_holidays: fixture.japan_holidays });
  const second = scoreFactsV2({ ...record, sources: fixture.sources, japan_holidays: fixture.japan_holidays });
  assert.deepEqual(first, second, `${record.symbol} must be deterministic`);
  assert.equal(first.score.fundamental_score, Object.entries(first.score).filter(([key]) => ['material_impact', 'earnings_quality', 'growth_visibility', 'financial_strength', 'capital_structure', 'governance_legal', 'catalyst_quality'].includes(key)).reduce((sum, [, value]) => sum + value, 0));
  assert.equal(new Set(first.audit.evidence_allocation.map((item) => item.evidence_id)).size, first.audit.evidence_allocation.length, 'evidence must have one scoring component');
}

assert.equal(businessSessionsAfter('2026-08-03', '2026-09-11', ['2026-08-11']), 28);
assert.equal(businessSessionsAfter('2026-09-10', '2026-09-11', ['2026-08-11']), 1);
assert.equal(businessSessionsAfter('2026-09-11', '2026-09-11', ['2026-08-11']), 0);

const materialUp = calculate('7211', (facts) => {
  facts.observations.material_impact.forecast_revision = 'up';
  facts.observations.material_impact.forecast_operating_profit_change_pct = 20;
  return facts;
});
assert.equal(materialUp.audit.components.material_impact.band, 'strong_positive');
assert.equal(materialUp.score.material_impact, 18);

const contractAlreadyGuided = calculate('7211', (facts) => {
  facts.observations.material_impact.unforecast_contract_pct_annual_revenue = 50;
  facts.observations.material_impact.contract_already_in_guidance = true;
  return facts;
});
assert.equal(contractAlreadyGuided.audit.components.material_impact.band, 'neutral');

const dilutionBoundaries = [
  [5, 5], [5.01, 4], [10, 4], [10.01, 3], [20, 3], [20.01, 2], [30, 2], [30.01, 1],
];
for (const [pct, expected] of dilutionBoundaries) {
  const result = calculate('7211', (facts) => {
    facts.observations.capital_structure.issued_shares = 10000;
    facts.observations.capital_structure.unexercised_potential_shares = pct * 100;
    facts.confidence_quality.capital_terms_incomplete = false;
    return facts;
  });
  assert.equal(result.score.capital_structure, expected, `dilution ${pct}% anchor`);
  assert.equal(result.score.risk_flags.includes('dilution'), pct > 5, `dilution flag threshold ${pct}%`);
}

const fixedWarrant = calculate('7211', (facts) => {
  facts.observations.capital_structure.issued_shares = 10000;
  facts.observations.capital_structure.unexercised_potential_shares = 1500;
  facts.observations.capital_structure.resettable_or_market_price_warrant = false;
  return facts;
});
const resettableWarrant = calculate('7211', (facts) => {
  facts.observations.capital_structure.issued_shares = 10000;
  facts.observations.capital_structure.unexercised_potential_shares = 1500;
  facts.observations.capital_structure.resettable_or_market_price_warrant = true;
  return facts;
});
assert.equal(fixedWarrant.score.capital_structure, 3);
assert.equal(resettableWarrant.score.capital_structure, 1);
assert.ok(resettableWarrant.score.risk_flags.includes('ms_warrant'));

const newOnlyCatalyst = calculate('7211', (facts) => {
  facts.observations.catalyst_quality.event_date = '2026-08-03';
  facts.observations.catalyst_quality.timing = 'unknown';
  facts.observations.catalyst_quality.novelty = 'new';
  facts.observations.catalyst_quality.amount_clarity = 'qualitative';
  facts.observations.catalyst_quality.direction = 'positive';
  facts.observations.catalyst_quality.direct_near_term_business_link = false;
  return facts;
});
assert.equal(newOnlyCatalyst.score.catalyst_quality, 1, 'novelty alone must not create a high catalyst score');
const strongNearTermCatalyst = calculate('7211', (facts) => {
  facts.observations.catalyst_quality.event_date = '2026-09-11';
  facts.observations.catalyst_quality.timing = 'within_5_business_days';
  facts.observations.catalyst_quality.novelty = 'new';
  facts.observations.catalyst_quality.amount_clarity = 'exact';
  facts.observations.catalyst_quality.direction = 'positive';
  facts.observations.catalyst_quality.direct_near_term_business_link = true;
  return facts;
});
assert.equal(strongNearTermCatalyst.score.catalyst_quality, 9);

const lawsuitImpact = calculate('6696');
const lawsuitRemoved = calculate('6696', (facts) => {
  facts.observations.governance_legal.issues = [];
  return facts;
});
assert.equal(lawsuitImpact.score.governance_legal, 3);
assert.equal(lawsuitRemoved.score.governance_legal, 5);
assert.equal(lawsuitImpact.score.material_impact, lawsuitRemoved.score.material_impact, 'lawsuit must not be deducted in material_impact');
assert.equal(lawsuitImpact.score.catalyst_quality, lawsuitRemoved.score.catalyst_quality, 'lawsuit must not be deducted in catalyst_quality');
assert.ok(lawsuitImpact.score.risk_flags.includes('lawsuit'));
assert.ok(!lawsuitRemoved.score.risk_flags.includes('lawsuit'));
const quantifiedUnprovisionedSuit = calculate('6696', (facts) => {
  facts.observations.governance_legal.issues[0].provision_pct_claim = 0;
  return facts;
});
assert.equal(quantifiedUnprovisionedSuit.score.governance_legal, 1);

for (const [issue, expectedFlag] of [
  [{ type: 'accounting_issue', status: 'pending', material: true, restated_or_qualified: true, evidence_id: '7211_governance_observation' }, 'accounting_issue'],
  [{ type: 'disclosure_issue', status: 'pending', formal_delay_or_correction: true, unresolved: true, evidence_id: '7211_governance_observation' }, 'disclosure_issue'],
  [{ type: 'regulatory_issue', status: 'pending', formal_action: true, material: true, evidence_id: '7211_governance_observation' }, 'regulatory_issue'],
]) {
  const result = calculate('7211', (facts) => {
    facts.observations.governance_legal.issues = [issue];
    return facts;
  });
  assert.ok(result.score.risk_flags.includes(expectedFlag));
  assert.ok(result.audit.risk_flag_evidence[expectedFlag]);
}
const explicitGoingConcern = calculate('7211', (facts) => {
  facts.observations.governance_legal.going_concern_disclosed = true;
  return facts;
});
assert.equal(explicitGoingConcern.score.governance_legal, 1);
assert.ok(explicitGoingConcern.score.risk_flags.includes('going_concern'));
const explicitListingRisk = calculate('7211', (facts) => {
  facts.observations.governance_legal.listing_risk_disclosed = true;
  return facts;
});
assert.equal(explicitListingRisk.score.governance_legal, 3);
assert.ok(explicitListingRisk.score.risk_flags.includes('listing_risk'));

const noBalanceSheetChange = calculate('3121', (facts) => {
  facts.observations.governance_legal.issues = [{ type: 'lawsuit', evidence_id: '3121_governance_observation', status: 'pending', claim_pct_net_assets: 60, provision_pct_claim: null }];
  return facts;
});
const noIssue = calculate('3121');
assert.equal(noBalanceSheetChange.score.governance_legal, 3);
assert.ok(!noIssue.score.risk_flags.includes('debt_excess'), 'property leverage must use the explicit asset/interest proxy, not gross debt alone');
const propertyAssetDebtFlag = calculate('3121', (facts) => {
  facts.observations.financial_strength.property_asset_value_proxy = 11000;
  return facts;
});
assert.ok(propertyAssetDebtFlag.score.risk_flags.includes('debt_excess'), 'property asset debt proxy at or above 85% flags debt excess');
const operatingDebtFlag = calculate('7211', (facts) => {
  facts.observations.financial_strength.interest_bearing_debt = facts.observations.financial_strength.net_assets * 2;
  return facts;
});
assert.ok(operatingDebtFlag.score.risk_flags.includes('debt_excess'));
assert.ok(noIssue.score.risk_flags.includes('liquidity'));
assert.equal(noBalanceSheetChange.score.material_impact, noIssue.score.material_impact);
assert.equal(noBalanceSheetChange.score.financial_strength, noIssue.score.financial_strength);

const confidenceChanged = calculate('3121', (facts) => {
  facts.confidence_quality.legal_outcome_unresolved = true;
  return facts;
});
assert.equal(confidenceChanged.score.confidence, noIssue.score.confidence - 0.1);

console.log(JSON.stringify({
  status: 'PASS',
  cases: fixture.cases.length,
  dilution_bucket_boundaries_tested: dilutionBoundaries.length,
  coverage: ['band anchors', 'material inclusion/thresholds', 'catalyst freshness/direction', 'dilution and warrant type', 'lawsuit thresholds/provision uncertainty', 'accounting/disclosure/regulatory/go-concern/listing flags', 'property-specific debt proxy', 'liquidity', 'confidence deductions', 'evidence allocation', 'same-fact deterministic output'],
}, null, 2));
