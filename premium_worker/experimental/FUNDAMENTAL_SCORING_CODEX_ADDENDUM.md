# Fundamental Scoring Test Addendum

TEST BRANCH ONLY. Do not change the existing Discord report format, production schedule, GAS, alerts_raw, or production state.

After completing the existing premium fundamental research and writing `premium_worker/out/premium_reports.json`, generate a separate machine-readable sidecar file:

`premium_worker/out/premium_fundamental_scores.json`

Do NOT add score fields to the Discord report JSON and do NOT alter the existing seven report fields. The sidecar exists only for research.

For every successfully researched alert, write one score record with:

- `alertId`: exact alert ID from the claim/report
- `symbol`: 4-digit security code
- `as_of`: report knowledge cutoff date, YYYY-MM-DD
- `material_impact`: integer 0..20
- `earnings_quality`: integer 0..20
- `growth_visibility`: integer 0..15
- `financial_strength`: integer 0..15
- `capital_structure`: integer 0..10
- `governance_legal`: integer 0..10
- `catalyst_quality`: integer 0..10
- `fundamental_score`: exact sum of the seven component scores, 0..100
- `confidence`: number 0..1
- `risk_flags`: zero or more of `dilution`, `ms_warrant`, `going_concern`, `debt_excess`, `liquidity`, `lawsuit`, `regulatory`, `listing_risk`, `accounting_issue`
- `rationale`: concise Japanese explanation grounded only in the same verified sources used for the report

Scoring principle: this is a short-horizon research overlay for post-signal 5-business-day performance, not a generic long-term company-quality rating. Use only information available from verified sources at the report's knowledge cutoff. Do not invent missing figures. A low confidence score is preferable to unsupported precision.

## Orthogonal component rubric

Avoid double-counting the same fact across several components. Each component has a distinct job:

- `material_impact` (0..20): net near-term directional impact of the newest material disclosures on the next several trading days. This is event impact, not balance-sheet quality.
- `earnings_quality` (0..20): recurring operating earnings quality, margins, progress vs guidance, and whether profits are driven by one-off gains/losses. Do not penalize legal/dilution risk here unless it directly changes reported earnings.
- `growth_visibility` (0..15): visibility of future revenue/profit from orders, backlog, recurring revenue, utilization, customer growth, contracted projects, or quantified guidance. Announcements with no amount/timing should score cautiously.
- `financial_strength` (0..15): liquidity, cash flow, leverage, equity buffer, and ability to absorb adverse events. Lawsuit size may matter here only through demonstrated balance-sheet/liquidity capacity, not because a lawsuit exists.
- `capital_structure` (0..10): dilution, warrants/CBs, equity issuance, buybacks, share count pressure, and financing structure. Do not use this field as a second general financial-health score.
- `governance_legal` (0..10): lawsuits, regulatory actions, accounting issues, governance/control problems, listing risk, and related uncertainty. Higher is safer/cleaner.
- `catalyst_quality` (0..10): freshness, specificity, surprise, timing, and tradability of the catalyst. Do not simply repeat `material_impact`; a positive but already-known/fully-priced event can have high impact on fundamentals but low catalyst quality.

When one fact touches multiple dimensions, score the primary economic channel strongly and secondary channels only when there is an independently justified effect. Example: a large lawsuit can reduce `governance_legal`; it should reduce `financial_strength` only if the potential exposure is material relative to cash/equity or creates financing risk. Do not reduce `material_impact`, `financial_strength`, and `governance_legal` all by large amounts for the same headline unless each reduction has a separately stated reason.

`risk_flags` are descriptive tags, not extra hidden penalties. Do not subtract points merely because a flag exists; the relevant component score should already reflect the risk.

## Stability test

For every test batch of 3 or more alerts, independently re-score at least one alert a second time after re-reading the same source set. Do not look at the first numeric component scores while producing the second pass.

Write the repeat result to:

`premium_worker/out/test_fundamental_rescore.json`

with the same score schema plus:

- `pass`: 2
- `original_alert_id`: the alert ID being repeated

Then compare pass 1 vs pass 2 and report:

- total-score absolute difference
- per-component absolute differences
- whether any risk flag changed

Interpretation for this experiment:

- total difference 0..3: strong numeric stability
- 4..7: usable only with tighter rubric/calibration
- 8 or more: too unstable for automated ranking until the rubric is revised

Do not tune component definitions or weights based on the 5BD outcome of the test company. Stability testing is about reproducibility, not return optimization.

Important research constraints:

1. Preserve the existing Discord prose and posting path exactly.
2. Scores must be saved only to the sidecar file.
3. Do not use the score to suppress, reorder, or modify Discord posts during the experiment.
4. Do not write the score to GAS or `alerts_raw`.
5. Do not alter the current technical score or production ranking.
6. Core/Monster blending remains disabled in production. The sidecar is observation-only until historical validation demonstrates improvement.
7. Run `node premium_worker/experimental/validate_fundamental_scores_v1.mjs premium_worker/out/premium_fundamental_scores.json` before the normal final dry-run. Repair every validator error before continuing.
8. For a test batch, do not declare scoring stability validated unless the independent second-pass rescore file exists and the score difference has been reported.
