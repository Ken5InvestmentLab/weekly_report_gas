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

Important research constraints:

1. Preserve the existing Discord prose and posting path exactly.
2. Scores must be saved only to the sidecar file.
3. Do not use the score to suppress, reorder, or modify Discord posts during the experiment.
4. Do not write the score to GAS or `alerts_raw`.
5. Do not alter the current technical score or production ranking.
6. Core/Monster blending remains disabled in production. The sidecar is observation-only until historical validation demonstrates improvement.
7. Run `node premium_worker/experimental/validate_fundamental_scores_v1.mjs premium_worker/out/premium_fundamental_scores.json` before the normal final dry-run. Repair every validator error before continuing.
